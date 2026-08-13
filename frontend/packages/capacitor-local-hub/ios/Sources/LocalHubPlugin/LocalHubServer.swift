import Foundation
import GCDWebServer

/// Embedded loopback-only HTTP server for the Local Hub sidecar, backed by
/// GCDWebServer (github.com/swisspol/GCDWebServer).
///
/// Phase 1 (this class, as shipped today): a single bearer-authenticated health
/// check. Later phases (see this package's root `README.md`) add routes for a
/// durable outbox and local inference -- `start()` is meant to stay the one place
/// new routes get registered via `addHandler`, rather than scattering server setup
/// across the plugin, mirroring the Android `LocalHubServer`'s `serve()` router.
///
/// Security posture (per the Local Hub design doc): this server binds explicitly to
/// the loopback interface (127.0.0.1) via `GCDWebServerOption_BindToLocalhost`,
/// never all interfaces, so nothing off-device -- and nothing else on the LAN -- can
/// ever reach it, regardless of firewall/VPN state. Every route also requires the
/// current per-launch bearer token, so no other app *on the same device* can call it
/// either without having separately obtained the token from a live `start()` call
/// through this plugin.
///
/// All mutable state is only ever touched on `stateQueue`, since Capacitor may
/// invoke plugin methods -- and therefore this class's methods -- from more than one
/// thread (e.g. a `getStatus()` poll racing a `stop()`).
///
/// CORS: the caller is the app's own WebView, but Capacitor still loads it as a real
/// browser origin (`capacitor://localhost` on iOS), so the browser enforces CORS
/// against this different-origin loopback server -- confirmed on the Android sibling
/// server via a real device/emulator run, where `fetch()` rejected with a CORS policy
/// error despite the server responding fine; ported the same fix here for parity
/// since GCDWebServer has the identical no-CORS-by-default behavior. A wildcard
/// `Access-Control-Allow-Origin` doesn't weaken this server's actual security
/// boundary: the bearer token is what gates real access. The `Authorization` header
/// also makes every real request "non-simple", so the browser preflights it with an
/// unauthenticated `OPTIONS` -- that must succeed without the bearer check or every
/// real request would fail before it's even sent.
final class LocalHubServer {
    /// Reported by `GET /api/health` -- bump alongside the Local Hub design doc's
    /// phase markers. Kept in sync by hand with the Android `LocalHubServer`'s
    /// `API_VERSION`; there is no shared constant between the two native sides.
    static let apiVersion = "0.1.0"

    private static let healthPath = "/api/health"
    private static let authHeaderName = "Authorization"
    private static let bearerPrefix = "Bearer "
    private static let tokenByteCount = 32

    private let stateQueue = DispatchQueue(label: "com.companionintelligence.localhub.server.state")
    private var webServer: GCDWebServer?
    private var activeToken: String?

    /// Starts the server if not already running (fresh port + fresh token), or
    /// returns the already-running instance's `baseUrl`/`token` unchanged.
    func start() throws -> (baseUrl: String, token: String) {
        try stateQueue.sync {
            if let server = webServer, server.isRunning, let token = activeToken {
                return (Self.baseUrl(port: server.port), token)
            }

            // Clear out a half-dead previous instance (e.g. GCDWebServer stopped
            // itself, or a prior start() got as far as allocating a token/server but
            // failed the `start(options:)` call below) before starting a fresh one.
            webServer?.stop()
            webServer = nil
            activeToken = nil

            let token = try Self.generateToken()
            let server = GCDWebServer()

            server.addHandler(
                forMethod: "GET",
                path: Self.healthPath,
                request: GCDWebServerRequest.self,
                processBlock: { [weak self] request in
                    self?.handleHealth(request, expectedToken: token)
                }
            )

            // Wildcard path/regex so every future route (the outbox, local inference)
            // gets a working CORS preflight for free without adding an OPTIONS handler
            // per route -- mirrors the Android `serve()` router's method-first `when`.
            server.addHandler(
                forMethod: "OPTIONS",
                pathRegex: "^/.*$",
                request: GCDWebServerRequest.self,
                processBlock: { _ in
                    Self.withCors(GCDWebServerResponse(statusCode: 204))
                }
            )

            // GCDWebServerOption_BindToLocalhost restricts the listening socket to
            // 127.0.0.1 instead of GCDWebServer's default of all interfaces -- this
            // is the load-bearing security property of this server. Combined with
            // GCDWebServerOption_Port: 0 (ask the OS for any free ephemeral port),
            // this matches the Android side's
            // `NanoHTTPD(InetAddress.getByName("127.0.0.1"), 0)`.
            try server.start(options: [
                GCDWebServerOption_Port: 0,
                GCDWebServerOption_BindToLocalhost: true
            ])

            webServer = server
            activeToken = token
            return (Self.baseUrl(port: server.port), token)
        }
    }

