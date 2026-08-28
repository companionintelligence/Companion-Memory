import Foundation
import Security

/// Seals **leftover** `capacitor-secure-storage-plugin` Keychain items so they stop being
/// backup-migratory, for the short life of an install that has not yet migrated to the
/// Local Hub plugin's `CompanionSecureStore`.
///
/// ## The defect this covers
///
/// That plugin — retired in favor of `CompanionSecureStore`, but still the writer on any
/// build predating that move — hard-codes `kSecAttrAccessibleAfterFirstUnlock`:
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
/// ## Why this is a sweep rather than a one-line change to the pod
///
/// `SwiftKeychainWrapper.update` puts `kSecAttrAccessible` in the **query** dictionary,
/// where it acts as a *match constraint* rather than a change — so simply asking that
/// plugin to write `…ThisDeviceOnly` would fail to match any item already stored as
/// `…AfterFirstUnlock`, `SecItemUpdate` would return `errSecItemNotFound`, and `set()`
/// would start returning `false` for exactly the users who already have a key. Saving
/// credentials would break on upgrade. `SecItemUpdate` *does* accept `kSecAttrAccessible`
/// in the attributes-to-update dictionary, which is what this file uses — matching on
/// service+account only.
///
/// ## Why this is now a one-time migration, not a recurring sweep
///
/// Credential writes now go through the Local Hub plugin's `CompanionSecureStore`, which
/// writes `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` in the first place. Nothing in
/// the app writes to `cap_sec` any more, so the mid-session re-sweep this type used to run
/// from `sceneDidEnterBackground` has nothing left to catch and has been removed.
///
/// What remains is genuinely a migration, and it is not dead code: on an install upgrading
/// *from* a build that still wrote through the legacy plugin, the old `cap_sec` items are
/// still on disk with the weaker class until the JS layer's `secureStorageGet` migration
/// copies them across and deletes them (see `CompanionConfig`). This closes that window at
/// launch, before any of it is reachable.
///
/// Delete this type once a release that writes only through `CompanionSecureStore` is far
/// enough back that no un-migrated install is still in the field — along with the legacy
/// branch in `CompanionConfig`.
enum KeychainHardening {
    /// The service name `capacitor-secure-storage-plugin` files everything under
    /// (`KeychainWrapper(serviceName: "cap_sec")`). Kept in sync with
    /// `CompanionConfig.legacyKeychainService`.
    private static let keychainService = "cap_sec"

    /// The class every value written by that plugin uses.
    private static let target = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly

    /// Upgrades every leftover `cap_sec` item that is not already device-only.
    ///
    /// Safe to call repeatedly and from any thread: it is a pure Keychain operation with no
    /// shared state, and items already at the target class are skipped. Returns the number
    /// of items it changed — `0` on a fresh install, and `0` on every launch after the JS
    /// migration has emptied the legacy store.
    @discardableResult
    static func migrateLegacyCredentials() -> Int {
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
