import CLiteRTLM
import Foundation

/// One engine and one conversation, opened the way `LocalLLMEngine.performLoad` opens them — same
/// `EngineConfig`, same `ConversationConfig`, same stream loop and `ReplyAssembler` — but with the
/// things an experiment varies exposed: the sampler seed, the system text, thinking on the tool
/// continuation, a per-request output cap, and read access to the KV-cache count and the tokenizer.
///
/// It exists because `LocalLLMEngine` keeps all of that private, and because an experiment needs to
/// flip knobs production has no reason to expose. The end-to-end check of whatever the experiments
/// choose goes through `LocalLLMEngine` itself (`BenchRunner`, mode `prod`).
actor RawSession {
  struct ConversationSpec {
    var topK: Int
    var topP: Float
    var temperature: Float
    var seed: Int
    var tools: [any Tool]
    var system: String?
    var constrained = false
  }

  struct Turn {
    var answer = ""
    var thought = ""
    /// Every chunk's text and `thought` channel, concatenated before `ReplyAssembler` touches them.
    var raw = ""
    var rawThought = ""
    var chunks = 0
    var totalMs = 0
    var firstChunkMs: Int?
    var error: String?
    var kvBefore: Int?
    var kvAfter: Int?
    /// Uptime of each non-empty chunk, for the phase timings.
    var chunkTimes: [Double] = []
    var startedAt: Double = 0
  }

  let engine: Engine
  let accelerator: LocalLLMAccelerator
  let maxTokens: Int
  let loadSeconds: Double

  private var conversation: Conversation?

  private static let optedIn: Void = {
    ExperimentalFlags.optIntoExperimentalAPIs()
    // Google's default, and what the app ships: see `LocalLLMEngine.enableExperimentalConstrainedDecoding`.
    ExperimentalFlags.enableConversationConstrainedDecoding = false
  }()

  private init(engine: Engine, accelerator: LocalLLMAccelerator, maxTokens: Int, loadSeconds: Double) {
    self.engine = engine
    self.accelerator = accelerator
    self.maxTokens = maxTokens
    self.loadSeconds = loadSeconds
  }

  static func open(
    path: String, accelerator: LocalLLMAccelerator, maxTokens: Int, prefillChunk: Int? = nil,
    threads: Int? = nil
  ) async throws -> RawSession {
    _ = optedIn

    let backend: Backend = accelerator == .gpu ? .gpu : .cpu()
    let config = try EngineConfig(
      modelPath: path, backend: backend, maxNumTokens: maxTokens, prefillChunkSize: prefillChunk,
      numThreads: threads)
    let engine = Engine(engineConfig: config)
    let started = ProcessInfo.processInfo.systemUptime

    try await engine.initialize()

    return RawSession(
      engine: engine, accelerator: accelerator, maxTokens: maxTokens,
      loadSeconds: ProcessInfo.processInfo.systemUptime - started)
  }

  /// Replaces the conversation. The old one is released first: an engine hands out one at a time.
  func begin(_ spec: ConversationSpec) async throws {
    conversation = nil
    // Read by `createConversation`, so it has to be in place before it.
    ExperimentalFlags.enableConversationConstrainedDecoding = spec.constrained

    let sampler = try SamplerConfig(
      topK: spec.topK, topP: spec.topP, temperature: spec.temperature, seed: spec.seed)
    let system = spec.system.map { Message($0, role: .system) }
    let config = ConversationConfig(systemMessage: system, tools: spec.tools, samplerConfig: sampler)

    conversation = try await engine.createConversation(with: config)
  }

  func end() { conversation = nil }

  // MARK: Reading the runtime

  /// Tokens the conversation holds in its KV cache (prefill + decode), straight from the runtime.
  func kvTokens() -> Int? {
    guard let conversation, let count = try? conversation.getTokenCount(), count >= 0 else { return nil }

    return count
  }

  func tokens(of text: String) async -> Int? { await engine.tokenCount(of: text) }

  func preface() -> String? { try? conversation?.renderPrefaceIntoString() }

  /// Runs one message through the chat template and returns the text it becomes. `Message` cannot
  /// express a `tool_response` or a tool call, so this reaches the C entry point with the
  /// conversation's own handle.
  func render(_ message: [String: Any]) -> String? {
    guard
      let conversation,
      let handle = Mirror(reflecting: conversation).children
        .first(where: { $0.label == "handle" })?.value as? OpaquePointer,
      let data = try? JSONSerialization.data(withJSONObject: message),
      let json = String(data: data, encoding: .utf8),
      let rendered = litert_lm_conversation_render_message_to_string(handle, json)
    else { return nil }

    return String(cString: rendered)
  }

  /// How a tool's answer is rendered into the prompt: the message `Conversation.handleToolCalls`
  /// builds. `response` is a String (the app today) or a parsed JSON value.
  func renderToolMessage(name: String, response: Any) -> String? {
    render([
      "role": "tool",
      "content": [["type": "tool_response", "name": name, "response": response]],
    ])
  }

  // MARK: One request

  /// Sends `prompt` and drains the stream, assembling the reply the way the plugin does.
  func turn(
    prompt: String, thinking: Bool, carryContext: Bool, maxReplyTokens: Int?
  ) async -> Turn {
    var turn = Turn()
    turn.kvBefore = kvTokens()
    turn.startedAt = ProcessInfo.processInfo.systemUptime

    guard let conversation else {
      turn.error = "no conversation"

      return turn
    }

    var assembler = ReplyAssembler(enableThinking: thinking)

    do {
      let stream = conversation.sendMessageStream(
        Message(prompt), extraContext: ["enable_thinking": thinking],
        maxOutputTokens: maxReplyTokens, carryContextThroughToolCalls: carryContext)

      for try await message in stream {
        let text = message.toString
        let thought = message.channels[LocalLLMEngine.thoughtChannel] ?? ""

        if !text.isEmpty || !thought.isEmpty {
          let now = ProcessInfo.processInfo.systemUptime
          turn.chunks += 1
          turn.chunkTimes.append(now)
          if turn.firstChunkMs == nil { turn.firstChunkMs = Int((now - turn.startedAt) * 1000) }
        }

        turn.raw += text
        turn.rawThought += thought

        let delta = assembler.ingest(text: text, thoughtChannel: thought)
        turn.answer += delta.answer
        turn.thought += delta.thought
      }
    } catch {
      turn.error = GenerationFailure.reason(for: error)
    }

    let tail = assembler.finish()
    turn.answer += tail.answer
    turn.thought += tail.thought
    turn.totalMs = Int((ProcessInfo.processInfo.systemUptime - turn.startedAt) * 1000)
    turn.kvAfter = kvTokens()

    return turn
  }
}
