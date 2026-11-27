import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

// Short-lived access tokens for the device key, iOS half; the Android twin is
// `android/.../localhub/DeviceAccessTokens.kt` and the desktop one is in the Tauri app. Keep the
// three in step: `deviceAccessToken` in `src/definitions.ts` is the contract.
//
// The web page used to read `ci.apiKey` back and send it on every request, so any script that ran
// in it could carry off a key that works from anywhere until revoked. Now the key stays here: the
// page asks for a token, this trades the key for one at `POST /api/keys/access-token` (five
// minutes on the server, 06e37e915), and the page only ever holds the token.
//
// Foundation-only, like OutboxUpload.swift, so it can be type-checked and exercised on Linux; the
// plugin wiring is in LocalHubPlugin.swift. UNCOMPILED by Xcode as written (2026-11-27).

/// What `deviceAccessToken` resolves `status` to.
enum DeviceAccessTokenStatus: String {
    /// No device key is stored: signed out.
    case none
    /// `token` works until `expiresAt`.
    case ok
    /// Memory refused the key (401 or 403): it was revoked, or is not a device key.
    case revoked
    /// No answer from Memory, or one that settles nothing. The key is still there.
    case unreachable
    /// Memory predates access tokens (404): `token` is the key itself, as before.
    case legacy
}

/// The resolved object of `deviceAccessToken`. Every field is always present, null when absent.
struct DeviceAccessTokenResult: Equatable {
    let status: DeviceAccessTokenStatus
    let token: String?
    /// When `token` stops working, in ms since the epoch. Only for `ok`.
    let expiresAt: Double?
    /// `ci.apiKeyId`, whenever a key is stored.
    let keyId: String?
    /// `OutboxOwnerStamp` of the stored origin and key, whenever both are stored, so the page can
    /// stamp queued captures without holding the key.
    let ownerStamp: String?

    static let signedOut = DeviceAccessTokenResult(status: .none, token: nil, expiresAt: nil, keyId: nil, ownerStamp: nil)

    /// For `CAPPluginCall.resolve`: NSNull rather than a missing field, so the shape is stable.
    var bridgeObject: [String: Any] {
        [
            "status": status.rawValue,
            "token": orNull(token),
            "expiresAt": orNull(expiresAt),
            "keyId": orNull(keyId),
            "ownerStamp": orNull(ownerStamp),
        ]
    }

    private func orNull(_ value: Any?) -> Any {
        value ?? NSNull()
    }
}

/// The device credentials as stored in `CompanionSecureStore.credentials()`.
struct DeviceCredentials: Equatable {
    let apiKey: String?
    let keyId: String?
    let baseUrl: String?
}

enum DeviceOrigin {
    /// The stored origin as compared and sent to: trimmed, without trailing slashes, nil when
    /// empty. The page stores `URL.origin`, which has none, so this only evens out stray ones.
    static func normalized(_ raw: String?) -> String? {
        guard var value = raw?.trimmingCharacters(in: .whitespacesAndNewlines) else {
            return nil
        }
        while value.hasSuffix("/") {
            value.removeLast()
        }
        return value.isEmpty ? nil : value
    }

    /// Whether writing `newOrigin` over `storedOrigin` (nil: removing it) must remove the stored
    /// device key first. The key goes only to the origin it was stored with, so a change of a stored
    /// origin takes the key with it; the same origin again, or one where none was stored, does not.
    static func changeRemovesDeviceKey(storedOrigin: String?, newOrigin: String?, keyStored: Bool) -> Bool {
        guard keyStored, let stored = normalized(storedOrigin) else {
            return false
        }
        return stored != normalized(newOrigin)
    }

    /// Where a background job armed by the page may send the device key: the stored origin, and only
    /// when the origin the job was armed with is that same one.
    ///
    /// The background upload and replica sync are armed with an origin the page passes, and the page
    /// can pass any. Sent there, the key would go to a server of the page's choosing without the page
    /// ever reading it. The stored `ci.apiBaseUrl` is the origin the key was stored with (changing it
    /// removes the key, `changeRemovesDeviceKey`), so that is the only place the key goes.
    static func backgroundDestination(armedWith configured: String?, stored: String?) -> BackgroundKeyDestination {
        guard let configured = normalized(configured) else {
            return .notArmed
        }
        guard let stored = normalized(stored), tokenURL(stored) != nil, stored == configured else {
            return .refused
        }
        return .send(origin: stored)
    }

