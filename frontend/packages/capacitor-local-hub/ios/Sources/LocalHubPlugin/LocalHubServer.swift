import Foundation
import GCDWebServer

/// Embedded loopback-only HTTP server for the Local Hub sidecar, backed by
/// GCDWebServer (github.com/swisspol/GCDWebServer).
///
/// Routes today: a bearer-authenticated health check plus the durable capture
/// outbox (`/api/outbox`, backed by `OutboxStore`). Later phases (see this
/// package's root `README.md`) add local inference -- `start()` is meant to stay
/// the one place new routes get registered via `addHandler`, rather than
/// scattering server setup across the plugin, mirroring the Android
/// `LocalHubServer`'s `serve()` router.
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
/// real request would fail before it's even sent. The outbox routes additionally
/// send `Content-Type: application/json` bodies, which is itself a preflight
/// trigger, so `Content-Type` has to be in `Access-Control-Allow-Headers` too --
/// omitting it reproduces the exact same class of bug on POST that the missing
/// `Access-Control-Allow-Origin` caused on GET.
final class LocalHubServer {
    /// Reported by `GET /api/health` -- bump alongside the Local Hub design doc's
    /// phase markers. Kept in sync by hand with the Android `LocalHubServer`'s
    /// `API_VERSION`; there is no shared constant between the two native sides.
    static let apiVersion = "0.2.0"

    private static let healthPath = "/api/health"
    private static let outboxPath = "/api/outbox"
    /// Matches `/api/outbox`, `/api/outbox/<id>`, and `/api/outbox/<id>/<action>`;
    /// the path is re-parsed in `outboxPathSegments` rather than relying on
    /// GCDWebServer's regex-capture attribute.
    private static let outboxPathRegex = "^/api/outbox(/.*)?$"
    private static let attemptSegment = "attempt"
    private static let retrySegment = "retry"
    private static let statusQueryKey = "status"
    private static let statusFilterAll = "all"
    private static let authHeaderName = "Authorization"
    private static let bearerPrefix = "Bearer "
    private static let tokenByteCount = 32

    private let stateQueue = DispatchQueue(label: "com.companionintelligence.localhub.server.state")
    private var webServer: GCDWebServer?
    private var activeToken: String?

    /// Outlives individual server instances on purpose: `stop()` tears down the HTTP
    /// listener, but the queued captures behind it are durable user data, so the
    /// database handle is only released when this object goes away.
    private var outbox: OutboxStore?

    /// Guards `warmUpOnMainThread`. Only ever read or written *on the main thread*, which is
    /// what makes an unsynchronized `var` safe here.
    private static var isGCDWebServerWarm = false

    /// Runs `+[GCDWebServer initialize]` on the main thread, once.
    ///
    /// GCDWebServer's class initializer calls `GCDWebServerInitializeFunctions()`, whose first
    /// statement is `GWS_DCHECK([NSThread isMainThread])` -- it builds two shared
    /// `NSDateFormatter`s and wants them created on the main thread. Under `DEBUG`,
    /// `GWS_DCHECK` expands to a bare `abort()`, so touching `GCDWebServer` for the first time
    /// from any other thread is an immediate SIGABRT rather than a warning.
    ///
    /// `+initialize` fires on the first message to the class, and the first message this file
    /// sends is the `GCDWebServer()` inside `start()` -- which runs on `stateQueue`, never the
    /// main thread. That crashed the app on the very first `LocalHub.start()` call from JS
    /// (confirmed on an iOS 27 simulator: `+[GCDWebServer initialize]` -> `abort` on thread
    /// `com.companionintelligence.localhub.server.state`).
    ///
    /// Allocating and dropping one server is a safe way to force the class initializer: `-init`
    /// only sets up a serial queue, a dispatch group, and an empty handler array, and a server
    /// that was never started satisfies every `GWS_DCHECK` in `-dealloc`.
    ///
    /// - Important: call this **before** taking `stateQueue`, never from inside it. It can block
    ///   on the main queue, and `stop()`/`status()` take `stateQueue` from the main thread, so
    ///   warming up while holding the queue would invert the two locks and deadlock.
    static func warmUpOnMainThread() {
        if Thread.isMainThread {
            guard !isGCDWebServerWarm else { return }
            _ = GCDWebServer()
            isGCDWebServerWarm = true
            return
        }
        DispatchQueue.main.sync {
            guard !isGCDWebServerWarm else { return }
            _ = GCDWebServer()
            isGCDWebServerWarm = true
        }
    }

