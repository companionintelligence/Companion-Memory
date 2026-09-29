import AuthenticationServices
import Capacitor
import Foundation
import UIKit

/// iOS native half of the Local Hub sidecar. See `src/definitions.ts` for the
/// JS-facing contract this implements and this package's root `README.md` for the
/// full multi-phase design. The HTTP surface -- including the durable outbox routes
/// and, later, local inference -- lives behind `LocalHubServer`, not in this file.
///
/// Registered with `jsName = "LocalHub"` -- this MUST match the string passed to
/// `registerPlugin<LocalHubPlugin>('LocalHub', …)` in `src/index.ts`, and the
/// Android side's `@CapacitorPlugin(name = "LocalHub")`, or the JS bridge will not
/// find this implementation. `identifier` is this class's own name, following the
/// same convention as `@capacitor/app`'s `AppPlugin` (identifier `"AppPlugin"`,
/// jsName `"App"`).
///
/// This class only translates between `CAPPluginCall` and `LocalHubServer`'s plain
/// Swift API -- all HTTP-serving logic (GCDWebServer setup, routing, auth) lives
/// there.
@objc(LocalHubPlugin)
public class LocalHubPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "LocalHubPlugin"
    public let jsName = "LocalHub"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "start", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "secureGet", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "secureSet", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "secureRemove", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openUrl", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startAuthSession", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getCurrentLocation", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "openAppSettings", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getLocationAuthorization", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestLocationAuthorization", returnType: CAPPluginReturnPromise)
    ]

    private let server = LocalHubServer()

    /// Credential namespace only. The outbox database key lives in its own namespace and is
    /// never reachable from JS -- nothing in the WebView has any business holding it.
    private let secureStore = CompanionSecureStore.credentials()

    /// Kept alive until the sheet finishes. UIKit drops an `ASWebAuthenticationSession`
    /// that nothing retains, and the completion handler never runs.
    private var authSession: ASWebAuthenticationSession?

    /// Capacitor calls `load()` on the main thread at plugin-registration time, before any JS
    /// can reach `start()`. Warming GCDWebServer here means the class initializer -- which
    /// `abort()`s under DEBUG unless it runs on the main thread -- is already done by the time
    /// a call arrives on a background queue. `start()` repeats the guard for its own safety;
    /// see `LocalHubServer.warmUpOnMainThread`.
    override public func load() {
        LocalHubServer.warmUpOnMainThread()
    }

    /// Starts the embedded loopback HTTP server if it isn't already running and
    /// resolves with its `baseUrl`/`token`. If already running, resolves with the
    /// existing `baseUrl`/`token` unchanged -- no restart, no new token minted.
    @objc func start(_ call: CAPPluginCall) {
        do {
            let result = try server.start()
            call.resolve([
                "baseUrl": result.baseUrl,
                "token": result.token
            ])
        } catch {
            call.reject("Failed to start Local Hub server.", nil, error)
        }
    }

    /// Stops the server. Resolves successfully as a no-op if it isn't running.
    @objc func stop(_ call: CAPPluginCall) {
        server.stop()
        call.resolve()
    }

    /// Reports whether the server is running and, if so, its `baseUrl`. Never
    /// returns the token -- a caller that needs it calls `start()` again, which is
    /// idempotent while the server is already running (see above).
    @objc func getStatus(_ call: CAPPluginCall) {
        let status = server.status()
        var result: [String: Any] = ["running": status.running]
        if let baseUrl = status.baseUrl {
            result["baseUrl"] = baseUrl
        }
        call.resolve(result)
    }

    // MARK: - Secure storage

    /// Reads one value from the Keychain, resolving `{ "value": null }` when nothing is stored.
    ///
    /// Rejects -- rather than resolving null -- when the Keychain itself refuses, so the two
    /// cases stay distinguishable at the bridge. The JS `secureStorageGet` chooses to collapse
    /// both into "signed out"; that leniency belongs at the call site, not here.
    @objc func secureGet(_ call: CAPPluginCall) {
        guard let key = call.getString("key"), !key.isEmpty else {
            call.reject("A non-empty 'key' is required")
            return
        }
        do {
            let value = try secureStore.get(key)
            // NSNull rather than omitting the field, so the resolved object's shape is stable
            // for the TS side.
            call.resolve(["value": value ?? NSNull()])
        } catch {
            call.reject(error.localizedDescription, nil, error)
        }
    }

    /// Stores one value with `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, rejecting if
    /// the Keychain would not take it. There is no weaker fallback below this.
    @objc func secureSet(_ call: CAPPluginCall) {
        guard let key = call.getString("key"), !key.isEmpty else {
            call.reject("A non-empty 'key' is required")
            return
        }
        guard let value = call.getString("value") else {
            call.reject("A 'value' is required")
            return
        }
        do {
            try secureStore.set(key, value)
            call.resolve()
        } catch {
            call.reject(error.localizedDescription, nil, error)
        }
    }

    /// Removes one value. Resolves successfully when it was already absent.
    @objc func secureRemove(_ call: CAPPluginCall) {
        guard let key = call.getString("key"), !key.isEmpty else {
            call.reject("A non-empty 'key' is required")
            return
        }
        do {
            try secureStore.remove(key)
            call.resolve()
        } catch {
            call.reject(error.localizedDescription, nil, error)
        }
    }

    /// Opens a URL in the system browser (Safari). Not for sign-in: Portal OIDC uses
    /// `startAuthSession`, which stays inside the app. This remains for links that
    /// are not an authentication round-trip, such as iOS Settings.
    @objc func openUrl(_ call: CAPPluginCall) {
        guard let urlString = call.getString("url"), let url = URL(string: urlString) else {
            call.reject("A valid 'url' is required")
            return
        }
        DispatchQueue.main.async {
            UIApplication.shared.open(url, options: [:]) { success in
                if success {
                    call.resolve()
                } else {
                    call.reject("Could not open URL in Safari")
                }
            }
        }
    }

    /// In-app Safari authentication sheet. `SFSafariViewController` swallows `companion://`
    /// and never reaches `SceneDelegate`, so sign-in cannot finish. This session returns
    /// the callback URL to the app while it stays in the foreground, then forwards it
    /// through `ApplicationDelegateProxy` the same way `SceneDelegate` does, so
    /// `appUrlOpen` and `getLaunchUrl` still see `companion://oidc/callback` and
    /// `companion://auth/callback`.
    @objc func startAuthSession(_ call: CAPPluginCall) {
        guard let urlString = call.getString("url"),
              let url = URL(string: urlString),
              let scheme = url.scheme?.lowercased(),
              scheme == "https" || scheme == "http" else {
            call.reject("A valid http(s) 'url' is required")
            return
        }
        let callbackScheme = call.getString("callbackScheme")?.trimmingCharacters(in: .whitespacesAndNewlines)
        let schemeToUse = (callbackScheme?.isEmpty == false) ? callbackScheme! : "companion"

        DispatchQueue.main.async { [weak self] in
            guard let self else {
                call.reject("Sign-in sheet is unavailable")
                return
            }

            self.authSession?.cancel()

            let session = ASWebAuthenticationSession(url: url, callbackURLScheme: schemeToUse) { [weak self] callbackURL, error in
                self?.authSession = nil

                if let callbackURL {
                    _ = ApplicationDelegateProxy.shared.application(
                        UIApplication.shared,
                        open: callbackURL,
                        options: [:]
                    )
                    call.resolve()
                    return
                }

                if let authError = error as? ASWebAuthenticationSessionError, authError.code == .canceledLogin {
                    call.reject("Sign-in cancelled", "CANCELLED")
                    return
                }

                call.reject(error?.localizedDescription ?? "Sign-in failed")
            }

            session.presentationContextProvider = self
            // A shared cookie jar signs the next attempt in as whoever was here last
            // and never shows the email field. Ephemeral drops those cookies when
            // the sheet closes, so the next Log in starts empty.
            session.prefersEphemeralWebBrowserSession = true
            self.authSession = session

            if !session.start() {
                self.authSession = nil
                call.reject("Could not present the sign-in sheet")
            }
        }
    }

    /// One-shot high-accuracy fix for "use my location" (e.g. adding a Place). Does not
    /// touch the tracking outbox -- continuous background tracking is owned entirely by
    /// `@capacitor-community/background-geolocation` now, not this plugin.
    @objc func getCurrentLocation(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            LocationTracker.shared.requestCurrentFix(
                resolve: { payload in call.resolve(payload) },
                reject: { message in call.reject(message) }
            )
        }
    }

    @objc func openAppSettings(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            guard let url = URL(string: UIApplication.openSettingsURLString) else {
                call.reject("Could not open iOS Settings")
                return
            }
            UIApplication.shared.open(url, options: [:]) { success in
                if success {
                    call.resolve()
                } else {
                    call.reject("Could not open iOS Settings")
                }
            }
        }
    }

    /// Current Core Location authorization. Used to finish the Always two-step
    /// (When In Use, then Always) before starting background tracking.
    @objc func getLocationAuthorization(_ call: CAPPluginCall) {
        DispatchQueue.main.async {
            call.resolve(["status": LocationTracker.shared.authorizationStatusName()])
        }
    }

    @objc func requestLocationAuthorization(_ call: CAPPluginCall) {
        let always = call.getBool("always") ?? false
        DispatchQueue.main.async {
            LocationTracker.shared.requestAuthorization(always: always) { status in
                call.resolve(["status": status])
            }
        }
    }
}

extension LocalHubPlugin: ASWebAuthenticationPresentationContextProviding {
    /// The app's window lives on `SceneDelegate`, not `AppDelegate`. A missing anchor
    /// is why an in-app sheet never appears under the UIScene lifecycle.
    public func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let scene = scenes.first { $0.activationState == .foregroundActive } ?? scenes.first

        if let scene {
            if let key = scene.windows.first(where: \.isKeyWindow) {
                return key
            }
            if let any = scene.windows.first {
                return any
            }
        }

        return ASPresentationAnchor()
    }
}
