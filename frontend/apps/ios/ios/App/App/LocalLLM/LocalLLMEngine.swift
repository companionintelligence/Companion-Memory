import Foundation

enum LocalLLMEngineError: Error, LocalizedError {
  case notLoaded
  case invalidRequest(String)
  case thermallyThrottled

  var errorDescription: String? {
    switch self {
    case .notLoaded: return "No model loaded"
    case .invalidRequest(let details): return "Invalid request: \(details)"
    case .thermallyThrottled:
      return "Device is thermally throttled; declining to start on-device inference"
    }
  }
}

/// Wraps a single LiteRT-LM `Engine`/`Conversation` pair.
///
/// The `Conversation` is created once, in `load()`, and reused for every `streamCompletion()`
/// call until the next `load()`/`unload()` — matching the Android engine (`LocalLlmEngine.kt`),
/// which keeps its `Conversation` alive the same way. Turn history therefore accumulates inside
/// LiteRT-LM's own native conversation state; this file does not replay history itself.
///
/// A prior version created a fresh `Conversation` per call, seeded from a `turns` array whose
/// `initialMessages` was always empty because the plugin only ever passed a single user turn —
/// so iOS had no multi-turn memory at all while Android did, silently. Recreating a `Conversation`
/// per call also meant tools had to be re-attached per call even though LiteRT-LM fixes them at
/// creation time; both problems share the same fix.
actor LocalLLMEngine {
  private var engine: Engine?
  private var conversation: Conversation?
  private var isGenerating = false

  private(set) var modelPath: String?

  var isLoaded: Bool { engine != nil }

  /// Loads `modelPath` and creates the single `Conversation` reused by every subsequent
  /// `streamCompletion()` call. `tools` are fixed here, not per-call — see the type doc.
  /// Native init can take several seconds (per LiteRT-LM's own docs).
  func load(modelPath: String, maxTokens: Int? = nil, tools: [any Tool] = []) async throws {
    unloadSync()

    Self.applyExperimentalFlags()

    let config = try EngineConfig(modelPath: modelPath, backend: .cpu(), maxNumTokens: maxTokens)
    let newEngine = Engine(engineConfig: config)
    try await newEngine.initialize()

    let systemMessage = tools.isEmpty ? nil : Message(Self.toolSystemInstruction, role: .system)
    let newConversation = try await newEngine.createConversation(
      with: ConversationConfig(systemMessage: systemMessage, tools: tools))

    self.engine = newEngine
    self.conversation = newConversation
    self.modelPath = modelPath
  }

  func unload() {
    conversation = nil
    isGenerating = false
    unloadSync()
  }

  /// Cancels the in-flight generation, if any. Safe to call with nothing in flight.
  func cancel() {
    guard isGenerating else { return }
    try? conversation?.cancel()
  }

  private func unloadSync() {
    engine = nil
    modelPath = nil
  }

  /// Streams the assistant's reply to `prompt` as text deltas, on the persistent conversation
  /// created by `load()`.
  ///
  /// LiteRT-LM's streamed `Message`s are not documented as strictly delta-only across
  /// engine versions, so each emission is diffed against the running total rather than
  /// assumed to be an incremental chunk — correct whether the SDK yields deltas or
  /// cumulative text.
  func streamCompletion(prompt: String) throws -> AsyncThrowingStream<String, Error> {
    guard conversation != nil else {
      throw LocalLLMEngineError.notLoaded
    }
    guard Self.thermalState != .critical else {
      throw LocalLLMEngineError.thermallyThrottled
    }

    return AsyncThrowingStream { continuation in
      Task {
        // Re-fetched inside the task (rather than capturing the `guard`'s local above) so every
        // actor-isolated access here goes through an explicit `await`, matching how the rest of
        // this file crosses the actor boundary from an unstructured `Task`.
        guard let conversation = await self.beginGenerating() else {
          continuation.finish(throwing: LocalLLMEngineError.notLoaded)
          return
        }
        let thermalObserver = await self.installThermalCutoff()

        do {
          var previousVisible = ""
          // Passed the same way Android's engine passes `enable_thinking: false` per message —
          // Qwen3's chat template defaults reasoning ON, and neither platform's ConversationConfig
          // exposes a load-time knob for it. `strippingThinking` below stays as a defensive
          // fallback in case a future model's template does not honor this context key.
          for try await message in conversation.sendMessageStream(
            Message(prompt), extraContext: ["enable_thinking": false])
          {
            let visible = Self.strippingThinking(message.toString)
            let delta =
              visible.hasPrefix(previousVisible)
              ? String(visible.dropFirst(previousVisible.count)) : visible
            previousVisible = visible
            if !delta.isEmpty {
              continuation.yield(delta)
            }
          }
          continuation.finish()
        } catch {
          continuation.finish(throwing: error)
        }

        await self.endGenerating(removing: thermalObserver)
      }
    }
  }

  /// Marks generation in flight and returns the current conversation, if still loaded — `nil`
  /// if `unload()` raced this call between `streamCompletion`'s initial check and the task
  /// actually starting.
  private func beginGenerating() -> Conversation? {
    guard let conversation else { return nil }
    isGenerating = true
    return conversation
  }

  private func endGenerating(removing observer: NSObjectProtocol?) {
    isGenerating = false
    if let observer {
      NotificationCenter.default.removeObserver(observer)
    }
  }

  /// Cancels the in-flight generation the moment the device crosses `.critical` mid-stream,
  /// rather than only refusing to *start* a new one — mirrors the Android engine's
  /// `PowerManager` thermal-status listener. A short answer is a better outcome than one this
  /// device's thermal governor was going to throttle or terminate anyway (per doc 01,
  /// "Competitive Landscape, Offline and Local Mobile AI" §5: iOS enforces a hard GPU
  /// frequency floor in the `.critical` state that can end inference outright).
  private func installThermalCutoff() -> NSObjectProtocol {
    NotificationCenter.default.addObserver(
      forName: ProcessInfo.thermalStateDidChangeNotification, object: nil, queue: nil
    ) { _ in
      guard ProcessInfo.processInfo.thermalState == .critical else { return }
      Task { await self.cancel() }
    }
  }

  private static var thermalState: ProcessInfo.ThermalState { ProcessInfo.processInfo.thermalState }

  /// Removes `<think>…</think>` reasoning from model output, including an unterminated trailing
  /// block mid-stream.
  ///
  /// Qwen3's chat template gates reasoning on `{%- if not enable_thinking|default(true) %}`, and
  /// `streamCompletion` now passes `enable_thinking: false` as per-message `extraContext` (the
  /// same mechanism Android's engine already used) — this stays as a defensive fallback in case
  /// that context key is ever ignored by a future model's template, not as the primary mechanism.
  /// Dropping the open-ended tail matters: without it the user watches raw chain-of-thought stream
  /// in until the closing tag finally arrives.
  static func strippingThinking(_ text: String) -> String {
    guard text.contains("<think>") else { return text }

    var output = ""
    var rest = Substring(text)

    while let open = rest.range(of: "<think>") {
      output += rest[rest.startIndex..<open.lowerBound]

      guard let close = rest.range(of: "</think>", range: open.upperBound..<rest.endIndex) else {
        // Unterminated: the model is still reasoning. Everything after the tag is hidden until it closes.
        return output.trimmingCharacters(in: .whitespacesAndNewlines)
      }

      rest = rest[close.upperBound...]
    }

    output += rest

    return output.trimmingCharacters(in: .whitespacesAndNewlines)
  }

  /// Turns on LiteRT-LM's experimental flags exactly once. Only
  /// `enableConversationConstrainedDecoding` is ever set to non-default, and it stays `false`
  /// (Google's own default) even though it is the mechanism most likely to fix the tool-calling
  /// reliability risk this harness currently carries — see `ENABLE_EXPERIMENTAL_CONSTRAINED_DECODING`.
  private static let applyExperimentalFlagsOnce: Void = {
    ExperimentalFlags.optIntoExperimentalAPIs()
    ExperimentalFlags.enableConversationConstrainedDecoding = enableExperimentalConstrainedDecoding
  }()

  private static func applyExperimentalFlags() { _ = applyExperimentalFlagsOnce }

  /// LiteRT-LM's own grammar/constrained-decoding path for tool calls, "primarily used for
  /// function calling" per its doc comment — and, per doc 01 ("Competitive Landscape, Offline
  /// and Local Mobile AI" §3), the mechanism most likely to fix the exact failure mode this
  /// harness currently risks: tool-call parsing here rides the model's chat-template
  /// `<tool_call>` markup with no constrained-decoding safety net.
  ///
  /// Left OFF by default even so: it is Google's own "experimental" surface, gated behind
  /// `optIntoExperimentalAPIs()` specifically because it may still change. As of this change no
  /// commit in this project's history reports a completed real-device inference run at all —
  /// turning on an unverified native decoding path on top of an unverified baseline is not a
  /// change to make blind. Flip this to `true` once someone can actually run a physical device
  /// (the iOS Simulator is a confirmed-broken environment for LiteRT-LM) and confirm tool calls
  /// still parse correctly.
  private static let enableExperimentalConstrainedDecoding = false

  private static let toolSystemInstruction =
    "You are Companion, answering questions about the user's own memory on their device. "
    + "Use the provided tools to look things up rather than guessing, and cite what you found. "
    + "If a tool reports an error or says an action must be confirmed on the appliance, tell the "
    + "user plainly instead of pretending it succeeded."
}
