import Foundation

// Pure pieces of a streamed generation: turning LiteRT-LM's message chunks into answer/reasoning
// text, and timing them. Kept free of the engine, Capacitor and UIKit so they can be checked
// without a device or a model (the Simulator cannot run LiteRT-LM inference at all).

// MARK: - Stats

/// Decode-speed numbers for one generation — the JS `GenerationStats` shape.
struct GenerationStats: Equatable {
  /// Milliseconds from the request until the first chunk arrived.
  let timeToFirstTokenMs: Int
  /// Milliseconds from the request until the last chunk.
  let totalMs: Int
  let outputTokens: Int
  /// Tokens per second across the decode phase — everything after the first token.
  let decodeTokensPerSecond: Double
  /// Always `true` on iOS: see ``GenerationStatsTracker``.
  let tokensEstimated: Bool

  var asDictionary: [String: Any] {
    [
      "timeToFirstTokenMs": timeToFirstTokenMs,
      "totalMs": totalMs,
      "outputTokens": outputTokens,
      "decodeTokensPerSecond": decodeTokensPerSecond,
      "tokensEstimated": tokensEstimated,
    ]
  }
}

/// Times a generation from its chunks.
///
/// **Why chunks, not the runtime's numbers.** The vendored `Benchmark.swift` does expose a token
/// count and decode rate, but only through an experimental global flag that must be on *before* the
/// engine is created (it turns benchmarking on for every generation, unverified on a device), and
/// `getBenchmarkInfo()` reports the **last** decode turn only — which, after a tool call, is the
/// short post-tool answer rather than the generation the caller asked about. So this counts the
/// chunks LiteRT-LM streams, one per decode step in practice, and says so with `tokensEstimated`.
///
/// The clock is passed in (`ProcessInfo.systemUptime` in production) so the arithmetic is testable.
struct GenerationStatsTracker {
  private let startedAt: TimeInterval
  private var firstChunkAt: TimeInterval?
  private var lastChunkAt: TimeInterval?
  private(set) var chunkCount = 0

  init(startedAt: TimeInterval) {
    self.startedAt = startedAt
  }

  /// Records one non-empty chunk (answer or reasoning — thinking tokens are tokens).
  mutating func recordChunk(at now: TimeInterval) {
    if firstChunkAt == nil { firstChunkAt = now }
    lastChunkAt = now
    chunkCount += 1
  }

  /// Milliseconds from the request to `now`.
  func elapsedMs(at now: TimeInterval) -> Int {
    Self.milliseconds(now - startedAt)
  }

  /// A generation that produced no chunk reports its whole duration as time-to-first-token and
  /// zero tokens, rather than inventing a rate.
  func finish(at now: TimeInterval) -> GenerationStats {
    guard let first = firstChunkAt, let last = lastChunkAt else {
      let elapsed = Self.milliseconds(now - startedAt)

      return GenerationStats(
        timeToFirstTokenMs: elapsed, totalMs: elapsed, outputTokens: 0,
        decodeTokensPerSecond: 0, tokensEstimated: true)
    }

    let decodeSeconds = last - first
    let decodeTokens = chunkCount - 1
    let rate = (decodeTokens > 0 && decodeSeconds > 0) ? Double(decodeTokens) / decodeSeconds : 0

    return GenerationStats(
      timeToFirstTokenMs: Self.milliseconds(first - startedAt),
      totalMs: Self.milliseconds(last - startedAt),
      outputTokens: chunkCount,
      decodeTokensPerSecond: (rate * 10).rounded() / 10,
      tokensEstimated: true)
  }

  private static func milliseconds(_ seconds: TimeInterval) -> Int {
    Int((max(seconds, 0) * 1000).rounded())
  }
}

// MARK: - Reply assembly