    /// Stops the server. No-op if it isn't running.
    func stop() {
        stateQueue.sync {
            webServer?.stop()
            webServer = nil
            activeToken = nil
        }
    }

    /// Current running state and, if running, its `baseUrl`. Never exposes the
    /// token -- matches the JS-facing `LocalHubStatusResult` contract.
    func status() -> (running: Bool, baseUrl: String?) {
        stateQueue.sync {
            guard let server = webServer, server.isRunning else {
                return (false, nil)
            }
            return (true, Self.baseUrl(port: server.port))
        }
    }

    // MARK: - Request handling

    private func handleHealth(_ request: GCDWebServerRequest, expectedToken: String) -> GCDWebServerResponse {
        guard let presented = Self.bearerToken(from: request), Self.constantTimeEquals(presented, expectedToken) else {
            return Self.jsonResponse(["error": "unauthorized"], statusCode: 401)
        }

        return Self.jsonResponse(["status": "ok", "version": Self.apiVersion], statusCode: 200)
    }

    /// Case-insensitive `Authorization: Bearer <token>` extraction. GCDWebServer's
    /// `headers` dictionary preserves header names as received on the wire; a
    /// well-behaved `fetch()` call sends `Authorization` with that exact casing, but
    /// matching case-insensitively costs nothing and avoids depending on that.
    private static func bearerToken(from request: GCDWebServerRequest) -> String? {
        for (name, value) in request.headers where name.caseInsensitiveCompare(authHeaderName) == .orderedSame {
            guard value.hasPrefix(bearerPrefix) else { return nil }
            return String(value.dropFirst(bearerPrefix.count))
        }
        return nil
    }

    /// Length-then-XOR comparison so a failed match doesn't leak timing information
    /// about how much of the token matched, mirroring the Android
    /// `LocalHubServer.constantTimeEquals`.
    private static func constantTimeEquals(_ lhs: String, _ rhs: String) -> Bool {
        let lhsBytes = Array(lhs.utf8)
        let rhsBytes = Array(rhs.utf8)
        guard lhsBytes.count == rhsBytes.count else { return false }

        var diff: UInt8 = 0
        for i in 0..<lhsBytes.count {
            diff |= lhsBytes[i] ^ rhsBytes[i]
        }
        return diff == 0
    }

    private static func jsonResponse(_ object: [String: Any], statusCode: Int) -> GCDWebServerResponse {
        // GCDWebServerDataResponse(jsonObject:) is only nil if `object` can't be
        // serialized by JSONSerialization; every call site above passes a literal
        // [String: String], which always succeeds. The fallback exists purely so
        // this stays non-optional without a force-unwrap.
        let response = GCDWebServerDataResponse(jsonObject: object) ?? GCDWebServerResponse()
        response.statusCode = statusCode
        return withCors(response)
    }

    @discardableResult
    private static func withCors(_ response: GCDWebServerResponse) -> GCDWebServerResponse {
        response.setValue("*", forAdditionalHeader: "Access-Control-Allow-Origin")
        response.setValue("GET, OPTIONS", forAdditionalHeader: "Access-Control-Allow-Methods")
        response.setValue(authHeaderName, forAdditionalHeader: "Access-Control-Allow-Headers")
        return response
    }

    private static func baseUrl(port: UInt) -> String {
        "http://127.0.0.1:\(port)"
    }

    /// `tokenByteCount` bytes (256 bits) from the system CSPRNG, base64url-encoded
    /// (RFC 4648 §5) with padding stripped -- a fresh, unguessable, unpersisted
    /// token minted on every server (re)start, never written to disk. Mirrors the
    /// Android side's `SecureRandom` + `Base64.URL_SAFE or Base64.NO_PADDING`.
    private static func generateToken() throws -> String {
        var bytes = [UInt8](repeating: 0, count: tokenByteCount)
        let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        guard status == errSecSuccess else {
            throw LocalHubServerError.tokenGenerationFailed(status)
        }

        return Data(bytes).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}

enum LocalHubServerError: LocalizedError {
    case tokenGenerationFailed(OSStatus)

    var errorDescription: String? {
        switch self {
        case let .tokenGenerationFailed(status):
            return "SecRandomCopyBytes failed with OSStatus \(status)."
        }
    }
}
