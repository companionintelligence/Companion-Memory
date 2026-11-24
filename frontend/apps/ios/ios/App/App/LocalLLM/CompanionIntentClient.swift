import Foundation

/// The server's ruling for a tier. Mirrors `DispatchRuling` in `dispatchPolicy.ts`.
struct DispatchRuling: Decodable {
  let decision: String
  let reason: String
  let explanation: String

  var isExecutable: Bool { decision == "execute" }
}

/// One intent as published by `GET /api/intents?tier=local`.
///
/// Deliberately carries no `localCapable`/`privacy` mirror and re-derives no policy: the server is
/// asked for `tier=local` and returns its own `dispatch` ruling, which this client obeys.
/// `dispatchPolicy.ts` is explicit about why — "two copies of a security rule are two rules".
struct ManifestIntent: Decodable {
  let name: String
  /// Executable name (dots → underscores) — what MCP `tools/call` expects.
  let tool: String
  let title: String
  let description: String
  let dispatch: DispatchRuling?
}

struct IntentManifest: Decodable {
  let version: String
  let tier: String?
  let intents: [ManifestIntent]
}

/// Named `IntentToolError`, not `CompanionIntentError`: the App Intents layer
/// (`CompanionAPI.swift`) already owns that name for its own Siri-facing failures, and shadowing
/// it would make every existing `CompanionIntentError` reference in this target ambiguous.
enum IntentToolError: Error, LocalizedError {
  case notConfigured
  case transport(String)

  var errorDescription: String? {
    switch self {
    case .notConfigured: return "Companion is not configured with a server and API key"
    case .transport(let detail): return detail
    }
  }
}