/// Removes chat-template control tokens — `<|im_end|>`, `<|im_start|>`, `<|endoftext|>` and their
/// kin — from model text.
///
/// Those markers belong to the runtime, which stops on an end-of-turn token and hides it. They reach
/// the app as text only when the runtime did not recognise one: on the turn that follows a tool
/// result, Qwen3-0.6B began its reply with a literal `<|endoftext|>`, and the chat bubble read
/// "<|endoftext|>This is a test of the tool…".
///
/// A marker is recognised by its **shape** — `<|`, one to ``maxNameLength`` letters, digits or
/// underscores, `|>` — rather than from a list, so one this file has never heard of (`<|eot_id|>`,
/// `<|end|>`, `<|vision_start|>`) goes too. Prose does not have that shape: Haskell's `<|>` has no
/// name between the bars.
///
/// Like ``ThinkTagSplitter`` it takes the **whole text so far**, so a marker split across chunks
/// (`"<|im_"` then `"end|>"`) is caught however the chunks fall. For that to hold, the result for a
/// prefix is always a prefix of the result for the full text: with `final: false`, a trailing
/// fragment that could still become a marker is held back instead of being shown and retracted.
enum SpecialTokenStripper {
  /// Longest marker name recognised. It also bounds how much text is ever held back.
  static let maxNameLength = 32

  private enum Match {
    /// A complete marker, this many bytes long.
    case marker(length: Int)
    /// The text ends inside something that may still become a marker.
    case partial
    case text
  }

  static func strip(_ text: String, final: Bool) -> String {
    let lessThan = UInt8(ascii: "<")

    // The overwhelmingly common case — no `<` at all — costs one scan and no copy.
    guard text.utf8.contains(lessThan) else { return text }

    // Markers are ASCII and a UTF-8 continuation byte is never ASCII, so scanning bytes cannot cut
    // a character in half: everything is copied through whole, or dropped at a `<`.
    let bytes = Array(text.utf8)
    var kept: [UInt8] = []
    kept.reserveCapacity(bytes.count)
    var index = 0

    while index < bytes.count {
      guard bytes[index] == lessThan else {
        kept.append(bytes[index])
        index += 1

        continue
      }

      switch match(in: bytes, at: index) {
      case .marker(let length):
        index += length
      case .partial:
        // It runs to the end of the text. Held back while the stream goes on; once it is over, what
        // never became a marker is just text.
        if final { kept.append(contentsOf: bytes[index...]) }
        index = bytes.count
      case .text:
        kept.append(bytes[index])
        index += 1
      }
    }

    return String(decoding: kept, as: UTF8.self)
  }

  /// What starts at `start`, which holds a `<`.
  private static func match(in bytes: [UInt8], at start: Int) -> Match {
    var index = start + 1

    guard index < bytes.count else { return .partial }
    guard bytes[index] == UInt8(ascii: "|") else { return .text }
    index += 1

    let nameStart = index
    while index < bytes.count, index - nameStart < maxNameLength, isNameByte(bytes[index]) {
      index += 1
    }

    guard index < bytes.count else { return .partial }
    // No name at all (`<|>`, `<||`), or a name too long to be one, or no closing bar.
    guard index > nameStart, bytes[index] == UInt8(ascii: "|") else { return .text }
    index += 1

    guard index < bytes.count else { return .partial }

    return bytes[index] == UInt8(ascii: ">") ? .marker(length: index + 1 - start) : .text
  }

  private static func isNameByte(_ byte: UInt8) -> Bool {
    (UInt8(ascii: "a")...UInt8(ascii: "z")).contains(byte)
      || (UInt8(ascii: "A")...UInt8(ascii: "Z")).contains(byte)
      || (UInt8(ascii: "0")...UInt8(ascii: "9")).contains(byte)
      || byte == UInt8(ascii: "_")
  }
}

/// Splits reasoning out of text that carries `<think>…</think>` tags.
///
/// This is the *fallback*: a runtime that separates reasoning itself hands it over as the `thought`
/// channel (`Message.channels`), and ``ReplyAssembler`` prefers that. Qwen3 has historically leaked
/// the tags into the text instead, and the user must never watch raw chain-of-thought stream in as
/// if it were the answer — including an unterminated block mid-stream.
enum ThinkTagSplitter {
  static let openTag = "<think>"
  static let closeTag = "</think>"

  struct Split: Equatable {
    var answer = ""
    var thought = ""
  }

