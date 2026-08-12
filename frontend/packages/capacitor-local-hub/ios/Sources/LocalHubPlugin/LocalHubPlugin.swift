import Capacitor
import Foundation

/// iOS native half of the Local Hub sidecar's Phase 1 skeleton. See
/// `src/definitions.ts` for the JS-facing contract this implements and this
/// package's root `README.md` for the full multi-phase design (the outbox and local
/// inference phases land later, behind `LocalHubServer`, not in this file).
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
        CAPPluginMethod(name: "getStatus", returnType: CAPPluginReturnPromise)
    ]

    private let server = LocalHubServer()

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
}