    /// Starts the server if not already running (fresh port + fresh token), or
    /// returns the already-running instance's `baseUrl`/`token` unchanged.
    func start() throws -> (baseUrl: String, token: String) {
        // Outside stateQueue on purpose -- see warmUpOnMainThread's Important note.
        Self.warmUpOnMainThread()

        // Explicit closure result type: multi-statement closures only infer their return
        // type on newer Swift compilers, and none of this file has ever been compiled.
        return try stateQueue.sync { () -> (baseUrl: String, token: String) in
            // `server.port > 0` is not redundant with `isRunning`. GCDWebServer's
            // `isRunning` is literally `return (_options ? YES : NO)`, and its internal
            // `_stop` zeroes `_port` WITHOUT clearing `_options` -- so a suspended server
            // reports running while its port is 0. Without this check the fast path hands
            // back "http://127.0.0.1:0" and every request against it fails. See
            // `suspendInBackgroundDisabled` below for when that happens.
            if let server = webServer, server.isRunning, server.port > 0, let token = activeToken {
                return (Self.baseUrl(port: server.port), token)
            }

            // Clear out a half-dead previous instance (e.g. GCDWebServer stopped
            // itself, or a prior start() got as far as allocating a token/server but
            // failed the `start(options:)` call below) before starting a fresh one.
            webServer?.stop()
            webServer = nil
            activeToken = nil

            let token = try Self.generateToken()

            // Opened before the listener binds so a broken/corrupt outbox is a start()
            // failure the caller can see, rather than a 500 on the first capture. Reused
            // across restarts: the queued items are durable user data.
            let store: OutboxStore
            if let existing = outbox {
                store = existing
            } else {
                store = try OutboxStore(databaseURL: OutboxStore.defaultDatabaseURL())
                outbox = store
            }

            let server = GCDWebServer()

            // GCDWebServer matches handlers in LIFO order (last registered wins), so the
            // catch-alls go first and the specific routes are layered on top.
            //
            // These default handlers exist so *every* response -- including 404s and 401s
            // for paths nothing claims -- carries the CORS headers and the same
            // auth-before-dispatch behavior as Android's router. GCDWebServer's built-in
            // 404 would come back without them, which in a WebView is indistinguishable
            // from a CORS failure.
            for method in ["GET", "POST", "DELETE"] {
                server.addDefaultHandler(
                    forMethod: method,
                    request: GCDWebServerDataRequest.self,
                    processBlock: { [weak self] request in
                        guard let self = self else {
                            return Self.jsonResponse(["error": "internal_error"], statusCode: 500)
                        }
                        guard Self.isAuthorized(request, expectedToken: token) else {
                            return Self.jsonResponse(["error": "unauthorized"], statusCode: 401)
                        }
                        return Self.jsonResponse(["error": "not_found"], statusCode: 404)
                    }
                )
            }

            server.addHandler(
                forMethod: "GET",
                path: Self.healthPath,
                request: GCDWebServerRequest.self,
                processBlock: { [weak self] request in
                    self?.handleHealth(request, expectedToken: token)
                }
            )

            // One handler per method covering the whole outbox subtree; the path is then
            // split in `routeOutbox`, mirroring the Android router's `when` branches.
            for method in ["GET", "POST", "DELETE"] {
                server.addHandler(
                    forMethod: method,
                    pathRegex: Self.outboxPathRegex,
                    request: GCDWebServerDataRequest.self,
                    processBlock: { [weak self] request in
                        self?.handleOutbox(request, store: store, expectedToken: token)
                    }
                )
            }

            // Wildcard path/regex so every route (the outbox today, local inference later)
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
                GCDWebServerOption_BindToLocalhost: true,
                // GCDWebServer defaults GCDWebServerOption_AutomaticallySuspendInBackground
                // to YES: it observes UIApplicationDidEnterBackground and tears its own
                // listener down, then rebinds on foreground. That default is wrong for a
                // sidecar and diverges from Android, whose NanoHTTPD is not tied to any
                // lifecycle and keeps one port for the whole process.
                //
                // Three things went wrong with it left on. The internal `_stop` sets
                // `_port = 0` but does NOT clear `_options`, and `isRunning` is just
                // `_options != nil` -- so a suspended server reports running with port 0,
                // and both start() and status() published "http://127.0.0.1:0". The
                // foreground rebind re-reads the stored port option, still 0, so it comes
                // back on a DIFFERENT ephemeral port. And that rebind is unchecked in
                // GCDWebServer ("TODO: There's probably nothing we can do on failure"), so
                // a single failed rebind leaves the server permanently dead while still
                // claiming to run -- every capture, health probe and flush failing until
                // the user force-quits the app.
                //
                // It also removes a UIKit threading violation on this very call, as a real
                // consequence rather than a coincidence. `-startWithOptions:` reads:
                //
                //     if (((_suspendInBackground == NO) ||
                //          ([[UIApplication sharedApplication] applicationState] != …Background))
                //         && ![self _start:error])
                //
                // `start()` runs on `stateQueue`, so evaluating `applicationState` there is a
                // UIKit call off the main thread. With this option false the left operand is
                // true, `||` short-circuits, and `applicationState` is never touched. The
                // `addObserver` calls below it are likewise wrapped in
                // `if (_suspendInBackground)`, so no lifecycle observers get registered at all.
                //
                // ⚠️ Restoring the default would silently bring back BOTH problems at once.
                GCDWebServerOption_AutomaticallySuspendInBackground: false
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
        stateQueue.sync { () -> (running: Bool, baseUrl: String?) in
            // `port > 0` for the same reason as in start(): GCDWebServer can report
            // isRunning while its port is 0. `LocalHubStatusResult` promises that a
            // `running: true` carries a usable `baseUrl`, and "http://127.0.0.1:0" is not
            // one -- reporting not-running is the honest answer, and it prompts the caller
            // to start() again, which rebuilds.
            guard let server = webServer, server.isRunning, server.port > 0 else {
                return (false, nil)
            }
            return (true, Self.baseUrl(port: server.port))
        }
    }

    // MARK: - Request handling

    private func handleHealth(_ request: GCDWebServerRequest, expectedToken: String) -> GCDWebServerResponse {
        guard Self.isAuthorized(request, expectedToken: expectedToken) else {
            return Self.jsonResponse(["error": "unauthorized"], statusCode: 401)
        }

        return Self.jsonResponse(["status": "ok", "version": Self.apiVersion], statusCode: 200)
    }

    // MARK: - Outbox routes

    /// Single entry point for every `/api/outbox…` request, mirroring the Android
    /// `routeOutbox`. The bearer check happens before dispatch, so an
    /// unauthenticated caller cannot even probe which routes exist.
    private func handleOutbox(
        _ request: GCDWebServerRequest,
        store: OutboxStore,
        expectedToken: String
    ) -> GCDWebServerResponse {
        guard Self.isAuthorized(request, expectedToken: expectedToken) else {
            return Self.jsonResponse(["error": "unauthorized"], statusCode: 401)
        }

        guard let segments = Self.outboxPathSegments(request.path) else {
            return Self.notFound()
        }

        do {
            let method = request.method.uppercased()
            switch (method, segments.count) {
            case ("POST", 0):
                return try handleEnqueue(request, store: store)
            case ("GET", 0):
                return try handleList(request, store: store)
            case ("GET", 1):
                return try handleGetOne(id: segments[0], store: store)
            case ("DELETE", 1):
                let deleted = try store.delete(id: segments[0])
                return deleted ? Self.noContent() : Self.notFound()
            case ("POST", 2) where segments[1] == Self.attemptSegment:
                return try handleAttempt(request, id: segments[0], store: store)
            case ("POST", 2) where segments[1] == Self.retrySegment:
                guard let updated = try store.retry(id: segments[0]) else {
                    return Self.notFound()
                }
                return Self.jsonResponse(Self.itemDictionary(updated, includePayload: false), statusCode: 200)
            default:
                return Self.notFound()
            }
        } catch {
            return Self.jsonResponse(
                ["error": "internal_error", "detail": error.localizedDescription],
                statusCode: 500
            )
        }
    }

    private func handleEnqueue(_ request: GCDWebServerRequest, store: OutboxStore) throws -> GCDWebServerResponse {
        guard let body = Self.jsonBody(request) else {
            return Self.badRequest("Request body must be a JSON object.")
        }
        guard let kind = Self.nonEmptyString(body["kind"]) else {
            return Self.badRequest("\"kind\" must be a non-empty string.")
        }
        guard let payload = body["payload"] as? [String: Any],
              let payloadData = try? JSONSerialization.data(withJSONObject: payload),
              let payloadJSON = String(data: payloadData, encoding: .utf8) else {
            return Self.badRequest("\"payload\" must be a JSON object.")
        }
        // Client capture time, stored verbatim -- see OutboxStore.enqueue. The sidecar
        // never substitutes its own clock, so an item that queues offline for a day still
        // lands on the server with the timestamp the user actually captured it at.
        guard let capturedAt = Self.nonEmptyString(body["capturedAt"]) else {
            return Self.badRequest("\"capturedAt\" must be a non-empty ISO-8601 string.")
        }
        guard let idempotencyKey = Self.nonEmptyString(body["idempotencyKey"]) else {
            return Self.badRequest("\"idempotencyKey\" must be a non-empty string.")
        }

        let outcome = try store.enqueue(
            kind: kind,
            payloadJSON: payloadJSON,
            capturedAt: capturedAt,
            idempotencyKey: idempotencyKey
        )

        switch outcome {
        // A replay of an already-accepted key answers exactly like the original accept:
        // the caller retried because it never saw the first response, so it should not
        // have to special-case the second one.
        case let .created(item), let .duplicate(item):
            return Self.jsonResponse(
                [
                    "id": item.id,
                    "status": item.status,
                    "capturedAt": item.capturedAt,
                    "seq": item.seq
                ],
                statusCode: 201
            )
        case .atCapacity:
            return Self.jsonResponse(
                [
                    "error": "outbox_full",
                    "detail": "The outbox is at its \(store.maxItems)-item cap. "
                        + "Nothing was dropped; flush or discard existing items before capturing more."
                ],
                statusCode: 507
            )
        }
    }

    private func handleList(_ request: GCDWebServerRequest, store: OutboxStore) throws -> GCDWebServerResponse {
        let requested = request.query?[Self.statusQueryKey] ?? Self.statusFilterAll
        let filter: String?
        switch requested {
        case Self.statusFilterAll:
            filter = nil
        case OutboxStore.statusPending, OutboxStore.statusNeedsAttention:
            filter = requested
        default:
            return Self.badRequest(
                "\"status\" must be one of \(OutboxStore.statusPending), "
                    + "\(OutboxStore.statusNeedsAttention), \(Self.statusFilterAll)."
            )
        }

        // Oldest-first: the list doubles as the flusher's work queue, so its order IS the
        // replay order. Payloads are omitted here -- they can be large (media, long notes)
        // and a queue-depth poll should not have to stream all of them.
        let items = try store.list(status: filter).map { Self.itemDictionary($0, includePayload: false) }
        let counts = try store.counts()

        return Self.jsonResponse(
            [
                "items": items,
                "counts": [
                    "pending": counts.pending,
                    "needsAttention": counts.needsAttention,
                    "total": counts.total
                ],
                "capacity": [
                    "max": store.maxItems,
                    "used": counts.total,
                    "warnAt": store.warnAt
                ]
            ],
            statusCode: 200
        )
    }

    private func handleGetOne(id: String, store: OutboxStore) throws -> GCDWebServerResponse {
        guard let item = try store.item(id: id) else {
            return Self.notFound()
        }
        return Self.jsonResponse(Self.itemDictionary(item, includePayload: true), statusCode: 200)
    }

    private func handleAttempt(
        _ request: GCDWebServerRequest,
        id: String,
        store: OutboxStore
    ) throws -> GCDWebServerResponse {
        guard let body = Self.jsonBody(request) else {
            return Self.badRequest("Request body must be a JSON object.")
        }
        guard let ok = body["ok"] as? Bool else {
            return Self.badRequest("\"ok\" must be a boolean.")
        }

        if ok {
            // Success is the same terminal state as an explicit user discard: the row goes
            // away. Handing the flusher a separate "mark done" state would just create a
            // second thing to garbage-collect.
            let deleted = try store.delete(id: id)
            return deleted ? Self.noContent() : Self.notFound()
        }

        guard let error = Self.nonEmptyString(body["error"]) else {
            return Self.badRequest("\"error\" must be a non-empty string when ok is false.")
        }
        let permanent = (body["permanent"] as? Bool) ?? false
        guard let updated = try store.recordFailedAttempt(id: id, error: error, permanent: permanent) else {
            return Self.notFound()
        }
        return Self.jsonResponse(Self.itemDictionary(updated, includePayload: false), statusCode: 200)
    }

    // MARK: - Outbox helpers

    /// Splits the path *below* `/api/outbox`: `nil` when the URI isn't an outbox route at
    /// all, `[]` for the collection itself, `[id]` / `[id, "attempt"]` for item routes.
    /// A trailing slash is tolerated so `/api/outbox/` and `/api/outbox` behave alike.
    private static func outboxPathSegments(_ path: String) -> [String]? {
        var normalized = path
        while normalized.hasSuffix("/") {
            normalized.removeLast()
        }
        if normalized == outboxPath {
            return []
        }
        guard normalized.hasPrefix(outboxPath + "/") else {
            return nil
        }
        return normalized
            .dropFirst(outboxPath.count + 1)
            .split(separator: "/")
            .map(String.init)
    }

    private static func itemDictionary(_ item: OutboxItem, includePayload: Bool) -> [String: Any] {
        var dictionary: [String: Any] = [
            "id": item.id,
            "kind": item.kind,
            "capturedAt": item.capturedAt,
            "seq": item.seq,
            "status": item.status,
            "attempts": item.attempts,
            // The contract says lastError is `string | null` -- always present. NSNull is
            // what JSONSerialization turns into a JSON null.
            "lastError": item.lastError ?? NSNull()
        ]
        if includePayload {
            // Re-parsed rather than string-spliced so the payload nests as real JSON. It
            // was validated as an object on the way in, so this cannot fail for stored rows.
            let payloadData = (item.payload ?? "{}").data(using: .utf8) ?? Data("{}".utf8)
            let parsed = (try? JSONSerialization.jsonObject(with: payloadData)) ?? [String: Any]()
            dictionary["payload"] = parsed
        }
        return dictionary
    }

    /// Parses the request body as a JSON object. `nil` for an unreadable body, malformed
    /// JSON, or a JSON array/scalar instead of an object -- the caller turns that into 400.
    private static func jsonBody(_ request: GCDWebServerRequest) -> [String: Any]? {
        guard let dataRequest = request as? GCDWebServerDataRequest, dataRequest.data.count > 0 else {
            return nil
        }
        return (try? JSONSerialization.jsonObject(with: dataRequest.data)) as? [String: Any]
    }

    private static func nonEmptyString(_ value: Any?) -> String? {
        guard let string = value as? String, !string.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            return nil
        }
        return string
    }

