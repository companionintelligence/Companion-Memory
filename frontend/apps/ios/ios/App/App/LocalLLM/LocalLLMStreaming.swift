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
    let split = ThinkTagSplitter.split(contentStream.text, final: final)
    let thought: String

    if !enableThinking {
      thought = ""
    } else if !channelStream.text.isEmpty {
      thought = channelStream.text
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
