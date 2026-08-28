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
/// Credentials are written by the Local Hub plugin's `CompanionSecureStore`
/// (`frontend/packages/capacitor-local-hub/ios/Sources/LocalHubPlugin/CompanionSecureStore.swift`),
/// under `CompanionSecureStore.credentialsService`, using
/// `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` — the point of that type existing at
/// all is to stop the credential riding along in an encrypted device backup, which is what
/// the retired `capacitor-secure-storage-plugin` did under the service name `cap_sec`. The
/// JS migration (`@ci/common`'s `secureStorageGet`, in `nativeBridge.ts`) copies each value
/// across on first read **and deletes the legacy copy**, so reading only the old service
/// (as this type did until now) finds nothing on any migrated install and every intent
/// fails with `.notConfigured`. Both services are therefore consulted, current first.
///
/// The legacy fallback is not dead code: it covers the window on an upgraded install
/// between launch and the first `secureStorageGet` that performs the migration. It can be
/// deleted once a release that writes only through `CompanionSecureStore` is far enough
/// back that no un-migrated install is still in the field.
enum CompanionConfig {
    /// Service used by `CompanionSecureStore` (Local Hub plugin). Kept in sync with
    /// `CompanionSecureStore.credentialsService` — the app target cannot import it, since
    /// that type is internal to the pod's module.
    private static let keychainService = "com.companionintelligence.localhub.credentials"

    /// Service the retired `capacitor-secure-storage-plugin` filed everything under, read
    /// only so an install that has not yet run the JS migration still works. See the type
    /// docs.
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
    ///   sets `kSecUseDataProtectionKeychain` on-device — its own `baseQuery` omits the flag
    ///   on the simulator, which rejects it, so this does too — while the legacy plugin never
    ///   set it at all. Setting the flag on a lookup for an item written without it is a
    ///   well-known way to make reads miss for no visible reason.
    private static func read(account: String, service: String, dataProtection: Bool) -> String? {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]

        #if !targetEnvironment(simulator)
        if dataProtection {
            query[kSecUseDataProtectionKeychain as String] = true
        }
        #endif

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