  /// Splits the **whole text so far**, so it can be called on every chunk and stay correct however
  /// the tags fall across chunks. For that to hold, the result of a prefix is always a prefix of the
  /// result for the full text:
  ///
  /// - with `final: false`, a trailing fragment that could still turn into a tag (`"<thi"`) is held
  ///   back instead of being emitted as text and retracted later;
  /// - whitespace is dropped only at the *start of the segment after a tag* (Qwen3 puts `"\n"` after
  ///   `<think>` and `"\n\n"` after `</think>`), never from the end.
  static func split(_ text: String, final: Bool) -> Split {
    var result = Split()
    var rest = Substring(text)
    var inThink = false
    var trimLeading = false

    func append(_ segment: Substring) {
      var segment = segment

      if trimLeading {
        segment = segment.drop(while: { $0.isWhitespace })
        // Still only whitespace: keep trimming into the next segment.
        trimLeading = segment.isEmpty
      }
      if inThink {
        result.thought += segment
      } else {
        result.answer += segment
      }
    }

    while !rest.isEmpty {
      let tag = inThink ? closeTag : openTag

      guard let range = rest.range(of: tag) else {
        let held = final ? 0 : partialTagLength(in: rest, of: tag)
        append(rest.dropLast(held))

        break
      }

      append(rest[..<range.lowerBound])
      rest = rest[range.upperBound...]
      inThink.toggle()
      trimLeading = true
    }

    return result
  }

  /// Length of the longest proper prefix of `tag` that `text` ends with (`"…<thi"` → 3).
  private static func partialTagLength(in text: Substring, of tag: String) -> Int {
    for length in stride(from: min(tag.count - 1, text.count), through: 1, by: -1)
    where text.hasSuffix(String(tag.prefix(length))) {
      return length
    }

    return 0
  }
}

/// Accumulates one channel of a stream, whether the runtime yields **deltas** or **cumulative
/// snapshots**.
///
/// LiteRT-LM's Swift docs and samples treat each streamed `Message` as the next piece, but the
/// runtime does not promise it across versions. Deciding per chunk would misfire on a delta that
/// happens to repeat what came before (a digit token `"1"` after `"1"`), so it decides **once**, on
/// the second non-empty chunk: if that chunk strictly extends the first it is a snapshot stream,
/// otherwise a delta stream.
struct StreamDiffer {
  private enum Mode {
    case undecided
    case delta
    case cumulative
  }

  /// Everything received on this channel so far.
  private(set) var text = ""
  private var mode = Mode.undecided

  mutating func ingest(_ chunk: String) {
    guard !chunk.isEmpty else { return }

    if text.isEmpty {
      text = chunk

      return
    }

    switch mode {
    case .delta:
      text += chunk
    case .cumulative:
      // A snapshot that is not an extension is a rewrite; follow it. The assembler never retracts
      // what it already emitted, so this only stalls output until the text grows past it again.
      text = chunk
    case .undecided:
      if Self.extends(chunk, text) {
        mode = .cumulative
        text = chunk
      } else {
        mode = .delta
        text += chunk
      }
    }
  }

  /// Compared as UTF-8, not as `Character`s: a chunk boundary can fall between a base character and
  /// its combining mark, and `"e"` is not a prefix of `"é"` by grapheme comparison.
  fileprivate static func extends(_ longer: String, _ shorter: String) -> Bool {
    longer.utf8.count > shorter.utf8.count && longer.utf8.starts(with: shorter.utf8)
  }
}

/// What one chunk added to the reply.
struct ReplyDelta: Equatable {
  var answer = ""
  var thought = ""

  var isEmpty: Bool { answer.isEmpty && thought.isEmpty }
}

/// Turns the stream of LiteRT-LM `Message`s into answer text and reasoning text.
///
/// Reasoning comes from the `thought` channel when the runtime provides one, else from `<think>`
/// tags in the text; either way it is kept out of the answer. With `enableThinking` off no
/// reasoning is reported at all — a model that reasons anyway has it dropped, not shown.
struct ReplyAssembler {
  private let enableThinking: Bool
  private var contentStream = StreamDiffer()
  private var channelStream = StreamDiffer()
  private var emittedAnswer = ""
  private var emittedThought = ""

