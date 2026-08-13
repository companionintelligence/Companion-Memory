import Foundation
import Security

/// Failures from [CompanionSecureStore]. Kept distinct from "no value" on purpose: the caller
/// has to be able to tell "you were never signed in" from "the thing that held your credential
/// is unreachable", because only the first one is a normal state.
enum CompanionSecureStoreError: LocalizedError {
    /// The Keychain refused the operation. `status` is the raw `OSStatus`.
    case keychainFailed(String, OSStatus)
    /// An item exists but its bytes are not the UTF-8 string that was stored.
    case corruptValue(String)

    var errorDescription: String? {
        switch self {
        case let .keychainFailed(key, status):
            let message = SecCopyErrorMessageString(status, nil) as String? ?? "OSStatus \(status)"
            return "Keychain operation for '\(key)' failed: \(message)"
        case let .corruptValue(key):
            return "The stored value for '\(key)' is not readable as text"
        }
    }
}

/// Keychain-backed store for the few secrets this app keeps on the device: the long-lived
/// appliance API key, and the raw key the SQLCipher outbox is encrypted with.
///
/// ### Why this exists rather than `capacitor-secure-storage-plugin`
///
/// That plugin -- which holds the appliance API key today -- writes with
/// `withAccessibility: .afterFirstUnlock`, i.e. `kSecAttrAccessibleAfterFirstUnlock` **without**
/// `…ThisDeviceOnly`. Items in that class are *included in encrypted iTunes/Finder backups and
/// restore onto new hardware*, so the app's long-lived, non-expiring appliance credential
/// silently migrates with a backup -- no re-authentication, and no device record on the server
/// ever learns about it. Android's half of that problem is covered by `allowBackup="false"`;
/// iOS has no equivalent lever for a keychain item in that class, so the fix has to be the
/// accessibility constant itself.
///
/// ### The two attributes that carry the whole design
///
/// - **`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`.** Both halves matter.
///   `ThisDeviceOnly` excludes the item from iCloud Keychain *and* from encrypted device
///   backups, so a restored backup yields an app with no credential and an outbox database that
///   cannot be opened -- which is the correct outcome, not a bug: the new phone re-authenticates
///   and re-syncs from the user's own appliance. `AfterFirstUnlock` rather than `WhenUnlocked`
///   because the sidecar must be able to read the key while the screen is locked (a background
///   flush, a background location callback); `WhenUnlocked` fails those with
///   `errSecInteractionNotAllowed`, and the failure mode is invisible -- captures simply stop
///   queueing whenever the phone is in a pocket.
/// - **`kSecUseDataProtectionKeychain = true`.** Opts into the modern, app-container-scoped
///   keychain rather than the legacy file-based one, which is what makes the accessibility
///   class behave as documented on all current OS versions.
///
/// No biometric `SecAccessControl` is attached, deliberately. Gating this item behind Face ID
/// would make it unusable from background work, which is the same reason the Android side does
/// not set `setUserAuthenticationRequired`. App-lock is a *presentation* gate over the WebView
/// and is a separate control from this one.
///
/// **Unverified.** Like the rest of this directory, none of this has been compiled or run --
/// there is no Mac in the environment it was written in. See `README.md`.
final class CompanionSecureStore {
    /// Namespace holding the appliance credential (`ci.apiKey`, `ci.apiKeyId`, `ci.apiBaseUrl`).
    static let credentialsService = "com.companionintelligence.localhub.credentials"

    /// Namespace holding the outbox database key. Separate from the credential namespace so the
    /// two can be destroyed independently -- deleting this one crypto-shreds the database
    /// without signing the user out, and vice versa.
    static let outboxService = "com.companionintelligence.localhub.outbox-keys"

    private let service: String

    init(service: String) {
        self.service = service
    }

    static func credentials() -> CompanionSecureStore {
        CompanionSecureStore(service: credentialsService)
    }

    static func outboxKeys() -> CompanionSecureStore {
        CompanionSecureStore(service: outboxService)
    }

    /// Decrypted value, or `nil` when nothing is stored under `key`. Throws when the Keychain
    /// itself refuses -- never silently reports "no value" for an error.
    func get(_ key: String) throws -> String? {
        var query = baseQuery(for: key)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var item: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &item)