    /// `<origin>/api/keys/access-token`, or nil unless the origin is an http(s) URL with a host.
    static func tokenURL(_ origin: String) -> URL? {
        guard let base = URL(string: origin),
              let scheme = base.scheme?.lowercased(),
              scheme == "http" || scheme == "https",
              let host = base.host, !host.isEmpty else {
            return nil
        }
        return URL(string: "\(origin)/api/keys/access-token")
    }
}

/// What `DeviceOrigin.backgroundDestination` decides.
enum BackgroundKeyDestination: Equatable {
    /// Send to this origin, the stored one.
    case send(origin: String)
    /// The job was armed with no origin: nothing to do, as before.
    case notArmed
    /// Armed with an origin other than the stored one (or none is stored): send nothing.
    case refused
}

/// One answer from `POST /api/keys/access-token`. `status` is nil when none arrived.
struct DeviceTokenHTTPResponse {
    let status: Int?
    let body: Data?
}

protocol DeviceTokenTransport: Sendable {
    func post(url: URL, apiKey: String) async -> DeviceTokenHTTPResponse
}

/// URLSession, ephemeral, 10 s, and no redirects: a redirect would hand the key to wherever it
/// points, so one is refused and its 3xx comes back as the answer (which reads as `unreachable`).
final class URLSessionDeviceTokenTransport: NSObject, DeviceTokenTransport, URLSessionTaskDelegate, @unchecked Sendable {
    static let timeout: TimeInterval = 10

    private lazy var session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = Self.timeout
        configuration.timeoutIntervalForResource = Self.timeout
        return URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
    }()

    func post(url: URL, apiKey: String) async -> DeviceTokenHTTPResponse {
        var request = URLRequest(url: url, timeoutInterval: Self.timeout)
        request.httpMethod = "POST"
        request.httpBody = Data()
        request.setValue(apiKey, forHTTPHeaderField: "x-api-key")
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        // A completion-handler task rather than `data(for:)`, which Linux Foundation lacks (the
        // file is checked there). The session delegate still decides redirects for it.
        return await withCheckedContinuation { continuation in
            let task = session.dataTask(with: request) { data, response, error in
                if error != nil {
                    continuation.resume(returning: DeviceTokenHTTPResponse(status: nil, body: nil))
                } else {
                    continuation.resume(
                        returning: DeviceTokenHTTPResponse(status: (response as? HTTPURLResponse)?.statusCode, body: data)
                    )
                }
            }
            task.resume()
        }
    }

    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        completionHandler(nil)
    }
}

