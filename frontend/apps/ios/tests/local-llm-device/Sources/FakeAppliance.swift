import Foundation
import Network

/// A stand-in for CI-Server on the loopback interface, so the REAL `CompanionIntentClient` and the
/// real tools run on the phone against a corpus the bench controls.
///
/// A `URLProtocol` would be simpler but does not work: the client's `URLSessionConfiguration.ephemeral`
/// session ignores globally registered protocol classes. A listener bound to loopback needs no network
/// permission (loopback is exempt from the local-network prompt) and no ATS exception for an IP literal.
///
/// It speaks only what the client uses: `GET /api/intents?tier=local`, and `POST /api/mcp` for
/// `initialize` and `tools/call`.
final class FakeAppliance: @unchecked Sendable {
  static let shared = FakeAppliance()

  /// Answers a `tools/call`: the tool's name and arguments in, the text of the MCP result out.
  var handler: (@Sendable (String, [String: Any]) async -> String)?

  private let queue = DispatchQueue(label: "bench.fake-appliance")
  private var listener: NWListener?
  private var port: UInt16 = 0

  var baseURL: URL { URL(string: "http://127.0.0.1:\(port)")! }

  func start() async throws {
    guard port == 0 else { return }

    let parameters = NWParameters.tcp
    parameters.requiredInterfaceType = .loopback

    let listener = try NWListener(using: parameters, on: .any)
    listener.newConnectionHandler = { [weak self] connection in self?.accept(connection) }

    try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
      let once = Once()

      listener.stateUpdateHandler = { state in
        switch state {
        case .ready:
          if once.first() { continuation.resume() }
        case .failed(let error):
          if once.first() { continuation.resume(throwing: error) }
        default:
          break
        }
      }
      listener.start(queue: queue)
    }

    self.listener = listener
    port = listener.port?.rawValue ?? 0
  }

  // MARK: HTTP

  private struct Request {
    let method: String
    let path: String
    let body: Data
  }

  private func accept(_ connection: NWConnection) {
    connection.start(queue: queue)
    receive(on: connection, buffer: Data())
  }

  private func receive(on connection: NWConnection, buffer: Data) {
    connection.receive(minimumIncompleteLength: 1, maximumLength: 1 << 16) {
      [weak self] data, _, isComplete, error in
      guard let self else { return }

      var buffer = buffer
      if let data { buffer.append(data) }

      if let request = Self.parse(buffer) {
        Task { await self.respond(to: request, on: connection) }
      } else if isComplete || error != nil {
        connection.cancel()
      } else {
        self.receive(on: connection, buffer: buffer)
      }
    }
  }

  /// A request once its headers and the whole body have arrived; nil until then.
  private static func parse(_ data: Data) -> Request? {
    guard let split = data.range(of: Data("\r\n\r\n".utf8)) else { return nil }

    let head = String(decoding: data[..<split.lowerBound], as: UTF8.self)
    let lines = head.components(separatedBy: "\r\n")
    let words = (lines.first ?? "").split(separator: " ")

    guard words.count >= 2 else { return nil }

    var length = 0

    for line in lines.dropFirst() {
      let parts = line.split(separator: ":", maxSplits: 1)
      if parts.count == 2, parts[0].lowercased() == "content-length" {
        length = Int(parts[1].trimmingCharacters(in: .whitespaces)) ?? 0
      }
    }

    let body = data[split.upperBound...]
    guard body.count >= length else { return nil }

    return Request(method: String(words[0]), path: String(words[1]), body: Data(body.prefix(length)))
  }

  private func respond(to request: Request, on connection: NWConnection) async {
    var headers: [String: String] = [:]
    var body = "{}"
    var status = "200 OK"

    if request.method == "GET", request.path.hasPrefix("/api/intents") {
      body = Self.manifest
    } else if request.method == "POST", request.path.hasPrefix("/api/mcp") {
      (body, headers) = await handleRpc(request.body)
    } else {
      status = "404 Not Found"
    }

    var head = "HTTP/1.1 \(status)\r\nContent-Type: application/json\r\nConnection: close\r\n"
    for (key, value) in headers { head += "\(key): \(value)\r\n" }
    let payload = Data(body.utf8)
    head += "Content-Length: \(payload.count)\r\n\r\n"

    connection.send(
      content: Data(head.utf8) + payload, contentContext: .finalMessage, isComplete: true,
      completion: .contentProcessed { _ in connection.cancel() })
  }

  private func handleRpc(_ data: Data) async -> (String, [String: String]) {
    guard
      let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let method = json["method"] as? String
    else { return ("{}", [:]) }

    let id = json["id"] ?? NSNull()
    let params = json["params"] as? [String: Any] ?? [:]

    switch method {
    case "initialize":
      let result: [String: Any] = [
        "protocolVersion": "2025-03-26", "capabilities": [:] as [String: Any],
        "serverInfo": ["name": "bench-appliance", "version": "1"],
      ]

      return (Self.rpc(id: id, result: result), ["Mcp-Session-Id": "bench-session"])
    case "tools/call":
      let name = params["name"] as? String ?? ""
      let arguments = params["arguments"] as? [String: Any] ?? [:]
      let text = await handler?(name, arguments) ?? "{}"
      let result: [String: Any] = ["content": [["type": "text", "text": text]]]

      return (Self.rpc(id: id, result: result), [:])
    default:
      return (Self.rpc(id: id, result: [:] as [String: Any]), [:])
    }
  }

  private static func rpc(id: Any, result: [String: Any]) -> String {
    let envelope: [String: Any] = ["jsonrpc": "2.0", "id": id, "result": result]
    let data = (try? JSONSerialization.data(withJSONObject: envelope)) ?? Data()

    return String(decoding: data, as: UTF8.self)
  }

  /// The `tier=local` catalog, with the server's ruling attached: the three tools the app binds are
  /// all `execute` on this tier, exactly as the real appliance rules.
  private static let manifest: String = {
    func intent(_ name: String, _ tool: String, _ title: String) -> [String: Any] {
      [
        "name": name, "tool": tool, "title": title, "description": title,
        "dispatch": [
          "decision": "execute", "reason": "local-capable",
          "explanation": "Runs on this device's tier.",
        ],
      ]
    }

    let catalog: [String: Any] = [
      "version": "bench", "tier": "local",
      "intents": [
        intent("knowledge.search", "knowledge_search", "Search everything"),
        intent("memory.recall", "memory_recall", "Recall"),
        intent("people.find", "people_find", "Find people"),
      ],
    ]

    return String(decoding: (try? JSONSerialization.data(withJSONObject: catalog)) ?? Data(), as: UTF8.self)
  }()
}

/// True the first time it is asked, so a continuation is resumed exactly once.
private final class Once: @unchecked Sendable {
  private let lock = NSLock()
  private var used = false

  func first() -> Bool {
    lock.lock()
    defer { lock.unlock() }
    guard !used else { return false }
    used = true

    return true
  }
}