        if status == errSecItemNotFound {
            return nil
        }
        guard status == errSecSuccess else {
            throw CompanionSecureStoreError.keychainFailed(key, status)
        }
        guard let data = item as? Data, let value = String(data: data, encoding: .utf8) else {
            throw CompanionSecureStoreError.corruptValue(key)
        }
        return value
    }

    /// Stores `value`, replacing any existing item under `key`.
    ///
    /// `SecItemAdd` first, then `SecItemUpdate` on `errSecDuplicateItem` -- rather than
    /// delete-then-add, which has a window where the credential exists nowhere at all. Losing it
    /// forces a full re-login against an appliance URL the user may no longer remember, so the
    /// ordering deliberately favours "briefly two copies" over "briefly none".
    func set(_ key: String, _ value: String) throws {
        guard let data = value.data(using: .utf8) else {
            throw CompanionSecureStoreError.corruptValue(key)
        }

        var attributes = baseQuery(for: key)
        attributes[kSecValueData as String] = data
        attributes[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly

        let addStatus = SecItemAdd(attributes as CFDictionary, nil)
        if addStatus == errSecSuccess {
            return
        }
        guard addStatus == errSecDuplicateItem else {
            throw CompanionSecureStoreError.keychainFailed(key, addStatus)
        }

        // The accessibility class is re-asserted on update so an item written by an older build
        // (with the weaker `kSecAttrAccessibleAfterFirstUnlock`) is corrected in place the first
        // time it is rewritten, rather than keeping its original, backup-eligible class forever.
        let updates: [String: Any] = [
            kSecValueData as String: data,
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        ]
        let updateStatus = SecItemUpdate(baseQuery(for: key) as CFDictionary, updates as CFDictionary)
        guard updateStatus == errSecSuccess else {
            throw CompanionSecureStoreError.keychainFailed(key, updateStatus)
        }
    }

    /// Removes one value. Succeeds silently when it was already absent.
    func remove(_ key: String) throws {
        let status = SecItemDelete(baseQuery(for: key) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw CompanionSecureStoreError.keychainFailed(key, status)
        }
    }

    /// Removes every item in this namespace -- the crypto-shred primitive for the outbox
    /// namespace, and the sign-out primitive for the credential one. Not wired to a caller yet;
    /// it is what the remote-wipe slice will invoke.
    func destroyAll() throws {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service
        ]
        query[kSecUseDataProtectionKeychain as String] = true

        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw CompanionSecureStoreError.keychainFailed("*", status)
        }
    }

    private func baseQuery(for key: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            // Scopes the lookup to the modern data-protection keychain, matching how the item
            // was written. Omitting it here while setting it on write is a classic way to make
            // reads mysteriously miss.
            kSecUseDataProtectionKeychain as String: true
        ]
    }
}

/// Supplies the raw 32-byte key the outbox database is encrypted with, held in the Keychain by
/// `CompanionSecureStore`. The iOS counterpart of `OutboxDatabaseKey.kt`.
///
/// **Raw key, not a passphrase**: handed to SQLCipher as `x'<64 hex chars>'` so PBKDF2 is
/// skipped entirely. There is no passphrase anywhere in this design -- native auth is an API
/// key, not something the user types at launch -- so stretching 256 bits of CSPRNG output would
/// buy nothing and cost milliseconds on the critical path of every cold start.
enum OutboxDatabaseKey {
    static let entryName = "outbox.dek.v1"

    /// The key is gone but the encrypted database is still on disk, so its contents -- captures
    /// that have never reached any server -- are unrecoverable. Reported rather than papered
    /// over with a freshly generated key, which would surface as generic file corruption and
    /// hide the fact that user data was lost.
    struct KeyLostError: LocalizedError {
        let databaseURL: URL
        var errorDescription: String? {
            "The outbox database key is missing, but \(databaseURL.lastPathComponent) exists and "
                + "can only be read with it. Those queued captures are unrecoverable."
        }
    }

    /// The `x'…'` key spec for `databaseURL`, generating and persisting a fresh key on first
    /// run. `databaseURL` is consulted only to tell "first run" apart from "the key vanished out
    /// from under an existing database" -- one code path, two very different events.
    static func rawKeySpec(
        for databaseURL: URL,
        store: CompanionSecureStore = CompanionSecureStore.outboxKeys()
    ) throws -> String {
        if let existing = try store.get(entryName) {
            return "x'\(existing)'"
        }

        if FileManager.default.fileExists(atPath: databaseURL.path) {
            let size = (try? FileManager.default.attributesOfItem(atPath: databaseURL.path)[.size] as? Int) ?? nil
            if (size ?? 1) > 0 {
                throw KeyLostError(databaseURL: databaseURL)
            }
        }

        var bytes = [UInt8](repeating: 0, count: 32)
        let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        guard status == errSecSuccess else {
            throw CompanionSecureStoreError.keychainFailed(entryName, status)
        }
        let hex = bytes.map { String(format: "%02x", $0) }.joined()
        try store.set(entryName, hex)

        // Read back before anything is encrypted with it: a write that reported success but did
        // not survive would leave the next launch generating a *different* key against a
        // database it can no longer open -- the same loss, discovered one launch too late.
        guard let persisted = try store.get(entryName), persisted == hex else {
            throw KeyLostError(databaseURL: databaseURL)
        }
        return "x'\(hex)'"
    }
}
