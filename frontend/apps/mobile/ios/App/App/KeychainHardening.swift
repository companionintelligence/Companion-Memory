import Foundation
import Security

/// Re-writes the app's Keychain items so they stop being **backup-migratory**.
///
/// ## The defect this fixes
///
/// The appliance API key and server URL are written by `capacitor-secure-storage-plugin`,
/// which hard-codes `kSecAttrAccessibleAfterFirstUnlock`:
///
/// ```swift
/// // node_modules/capacitor-secure-storage-plugin/ios/Plugin/SecureStoragePluginPlugin.swift
/// keychainwrapper.set(value, forKey: key, withAccessibility: .afterFirstUnlock)
/// ```
///
/// Everything about that is fine *except* the missing `ThisDeviceOnly`. Accessibility
/// classes without that suffix are **included in encrypted device backups and restore onto
/// different hardware**. So a user's long-lived credential for their own appliance rides
/// along in an iCloud/Finder backup and silently lands on whatever device that backup is
/// restored to — a device they may no longer own. `…ThisDeviceOnly` is the identical
/// unlock behaviour minus the migration: the item is sealed to this device's hardware key
/// and simply does not come back on another one.
///
/// ## Why this is a sweep rather than a one-line change
///
/// The write happens in a third-party pod, and correcting it there is not the one-liner it
/// looks like. `SwiftKeychainWrapper.update` puts `kSecAttrAccessible` in the **query**
/// dictionary, where it acts as a *match constraint* rather than a change — so simply
/// asking that plugin to write `…ThisDeviceOnly` would fail to match any item already
/// stored as `…AfterFirstUnlock`, `SecItemUpdate` would return `errSecItemNotFound`, and
/// `set()` would start returning `false` for exactly the users who already have a key.
/// Saving credentials would break on upgrade.
///
/// `SecItemUpdate` *does* accept `kSecAttrAccessible` in the attributes-to-update
/// dictionary, which is what this file uses — matching on service+account only, and
/// changing the accessibility in place. That works regardless of what the item currently
/// has, and it needs no cooperation from the pod.
///
/// ## When it runs, and the window that remains
///
/// `AppDelegate` runs it at launch and again on entering the background. Those two points
/// are chosen deliberately: a write performed by the web layer mid-session is hardened
/// before the app stops being foregrounded, and a device backup realistically happens
/// while the device is idle/locked/charging — i.e. after that. The residual window is a
/// write followed by a backup with no intervening background transition, which is not a
/// sequence iOS produces on its own.
///
/// This remains a mitigation layered on top of a wrong write, not a correct write. The
/// durable fix is upstream: a patched or replaced secure-storage plugin that stores
/// `…ThisDeviceOnly` in the first place. Tracked as slice S0 in `SECURITY_ARCHITECTURE.md`.
enum KeychainHardening {
    /// The service name `capacitor-secure-storage-plugin` files everything under
    /// (`KeychainWrapper(serviceName: "cap_sec")`). Kept in sync with `CompanionConfig`.
    private static let keychainService = "cap_sec"

    /// The class every value written by that plugin uses.
    private static let target = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly

    /// Upgrades every `cap_sec` item that is not already device-only.
    ///
    /// Safe to call repeatedly and from any thread: it is a pure Keychain operation with no
    /// shared state, and items already at the target class are skipped. Returns the number
    /// of items it changed, which is `0` on a fresh install and on every call after the
    /// first — a non-zero value on a later launch means something wrote a migratory item in
    /// the meantime.
    @discardableResult
    static func hardenStoredCredentials() -> Int {
        // kSecReturnAttributes (not kSecReturnData): the values are the user's credentials
        // and this code has no business reading them — it only needs each item's identity
        // and its current accessibility.
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: keychainService,
            kSecReturnAttributes as String: true,
            kSecMatchLimit as String: kSecMatchLimitAll
        ]

        var result: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        guard status == errSecSuccess, let items = result as? [[String: Any]] else {
            // errSecItemNotFound is the normal fresh-install case, not a failure.
            return 0
        }

        var upgraded = 0
        for item in items {
            guard let account = item[kSecAttrAccount as String] as? String else { continue }

            // Already sealed to this device -- nothing to do.
            if let accessible = item[kSecAttrAccessible as String] {
                if CFEqual(accessible as CFTypeRef, target) { continue }
            }

            let itemQuery: [String: Any] = [
                kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: keychainService,
                kSecAttrAccount as String: account
            ]
            // kSecAttrAccessible belongs HERE, in the attributes being changed. Putting it
            // in itemQuery above would turn it into a match constraint and the update would
            // find nothing -- the exact trap described in this type's doc comment.
            let changes: [String: Any] = [kSecAttrAccessible as String: target]

            if SecItemUpdate(itemQuery as CFDictionary, changes as CFDictionary) == errSecSuccess {
                upgraded += 1
            }
        }
        return upgraded
    }
}