    private static func isAuthorized(_ request: GCDWebServerRequest, expectedToken: String) -> Bool {
        guard let presented = bearerToken(from: request) else {
            return false
        }
        return constantTimeEquals(presented, expectedToken)
    }

    private static func notFound() -> GCDWebServerResponse {
        jsonResponse(["error": "not_found"], statusCode: 404)
    }

    private static func badRequest(_ detail: String) -> GCDWebServerResponse {
        jsonResponse(["error": "invalid_request", "detail": detail], statusCode: 400)
    }

    private static func noContent() -> GCDWebServerResponse {
        withCors(GCDWebServerResponse(statusCode: 204))
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
        // serialized by JSONSerialization; every call site above passes strings,
        // numbers, NSNull, arrays, and nested dictionaries of the same, all of which
        // always succeed. The fallback exists purely so this stays non-optional
        // without a force-unwrap.
        let response = GCDWebServerDataResponse(jsonObject: object) ?? GCDWebServerResponse()
        response.statusCode = statusCode
        return withCors(response)
    }

    @discardableResult
    private static func withCors(_ response: GCDWebServerResponse) -> GCDWebServerResponse {
        response.setValue("*", forAdditionalHeader: "Access-Control-Allow-Origin")
        response.setValue("GET, POST, DELETE, OPTIONS", forAdditionalHeader: "Access-Control-Allow-Methods")
        // Content-Type is as load-bearing as Authorization here: a JSON POST body is
        // itself a preflight trigger, so leaving it out breaks every outbox write.
        response.setValue("\(authHeaderName), Content-Type", forAdditionalHeader: "Access-Control-Allow-Headers")
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