  init(enableThinking: Bool) {
    self.enableThinking = enableThinking
  }

  /// Feeds one streamed message: its text, and its `thought` channel (empty when it has none).
  mutating func ingest(text: String, thoughtChannel: String) -> ReplyDelta {
    contentStream.ingest(text)
    channelStream.ingest(thoughtChannel)

    return render(final: false)
  }

  /// Flushes text held back at the end of the stream (`"…<thi"` that never became a tag).
  mutating func finish() -> ReplyDelta {
    render(final: true)
  }

  private mutating func render(final: Bool) -> ReplyDelta {
    // Control tokens go first, so a marker can never end up inside what the tag splitter returns.
    let split = ThinkTagSplitter.split(
      SpecialTokenStripper.strip(contentStream.text, final: final), final: final)
    let thought: String

    if !enableThinking {
      thought = ""
    } else if !channelStream.text.isEmpty {
      thought = SpecialTokenStripper.strip(channelStream.text, final: final)
    } else {
      thought = split.thought
    }

    return ReplyDelta(
      answer: Self.advance(&emittedAnswer, to: split.answer),
      thought: Self.advance(&emittedThought, to: thought))
  }

  /// What `full` adds beyond `emitted`, or nothing when `full` is not an extension of it — output
  /// already sent cannot be taken back, so a rewrite waits until the text grows past it.
  private static func advance(_ emitted: inout String, to full: String) -> String {
    guard StreamDiffer.extends(full, emitted) else { return "" }

    let added = String(decoding: Array(full.utf8.dropFirst(emitted.utf8.count)), as: UTF8.self)
    emitted = full

    return added
  }
}

// MARK: - Failures

/// A native generation that ended in an error, with how far it had got.
///
/// Carries the runtime's own error and two counters, and adds nothing else. In particular no prompt
/// text and no tool result: those are the user's data, and this value is what gets logged and shown.
struct GenerationStreamFailure: Error, LocalizedError {
  let underlying: Error
  /// Non-empty chunks (answer or reasoning) received before the failure. Zero means no token had
  /// come back yet — on a turn that called a tool, the request that carried the tool's result.
  let chunksReceived: Int
  /// Milliseconds from the request to the failure.
  let elapsedMs: Int

  var errorDescription: String? { underlying.localizedDescription }
}

/// How a failed generation is worded: for the device log, and for the rejection that reaches JS.
///
/// Until this existed a native failure was visible nowhere — nothing logged, and the chat showed
/// only "interrupted" — so a turn that died within 100 ms of a tool call left no way to tell why.
enum GenerationFailure {
  /// The longest reason passed on. A runtime error can echo what it choked on, and the whole of
  /// that must not travel with it.
  static let maxReasonLength = 200

  /// The generic wording JS has always seen, with the reason after it when there is one.
  static func rejectionMessage(for error: Error) -> String {
    let reason = reason(for: error)

    return reason.isEmpty ? "Generation failed" : "Generation failed: \(reason)"
  }

  /// What went wrong, in the runtime's own words: one line, bounded.
  static func reason(for error: Error) -> String {
    let underlying = (error as? GenerationStreamFailure)?.underlying ?? error
    let line = underlying.localizedDescription
      .split(whereSeparator: \.isWhitespace)
      .joined(separator: " ")

    guard line.count > maxReasonLength else { return line }

    return String(line.prefix(maxReasonLength)) + "…"
  }

  /// The device-log line for a failed `method`: the reason, the error's type, and how far the
  /// generation got when that is known.
  static func logLine(for error: Error, method: String) -> String {
    let underlying = (error as? GenerationStreamFailure)?.underlying ?? error
    var line = "[LocalLLM] \(method) failed (\(type(of: underlying))): \(reason(for: error))"

    if let failure = error as? GenerationStreamFailure {
      line += " [after \(failure.chunksReceived) chunks, \(failure.elapsedMs) ms]"
    }

    return line
  }
}