/// Talks to CI-Server on behalf of the on-device model: reads the intent catalog, and executes an
/// intent when the model calls one. The Swift twin of the Android `CompanionIntentClient`.
///
/// Two server facts are baked in here rather than left to callers:
///
/// 1. **The catalog is `<base>/api/intents` — one `/api`, like `<base>/api/mcp`.** The fronting proxy
///    strips a leading `/api`, and both `IntentsController` (`@Controller(['intents', 'agent/intents'])`)
///    and `McpController` (`@Controller('mcp')`) mount at bare paths. This client used to ask for
///    `/api/api/intents`, which only worked while the controller baked its own `api/` into its mount
///    (removed in #2653); on a current appliance that is a 404 and `refreshRulings` quietly returns no
///    tools, so the model answers from its weights alone. An appliance older than #2653 is the mirror
///    case: it only serves the doubled path, and reads as toolless the same graceful way.
/// 2. **There is no REST "execute this intent" endpoint.** The only wire protocol for "run intent X
///    with args Y" is MCP `tools/call` over `POST /mcp` — JSON-RPC, preceded by an `initialize`
///    handshake whose `Mcp-Session-Id` must be echoed on every later call. Managed transparently below.
///
/// Auth is the same `x-api-key` header `CompanionAPI` already uses for App Intents: no cookies, no
/// CSRF, so it works with no WebView involved.
actor CompanionIntentClient {
  private let baseURL: URL
  private let apiKey: String
  private let session: URLSession

  private var sessionId: String?
  private var nextRequestId = 1

  init(baseURL: URL, apiKey: String) {
    self.baseURL = baseURL
    self.apiKey = apiKey

    let configuration = URLSessionConfiguration.ephemeral
    configuration.timeoutIntervalForRequest = 30
    self.session = URLSession(configuration: configuration)
  }

  /// Reads the catalog with the server's own rulings for the on-device tier attached.
  func fetchManifest() async throws -> IntentManifest {
    var request = authorized(path: "/api/intents", query: "tier=local")
    request.httpMethod = "GET"

    let (data, response) = try await session.data(for: request)
    try ensureOK(response, data)

    return try JSONDecoder().decode(IntentManifest.self, from: data)
  }

  /// Runs `toolName` with `arguments` via MCP and returns the tool's text result.
  ///
  /// Re-handshakes once on a 404 — how the server reports an expired or unknown session (they are
  /// reaped after 30 minutes idle). Without that retry the first tool call after a pause would
  /// surface to the model as a hard failure.
  func callTool(_ toolName: String, arguments: [String: Any]) async throws -> String {
    do {
      return try await callToolOnce(toolName, arguments: arguments)
    } catch IntentToolError.transport(let detail) where detail == Self.sessionExpiredMarker {
      sessionId = nil

      return try await callToolOnce(toolName, arguments: arguments)
    }
  }

  private func callToolOnce(_ toolName: String, arguments: [String: Any]) async throws -> String {
    let session = try await currentSession()
    let payload = jsonRpc("tools/call", params: ["name": toolName, "arguments": arguments])
    let json = try await postJsonRpc(payload, sessionId: session)

    return try extractToolText(json)
  }

  private func currentSession() async throws -> String {
    if let sessionId { return sessionId }

    let payload = jsonRpc(
      "initialize",
      params: [
        "protocolVersion": Self.mcpProtocolVersion,
        "capabilities": [:] as [String: Any],
        "clientInfo": ["name": "companion-on-device-llm", "version": "1.0.0"],
      ])

    var request = authorized(path: "/api/mcp")
    request.httpBody = try JSONSerialization.data(withJSONObject: payload)

    let (data, response) = try await self.session.data(for: request)
    try ensureOK(response, data)

    guard
      let http = response as? HTTPURLResponse,
      // Case-insensitive: header casing is not guaranteed across proxies.
      let id = http.allHeaderFields.first(where: {
        ($0.key as? String)?.caseInsensitiveCompare(Self.mcpSessionHeader) == .orderedSame
      })?.value as? String
    else {
      throw IntentToolError.transport("MCP initialize returned no \(Self.mcpSessionHeader) header")
    }

    sessionId = id

    return id
  }

  private func postJsonRpc(_ payload: [String: Any], sessionId: String) async throws -> [String: Any] {
    var request = authorized(path: "/api/mcp")
    request.setValue(sessionId, forHTTPHeaderField: Self.mcpSessionHeader)
    request.httpBody = try JSONSerialization.data(withJSONObject: payload)

    let (data, response) = try await session.data(for: request)

    if let http = response as? HTTPURLResponse, http.statusCode == 404 {
      throw IntentToolError.transport(Self.sessionExpiredMarker)
    }
    try ensureOK(response, data)

    return try parseMaybeSSE(data)
  }

  /// The MCP endpoint is Streamable HTTP: a response may be plain JSON or an SSE stream whose
  /// `data:` lines carry the JSON-RPC frames. Handle both rather than assuming the simpler mode.
  private func parseMaybeSSE(_ data: Data) throws -> [String: Any] {
    let text = String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)

    if text.hasPrefix("{"), let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] {
      return json
    }

    let frame = text
      .split(separator: "\n")
      .compactMap { line -> String? in
        guard line.hasPrefix("data:") else { return nil }

        return line.dropFirst("data:".count).trimmingCharacters(in: .whitespaces)
      }
      .last(where: { $0.hasPrefix("{") })

    guard
      let frame,
      let json = try JSONSerialization.jsonObject(with: Data(frame.utf8)) as? [String: Any]
    else {
      throw IntentToolError.transport("MCP response was neither JSON nor an SSE frame")
    }

    return json
  }

  /// Pulls the concatenated `content[].text` out of an MCP `CallToolResult`, surfacing errors.
  private func extractToolText(_ json: [String: Any]) throws -> String {
    if let error = json["error"] as? [String: Any] {
      let message = error["message"] as? String ?? "unknown MCP error"

      throw IntentToolError.transport("Intent failed: \(message)")
    }

    guard let result = json["result"] as? [String: Any] else {
      return String(describing: json)
    }
    guard let content = result["content"] as? [[String: Any]] else {
      return String(describing: result)
    }

    let text = content.compactMap { $0["text"] as? String }.joined()

    // `isError` marks a tool-level failure whose message is already in `text`; hand it back as
    // content rather than throwing, so the model can explain it or try a different intent.
    return text.isEmpty ? String(describing: result) : text
  }

  private func authorized(path: String, query: String? = nil) -> URLRequest {
    var components = URLComponents(
      url: baseURL.appendingPathComponent(path), resolvingAgainstBaseURL: false)
    components?.query = query

    var request = URLRequest(url: components?.url ?? baseURL.appendingPathComponent(path))
    request.httpMethod = "POST"
    request.setValue(apiKey, forHTTPHeaderField: "x-api-key")
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue("application/json, text/event-stream", forHTTPHeaderField: "Accept")

    return request
  }

  private func ensureOK(_ response: URLResponse, _ data: Data) throws {
    guard let http = response as? HTTPURLResponse else { return }

    guard (200..<300).contains(http.statusCode) else {
      let detail = String(decoding: data, as: UTF8.self).prefix(200)

      throw IntentToolError.transport("Companion returned HTTP \(http.statusCode). \(detail)")
    }
  }

  private func jsonRpc(_ method: String, params: [String: Any]) -> [String: Any] {
    defer { nextRequestId += 1 }

    return ["jsonrpc": "2.0", "id": nextRequestId, "method": method, "params": params]
  }

  private static let mcpSessionHeader = "Mcp-Session-Id"
  private static let mcpProtocolVersion = "2025-03-26"
  /// Internal sentinel so the 404 retry is not confused with a genuine transport failure.
  private static let sessionExpiredMarker = "__mcp_session_expired__"
}
