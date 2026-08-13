import Capacitor
import Foundation

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
        CAPPluginMethod(name: "secureRemove", returnType: CAPPluginReturnPromise)
    ]

    private let server = LocalHubServer()

    /// Credential namespace only. The outbox database key lives in its own namespace and is
    /// never reachable from JS -- nothing in the WebView has any business holding it.
    private let secureStore = CompanionSecureStore.credentials()

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
}
