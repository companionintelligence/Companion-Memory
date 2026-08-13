import Foundation

/// Shared configuration the native App Intents need to reach the CI-Server, read
/// straight from the Keychain that the web app already writes to.
///
/// The Capacitor app authenticates with a long-lived API key minted after login and
/// stores it through `@ci/common`'s `secureStorage*` helpers. The web app additionally
/// mirrors the configured server origin into the same store (`ci.apiBaseUrl`) precisely
/// so cookie-/WebView-less native code — like an App Intent running outside the webview
/// — can read it here. No App Group or extra plugin is required: both values live in the
/// app's default Keychain.
///
/// ## Two services, in this order
///
/// Slice S0 moved those writes off `capacitor-secure-storage-plugin` and onto the Local
/// Hub plugin's `CompanionSecureStore`, which uses its own service name and — the point of
/// the slice — `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`. The JS migration copies
/// each value across on first read **and deletes the legacy copy**, so reading only the old
/// service (as this type did until now) finds nothing on any migrated install and every
/// intent fails with `.notConfigured`. Both services are therefore consulted, current
/// first.
///
/// The legacy fallback is not dead code: it covers the window on an upgraded install
/// between launch and the first `secureStorageGet` that performs the migration. It can be
/// deleted once a release that includes S0 is far enough back that no un-migrated install
/// is still in the field.
enum CompanionConfig {
    /// Service used by `CompanionSecureStore` (Local Hub plugin). Kept in sync with
    /// `CompanionSecureStore.credentialsService` — the app target cannot import it, since
    /// that type is internal to the pod's module.
    private static let keychainService = "com.companionintelligence.localhub.credentials"

    /// Service used by the retired `capacitor-secure-storage-plugin`, read only so an
    /// install that has not yet run the JS migration still works. See the type docs.
    private static let legacyKeychainService = "cap_sec"

    /// Storage keys, kept in sync with `@ci/common` (`apiAuth.ts` / `apiBase.ts`) and
    /// `useAuth.ts`.
    private static let apiKeyAccount = "ci.apiKey"
    private static let baseUrlAccount = "ci.apiBaseUrl"

    /// The configured server origin (e.g. `https://ci-server.example.com`), or nil if
    /// the user hasn't completed the in-app `/server` setup yet.
    static var baseUrl: URL? {
        guard let raw = keychainString(forKey: baseUrlAccount)?.trimmingCharacters(in: .whitespacesAndNewlines),
              !raw.isEmpty else {
            return nil
        }

        return URL(string: raw)
    }

    /// The long-lived API key, or nil if the user isn't signed in.
    static var apiKey: String? {
        guard let key = keychainString(forKey: apiKeyAccount), !key.isEmpty else {
            return nil
        }

        return key
    }

    /// Whether there is enough configuration to make an authenticated API call.
    static var isReady: Bool {
        baseUrl != nil && apiKey != nil
    }

    /// Current store first, then the legacy one. Only a genuine miss falls through: any
    /// other `OSStatus` (an unusable Keychain, say) returns nil from `read` and is not
    /// distinguished here, because every caller's recovery is identical — tell the user to
    /// open the app and finish setup.
    private static func keychainString(forKey account: String) -> String? {
        read(account: account, service: keychainService, dataProtection: true)
            ?? read(account: account, service: legacyKeychainService, dataProtection: false)
    }

    /// - Parameter dataProtection: mirrors how the value was written. `CompanionSecureStore`
    ///   sets `kSecUseDataProtectionKeychain`, so its reads must too; the legacy plugin did
    ///   not. Setting it on a lookup for an item written without it is a well-known way to
    ///   make reads miss for no visible reason.
    private static func read(account: String, service: String, dataProtection: Bool) -> String? {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]

        if dataProtection {
            query[kSecUseDataProtectionKeychain as String] = true
        }

        var item: AnyObject?
        let status = SecItemCopyMatching(query as CFDictionary, &item)

        guard status == errSecSuccess, let data = item as? Data else {
            return nil
        }

        return String(data: data, encoding: .utf8)
    }
}

/// Errors surfaced to Siri/Shortcuts when an intent can't run.
enum CompanionIntentError: LocalizedError {
    case notConfigured
    case notSignedIn
    case requestFailed(String)

    var errorDescription: String? {
        switch self {
        case .notConfigured:
            return "Open Companion and set your server address first."
        case .notSignedIn:
            return "Sign in to Companion first, then try again."
        case let .requestFailed(message):
            return message
        }
    }
}