/// Trades the stored device key for access tokens, keeps the current one, and shares one request
/// between callers that ask at the same time. Never logs the key or a token.
actor DeviceAccessTokenBroker {
    /// A cached token is handed out until this long before it expires.
    static let refreshMargin: TimeInterval = 60
    /// Longest lifetime believed, whatever the server says.
    static let maxLifetime: TimeInterval = 3600
    static let maxTokenLength = 4096

    private enum Outcome: Sendable {
        case ok(token: String, expiresAt: Date)
        case revoked
        case legacy
        case unreachable
    }

    private struct Cached {
        let apiKey: String
        let origin: String
        let token: String
        let expiresAt: Date
    }

    private struct InFlight {
        let id: UUID
        let apiKey: String
        let origin: String
        let task: Task<Outcome, Never>
    }

    private let readCredentials: @Sendable () throws -> DeviceCredentials
    private let transport: DeviceTokenTransport
    private let now: @Sendable () -> Date

    private var cached: Cached?
    private var inFlight: InFlight?

    init(
        readCredentials: @escaping @Sendable () throws -> DeviceCredentials,
        transport: DeviceTokenTransport,
        now: @escaping @Sendable () -> Date = { Date() }
    ) {
        self.readCredentials = readCredentials
        self.transport = transport
        self.now = now
    }

    /// Forget the cached token. The cache is keyed by key and origin, so a changed key or origin
    /// never gets the old token anyway; this is for a sign-out, where none should linger.
    func invalidate() {
        cached = nil
    }

    func token(refresh: Bool) async -> DeviceAccessTokenResult {
        let credentials: DeviceCredentials
        do {
            credentials = try readCredentials()
        } catch {
            // The Keychain would not answer (before the first unlock, say). The key is not known to
            // be gone, so this is not a sign-out.
            return DeviceAccessTokenResult(status: .unreachable, token: nil, expiresAt: nil, keyId: nil, ownerStamp: nil)
        }

        guard let apiKey = credentials.apiKey, !apiKey.isEmpty else {
            cached = nil
            return .signedOut
        }
        let keyId = credentials.keyId.flatMap { $0.isEmpty ? nil : $0 }
        guard let origin = DeviceOrigin.normalized(credentials.baseUrl), let url = DeviceOrigin.tokenURL(origin) else {
            return DeviceAccessTokenResult(status: .unreachable, token: nil, expiresAt: nil, keyId: keyId, ownerStamp: nil)
        }
        let stamp = OutboxOwnerStamp.of(origin: origin, apiKey: apiKey)

        if !refresh, let current = cached, current.apiKey == apiKey, current.origin == origin,
           current.expiresAt.timeIntervalSince(now()) > Self.refreshMargin {
            return Self.okResult(current.token, current.expiresAt, keyId: keyId, stamp: stamp)
        }

        let outcome: Outcome
        if let pending = inFlight, pending.apiKey == apiKey, pending.origin == origin {
            outcome = await pending.task.value
        } else {
            let id = UUID()
            let transport = self.transport
            let clock = self.now
            let task = Task { await Self.request(url: url, apiKey: apiKey, transport: transport, now: clock) }
            inFlight = InFlight(id: id, apiKey: apiKey, origin: origin, task: task)
            outcome = await task.value
            if inFlight?.id == id {
                inFlight = nil
            }
        }

        switch outcome {
        case let .ok(token, expiresAt):
            cached = Cached(apiKey: apiKey, origin: origin, token: token, expiresAt: expiresAt)
            return Self.okResult(token, expiresAt, keyId: keyId, stamp: stamp)
        case .revoked:
            cached = nil
            return DeviceAccessTokenResult(status: .revoked, token: nil, expiresAt: nil, keyId: keyId, ownerStamp: stamp)
        case .legacy:
            return DeviceAccessTokenResult(status: .legacy, token: apiKey, expiresAt: nil, keyId: keyId, ownerStamp: stamp)
        case .unreachable:
            return DeviceAccessTokenResult(status: .unreachable, token: nil, expiresAt: nil, keyId: keyId, ownerStamp: stamp)
        }
    }

    private static func okResult(_ token: String, _ expiresAt: Date, keyId: String?, stamp: String) -> DeviceAccessTokenResult {
        DeviceAccessTokenResult(
            status: .ok,
            token: token,
            expiresAt: (expiresAt.timeIntervalSince1970 * 1000).rounded(),
            keyId: keyId,
            ownerStamp: stamp
        )
    }

    private static func request(
        url: URL,
        apiKey: String,
        transport: DeviceTokenTransport,
        now: @Sendable () -> Date
    ) async -> Outcome {
        let response = await transport.post(url: url, apiKey: apiKey)
        guard let status = response.status else {
            return .unreachable
        }
        switch status {
        case 200:
            guard let body = response.body, let parsed = parse(body) else {
                return .unreachable
            }
            return .ok(token: parsed.token, expiresAt: now().addingTimeInterval(min(parsed.expiresIn, maxLifetime)))
        case 401, 403:
            return .revoked
        case 404:
            return .legacy
        default:
            return .unreachable
        }
    }

    /// `{ token, expiresIn }` from the body: a JWS-alphabet token of at most `maxTokenLength`
    /// characters (it goes into a header on the page's side), and a positive lifetime.
    static func parse(_ body: Data) -> (token: String, expiresIn: TimeInterval)? {
        guard let object = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any],
              let token = object["token"] as? String,
              !token.isEmpty,
              token.count <= maxTokenLength,
              token.unicodeScalars.allSatisfy(isTokenScalar) else {
            return nil
        }
        let expiresIn: Double
        if let value = object["expiresIn"] as? Double {
            expiresIn = value
        } else if let value = object["expiresIn"] as? Int {
            expiresIn = Double(value)
        } else {
            return nil
        }
        guard expiresIn.isFinite, expiresIn > 0 else {
            return nil
        }
        return (token, expiresIn)
    }

    private static func isTokenScalar(_ scalar: Unicode.Scalar) -> Bool {
        switch scalar {
        case "A"..."Z", "a"..."z", "0"..."9", "-", "_", ".":
            return true
        default:
            return false
        }
    }
}
