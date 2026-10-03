import Foundation

// Checks the pure logic behind the on-device LLM plugin — reply assembly (control-token stripping),
// failure wording, and tool-result shaping — with no device, no model, no Capacitor and no LiteRT-LM
// framework. `scripts/test-local-llm-pure.sh` compiles the app's own LocalLLMStreaming.swift,
// LocalLLMPolicy.swift, LocalLLMModels.swift and the vendored LiteRTLMError.swift together with this
// file and runs it; the project has no XCTest target to host them.
//
// Plain assertions, not XCTest: a failing check prints its line and the run exits non-zero.

var checks = 0
var failures = 0

func check(_ condition: @autoclosure () -> Bool, _ message: String, line: UInt = #line) {
  checks += 1

  if !condition() {
    failures += 1
    print("  FAIL (line \(line)): \(message)")
  }
}

func expectEqual<T: Equatable>(_ actual: T, _ expected: T, _ message: String, line: UInt = #line) {
  checks += 1

  if actual != expected {
    failures += 1
    print("  FAIL (line \(line)): \(message)\n    expected: \(expected)\n    actual:   \(actual)")
  }
}

func test(_ name: String, _ body: () -> Void) {
  print("- \(name)")
  body()
}

// MARK: - Reply assembly

/// Feeds `chunks` through a `ReplyAssembler` the way the engine does and returns everything it
/// emitted, concatenated.
func assemble(
  _ chunks: [String], thoughts: [String]? = nil, thinking: Bool = false
) -> (answer: String, thought: String) {
  var assembler = ReplyAssembler(enableThinking: thinking)
  var answer = ""
  var thought = ""

  for (index, chunk) in chunks.enumerated() {
    let delta = assembler.ingest(text: chunk, thoughtChannel: thoughts?[index] ?? "")
    answer += delta.answer
    thought += delta.thought
  }

  let tail = assembler.finish()
  answer += tail.answer
  thought += tail.thought

  return (answer, thought)
}

test("a leaked <|endoftext|> at the start of an answer never reaches the bubble") {
  // The turn after a tool call, observed on a device build: the bubble opened with the marker.
  expectEqual(
    assemble(["<|endoftext|>This is a test of the tool. Please wait"]).answer,
    "This is a test of the tool. Please wait",
    "marker stripped from a single chunk")

  expectEqual(
    assemble(["<|endoftext|>", "This", " is", " a test"]).answer,
    "This is a test",
    "marker stripped when it arrives as a chunk of its own")
}

test("the chat-template markers a model can emit are all stripped") {
  for marker in [
    "<|im_end|>", "<|im_start|>", "<|endoftext|>", "<|eot_id|>", "<|end|>", "<|vision_start|>",
  ] {
    expectEqual(assemble(["Hi \(marker)there"]).answer, "Hi there", "\(marker) is stripped")
  }
}

test("a marker split across two chunks is held back, then dropped") {
  var assembler = ReplyAssembler(enableThinking: false)

  let first = assembler.ingest(text: "Hello <|im_", thoughtChannel: "")
  expectEqual(first.answer, "Hello ", "half a marker is held back, not shown and retracted")

  let second = assembler.ingest(text: "end|> world", thoughtChannel: "")
  expectEqual(second.answer, " world", "the completed marker adds nothing")
  check(assembler.finish().isEmpty, "nothing was left held back")
}

test("a marker is dropped wherever the chunk boundary falls, one chunk or one character at a time")
{
  let raw = "A<|im_end|>B<|im_start|>assistant\nC<|endoftext|>"
  let expected = "ABassistant\nC"
  let characters = Array(raw)

  var wrongCuts: [Int] = []

  for cut in 1..<characters.count {
    let chunks = [String(characters[..<cut]), String(characters[cut...])]
    if assemble(chunks).answer != expected { wrongCuts.append(cut) }
  }

  check(wrongCuts.isEmpty, "two chunks, split after character(s) \(wrongCuts)")
  expectEqual(assemble(characters.map { String($0) }).answer, expected, "one character per chunk")
}

test("text that only looks like a marker is kept, including at the very end of the stream") {
  expectEqual(assemble(["Haskell: a <|> b"]).answer, "Haskell: a <|> b", "<|> has no name")
  expectEqual(assemble(["x <|| y"]).answer, "x <|| y", "no name between the bars")
  expectEqual(assemble(["a <| b"]).answer, "a <| b", "no closing bar")
  expectEqual(assemble(["if a < b"]).answer, "if a < b", "a bare less-than")
  expectEqual(
    assemble(["x <", " y"]).answer, "x < y", "a held-back < is released with the next chunk")

  let tooLong = "<|" + String(repeating: "a", count: SpecialTokenStripper.maxNameLength + 8) + "|>"
  expectEqual(
    assemble(["see \(tooLong) here"]).answer, "see \(tooLong) here",
    "a name too long to be a marker")

  expectEqual(
    assemble(["Use <|"]).answer, "Use <|", "a stream that ends inside a candidate flushes it")
  expectEqual(assemble(["tail <|abc"]).answer, "tail <|abc", "…also after a name")
  expectEqual(assemble(["tail <|abc|"]).answer, "tail <|abc|", "…also after the closing bar")
}

test("the held-back part of an unfinished marker is bounded") {
  // Anything that cannot become a marker is released at once, so a stream is never stalled on it.
  var assembler = ReplyAssembler(enableThinking: false)
  let delta = assembler.ingest(
    text: "price <|" + String(repeating: "z", count: 80), thoughtChannel: "")

  check(delta.answer.hasPrefix("price <|zzz"), "an over-long candidate is shown, not held")
}

test("markers are stripped from the reasoning channel and from inside <think> too") {
  let channel = assemble(
    ["Answer"], thoughts: ["Considering <|im_end|>the options"], thinking: true)
  expectEqual(channel.thought, "Considering the options", "reasoning channel")
  expectEqual(channel.answer, "Answer", "answer untouched")

  let tagged = assemble(["<think>hmm<|im_end|></think><|endoftext|>Answer"], thinking: true)
  expectEqual(tagged.thought, "hmm", "reasoning inside <think>")
  expectEqual(tagged.answer, "Answer", "answer after </think>")
}

test("characters outside ASCII survive around a marker") {
  expectEqual(
    assemble(["héllo<|im_end|>wörld 😀<|endoftext|>"]).answer, "héllowörld 😀",
    "multi-byte text intact")
}

test("SpecialTokenStripper, directly") {
  expectEqual(SpecialTokenStripper.strip("<|im_start|>", final: true), "", "a lone marker")
  expectEqual(
    SpecialTokenStripper.strip("no markers at all", final: false), "no markers at all", "no change")
  expectEqual(
    SpecialTokenStripper.strip("a<|b|>c<|d", final: false), "ac", "partial held back mid-stream")
  expectEqual(
    SpecialTokenStripper.strip("a<|b|>c<|d", final: true), "ac<|d", "partial kept at the end")
  expectEqual(SpecialTokenStripper.strip("<", final: false), "", "a lone < is held back")
  expectEqual(SpecialTokenStripper.strip("<", final: true), "<", "…and kept at the end")
  expectEqual(SpecialTokenStripper.strip("<|a|><|b|>", final: false), "", "adjacent markers")
}

// MARK: - Failure wording

/// An error whose description is whatever it was given — a stand-in for a runtime error.
struct DescribedError: LocalizedError {
  let text: String
  var errorDescription: String? { text }
}

test("a native failure is worded with the runtime's own error text") {
  let native = LiteRTLMError.conversation(
    .invalidResponse(
      "INVALID_ARGUMENT: Input token ids are too long. Exceeding the maximum number of tokens allowed: 1413 >= 1024"
    ))
  let failure = GenerationStreamFailure(underlying: native, chunksReceived: 0, elapsedMs: 91)

  let reason =
    "Invalid response from native layer: INVALID_ARGUMENT: Input token ids are too long. "
    + "Exceeding the maximum number of tokens allowed: 1413 >= 1024"

  expectEqual(
    failure.localizedDescription, native.localizedDescription,
    "the wrapper reads as the error it wraps")
  expectEqual(GenerationFailure.reason(for: failure), reason, "reason")
  expectEqual(
    GenerationFailure.rejectionMessage(for: failure), "Generation failed: " + reason,
    "the rejection keeps the wording JS has always seen, with the reason after it")
  expectEqual(
    GenerationFailure.logLine(for: failure, method: "generateStream"),
    "[LocalLLM] generateStream failed (LiteRTLMError): " + reason + " [after 0 chunks, 91 ms]",
    "log line: prefix, method, error type, reason, progress")
}

test("a failure before any stream existed is logged without progress counters") {
  let refusal = LocalLLMError.imageInputUnsupported(modelId: "qwen3-0.6b-int4")

  expectEqual(
    GenerationFailure.logLine(for: refusal, method: "generate"),
    "[LocalLLM] generate failed (LocalLLMError): Image input is not supported by qwen3-0.6b-int4 on iOS",
    "no [after …] suffix")
  expectEqual(
    GenerationFailure.rejectionMessage(for: refusal),
    "Generation failed: Image input is not supported by qwen3-0.6b-int4 on iOS", "rejection")
}

test("the reason is one bounded line, however much the runtime wrote") {
  let long = DescribedError(text: String(repeating: "x", count: 5_000) + "\n\nsecond paragraph")
  let reason = GenerationFailure.reason(for: long)

  check(reason.count <= GenerationFailure.maxReasonLength + 1, "bounded (got \(reason.count))")
  check(!reason.contains("\n"), "one line")
  check(reason.hasSuffix("…"), "says it was cut")

  expectEqual(
    GenerationFailure.reason(for: DescribedError(text: "line one\n   line two\t\tend")),
    "line one line two end", "whitespace runs collapse to one space")
}

test("an error with nothing to say falls back to the generic wording") {
  expectEqual(
    GenerationFailure.rejectionMessage(for: DescribedError(text: "")), "Generation failed",
    "no trailing colon, no empty reason")
}

test("the elapsed time of a failed generation is read off the same clock as its stats") {
  let tracker = GenerationStatsTracker(startedAt: 10)

  expectEqual(tracker.elapsedMs(at: 10.091), 91, "milliseconds since the request")
  expectEqual(tracker.elapsedMs(at: 9), 0, "never negative")
}

// MARK: - Tool results

func pretty(_ object: Any) -> String {
  let data = try! JSONSerialization.data(
    withJSONObject: object, options: [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes])

  return String(decoding: data, as: UTF8.self)
}

/// What the appliance's `knowledge.search` sends back through MCP: `JSON.stringify(result, null, 2)`
/// of a header — `summary` first — and up to 25 hydrated entities, each with a long `content`.
func searchResult(items count: Int, contentLength: Int = 900) -> String {
  let items: [[String: Any]] = (0..<count).map { n in
    let id = "0198a3f2-7c1e-7b3a-9d41-\(String(format: "%012d", n))"

    return [
      "id": id,
      "type": "communication",
      "link": "/communications/\(id)",
      "title": "Zephyr marmalade note \(n)",
      "content": String(repeating: "zephyr marmalade ", count: contentLength / 17),
      "time": "2026-09-2\(n % 10)T10:00:00.000Z",
      "createdAt": "2026-09-2\(n % 10)T10:00:01.000Z",
      "updatedAt": "2026-09-2\(n % 10)T10:00:02.000Z",
      "metadata": ["source": "takeout", "labels": ["a", "b", "c"], "score": 0.8123],
    ]
  }

  return "{\n  \"summary\": \"Showing the top \(count) of at least \(count) matches.\",\n"
    + "  \"totalMatches\": null,\n  \"truncated\": true,\n  \"limit\": 25,\n  \"mode\": \"hybrid\",\n"
    + "  \"items\": [\n" + items.map(pretty).joined(separator: ",\n") + "\n  ]\n}"
}

func parse(_ text: String) -> Any? {
  try? JSONSerialization.jsonObject(with: Data(text.utf8), options: [.fragmentsAllowed])
}

test("the context-window share a tool result may take") {
  expectEqual(LocalLLMPolicy.toolResultByteBudget(contextTokens: 1024), 512, "Qwen3-0.6B's window")
  expectEqual(LocalLLMPolicy.toolResultByteBudget(contextTokens: 4096), 2048, "a 4k window")
  expectEqual(LocalLLMPolicy.toolResultByteBudget(contextTokens: 8192), 4096, "an 8k window")
  expectEqual(
    LocalLLMPolicy.toolResultByteBudget(contextTokens: 1_000_000), 16_384,
    "capped like the appliance's")
  expectEqual(
    LocalLLMPolicy.toolResultByteBudget(contextTokens: 100), 256, "a tiny window keeps a floor")
  expectEqual(
    LocalLLMPolicy.toolResultByteBudget(contextTokens: -5), 256, "nonsense keeps the floor")
}

test("a tool result is sized against the room the window has left") {
  let profile = LocalLLMPolicy.ToolResultProfile.standard
  let budget = { LocalLLMPolicy.toolResultByteBudget(tokensLeft: $0) }

  // The tokenizer's measured median over the shaped results is 2.6 bytes a token (2.3 at the low end):
  // counting more than that would hand the model a result bigger than the room it was sized for.
  check(profile.bytesPerToken <= 2.6, "bytes per token is no more than the measured median")

  // What the runtime needs left once the result is in: the turn that carries a result back garbles below
  // ~700 tokens (673 garbled, 735 sound on the bench). The reserve must clear that, with a margin.
  check(profile.reserveTokens >= 735 + 16, "the reserve clears the highest room that still garbled")

  // Qwen3-0.6B with the three intent tools: the preface (434), a question (~20) and the model's tool call
  // (~39) are in the cache when the tool runs.
  let at2048 = 2048 - 493
  let room = at2048 - profile.wrapperTokens - profile.reserveTokens
  expectEqual(budget(at2048), Int(Double(room) * profile.bytesPerToken), "the room that remains, in bytes")
  check(budget(at2048) > 1024, "a 2048 window takes a kilobyte and more")

  // At 1024 there is not that much room even for nothing: the preface alone is 42% of it. The budget says
  // so with the floor rather than promise bytes the window cannot take.
  let at1024 = 1024 - 493
  expectEqual(budget(at1024), profile.minBytes, "a 1024 window with the three tools gets the stub")

  expectEqual(budget(0), profile.minBytes, "a spent window still gets the stub that says so")
  expectEqual(budget(-40), profile.minBytes, "nonsense gets the floor")
  expectEqual(
    budget(profile.wrapperTokens + profile.reserveTokens), profile.minBytes, "nothing left over for a result")
  expectEqual(budget(10_000_000), profile.maxBytes, "capped like the appliance's")

  // Swept over every window left from nothing to 20 000 tokens: one verdict per property, not one per step.
  var notMonotone: [Int] = []
  var outOfBounds: [Int] = []
  var doesNotFit: [Int] = []
  var previous = 0

  for left in stride(from: -10, through: 20_000, by: 7) {
    let bytes = budget(left)
    if bytes < previous { notMonotone.append(left) }
    if bytes < profile.minBytes || bytes > profile.maxBytes { outOfBounds.append(left) }

    // The promise behind the number: once it is above the floor, the tokens it may cost, the wrapper
    // and the reserve together fit in what is left.
    if bytes > profile.minBytes && bytes < profile.maxBytes {
      let tokens = Int((Double(bytes) / profile.bytesPerToken).rounded(.up))
      if tokens + profile.wrapperTokens + profile.reserveTokens > left + 1 { doesNotFit.append(left) }
    }
    previous = bytes
  }

  check(notMonotone.isEmpty, "more room never means less: \(notMonotone.prefix(3))")
  check(outOfBounds.isEmpty, "always inside its floor and cap: \(outOfBounds.prefix(3))")
  check(doesNotFit.isEmpty, "the result, its wrapper and the reserve fit in what is left: \(doesNotFit.prefix(3))")

  // A conversation that has used more of the window leaves less for a result.
  check(budget(1500) < budget(3000), "a fuller window takes a smaller result")

  let roomier = LocalLLMPolicy.ToolResultProfile(
    bytesPerToken: 3, wrapperTokens: 0, reserveTokens: 100, turnTokens: 0, maxBytes: 1000, minBytes: 50,
    usefulResultBytes: 0)
  expectEqual(LocalLLMPolicy.toolResultByteBudget(tokensLeft: 200, profile: roomier), 300, "a profile's own numbers")
  expectEqual(LocalLLMPolicy.toolResultByteBudget(tokensLeft: 900, profile: roomier), 1000, "a profile's own cap")
  expectEqual(LocalLLMPolicy.toolResultByteBudget(tokensLeft: 90, profile: roomier), 50, "a profile's own floor")
}

test("a conversation that offers tools starts afresh when a tool call could no longer work") {
  let profile = LocalLLMPolicy.ToolResultProfile.standard
  let minimum = LocalLLMPolicy.toolTurnMinimumTokens()

  // The pieces that make it up: the question and the call, a result worth sending, its wrapper, the reserve.
  expectEqual(
    minimum,
    profile.turnTokens + Int((Double(profile.usefulResultBytes) / profile.bytesPerToken).rounded(.up))
      + profile.wrapperTokens + profile.reserveTokens,
    "what the next turn needs")
  check(minimum > profile.reserveTokens, "more than the reserve alone")

  let renew = { (left: Int?, history: Bool) in
    LocalLLMPolicy.shouldRenewToolConversation(tokensLeft: left, hasHistory: history)
  }

  check(renew(minimum - 1, true), "one token short, with history: renew")
  check(!renew(minimum, true), "exactly enough: carry on")
  check(!renew(minimum + 500, true), "plenty left: carry on")
  check(!renew(0, false), "a conversation with no history is never renewed, however small the window")
  check(!renew(minimum - 1, false), "nor one that is merely short of room")
  check(!renew(nil, true), "unknown room is not a reason to forget the conversation")
  check(renew(0, true), "a spent window with history: renew")
  check(renew(-3, true), "nonsense counts as spent")

  // The window as shipped must not renew a fresh tool conversation before its first question but it
  // must leave room for more than one tool turn once it is large enough: after the first turn at 2048
  // the cache holds ~850 (preface 434, question, call, a 400-token result and a reply), so there is room.
  let afterOneTurn2048 = 2048 - 850
  check(!renew(afterOneTurn2048, true), "a second tool turn fits at 2048")
  let afterOneTurn1024 = 1024 - 850
  check(renew(afterOneTurn1024, true), "at 1024 nothing is left for a second one")
}

test("a result that already fits is passed on untouched") {
  let small = "{\n  \"error\": \"Companion is not connected\"\n}"

  expectEqual(
    ToolResultShaper.shape(small, budgetBytes: 512), small, "byte-identical, whitespace and all")
  expectEqual(ToolResultShaper.shape("", budgetBytes: 512), "", "empty")
}

/// The item objects of a shaped search envelope, and whatever closes the list.
func shapedItems(_ shaped: String) -> (hits: [[String: Any]], note: String?, header: [String: Any])? {
  guard let object = parse(shaped) as? [String: Any], let items = object["items"] as? [Any] else {
    return nil
  }

  var header = object
  header["items"] = nil

  return (items.compactMap { $0 as? [String: Any] }, items.last as? String, header)
}

test("a 25-hit knowledge.search result is cut to the budget and stays valid, informative JSON") {
  let raw = searchResult(items: 25)
  let budget = 1024

  check(
    raw.utf8.count > 20_000, "the fixture is as big as the real thing (\(raw.utf8.count) bytes)")

  let shaped = ToolResultShaper.shape(raw, budgetBytes: budget)

  check(shaped.utf8.count <= budget, "within the budget (\(shaped.utf8.count) of \(budget) bytes)")
  check(shaped.utf8.count > 200, "…but not emptied (\(shaped.utf8.count) bytes)")
  check(!shaped.contains("\n"), "compact: pretty-printing whitespace is gone")
  check(
    shaped.hasPrefix("{\"summary\":\"Showing the top 25 of at least 25 matches.\","),
    "the summary leads: \(shaped.prefix(80))")

  guard let (hits, note, header) = shapedItems(shaped) else {
    check(false, "output parses as a JSON object with items: \(shaped)")

    return
  }

  expectEqual(header["truncated"] as? Bool, true, "header kept: truncated")
  expectEqual(header["limit"] as? Int, 25, "header kept: limit")
  expectEqual(header["mode"] as? String, "hybrid", "header kept: mode")
  check(header["totalMatches"] == nil, "an unset header field (totalMatches: null) is not sent")
  check(hits.count >= 2, "several hits survive, not one (\(hits.count))")
  check(
    note?.hasSuffix("more results omitted — refine the query to narrow them down]") == true,
    "closing note: \(note ?? "none")")
  expectEqual(
    hits.count + (Int(note?.dropFirst().prefix(while: \.isNumber) ?? "") ?? 0), 25,
    "the note counts exactly the hits that were left out")
}

test("a hit stays a hit: no JSON inside a string, however little of it fits") {
  for budget in [128, 256, 512, 1024] {
    let shaped = ToolResultShaper.shape(searchResult(items: 25), budgetBytes: budget)

    check(shaped.utf8.count <= budget, "within \(budget) bytes (\(shaped.utf8.count))")
    check(!shaped.contains("\\\""), "nothing is escaped twice over at \(budget): \(shaped.prefix(120))")

    guard let object = parse(shaped) as? [String: Any] else {
      // Below what a header and a hit can share, the cut is plain text that says so.
      check(shaped.hasSuffix(ToolResultShaper.truncationMarker), "a cut that is not JSON says so at \(budget)")

      continue
    }

    if let items = object["items"] as? [Any] {
      check(
        items.dropLast().allSatisfy { $0 is [String: Any] },
        "every kept hit is an object at \(budget), none a string")
    }
  }
}

test("a roomier budget keeps whole hits, link whole, and counts the ones it dropped") {
  let raw = searchResult(items: 25, contentLength: 200)
  let shaped = ToolResultShaper.shape(raw, budgetBytes: 4096)

  check(shaped.utf8.count <= 4096, "within the budget (\(shaped.utf8.count) of 4096)")

  guard let (hits, note, _) = shapedItems(shaped) else {
    check(false, "output parses: \(shaped.prefix(120))")

    return
  }

  check(hits.count >= 5, "many hits survive (\(hits.count))")

  let omitted = note.flatMap { Int($0.dropFirst().prefix(while: \.isNumber)) } ?? -1
  expectEqual(omitted, 25 - hits.count, "the note counts exactly the dropped hits")
  expectEqual(
    hits.first?["link"] as? String, "/communications/0198a3f2-7c1e-7b3a-9d41-000000000000",
    "best hit first, link whole, and its slashes are not escaped")
  check(hits.first?["id"] == nil, "the id is dropped when the link already carries it")
  check(!shaped.contains("\\/"), "no escaped slashes eating the budget")
}

test("one oversized hit is shortened, not turned into a string, and the result still fits and parses") {
  let raw = searchResult(items: 1, contentLength: 20_000)
  let shaped = ToolResultShaper.shape(raw, budgetBytes: 512)

  check(shaped.utf8.count <= 512, "within the budget (\(shaped.utf8.count))")

  guard let (hits, note, _) = shapedItems(shaped), let hit = hits.first else {
    check(false, "output parses with a hit: \(shaped)")

    return
  }

  expectEqual(hits.count, 1, "the one hit is kept")
  check(note == nil, "nothing was dropped, so there is no omission note")
  expectEqual(hit["type"] as? String, "communication", "type survives")
  expectEqual(
    hit["link"] as? String, "/communications/0198a3f2-7c1e-7b3a-9d41-000000000000",
    "link survives whole")
  expectEqual(hit["title"] as? String, "Zephyr marmalade note 0", "the title survives")
  check(
    (hit["content"] as? String).map { $0.hasSuffix("…") && $0.count < 400 } ?? true,
    "the long content is what was shortened")
}

test("what identifies a hit is written first, then when, then what it says; bookkeeping last") {
  let raw = pretty([
    "content": String(repeating: "lorem ipsum ", count: 100), "id": "abc", "title": "Short title",
    "type": "note", "createdAt": "2025-03-08T18:04:00.000Z", "sourceSystem": "takeout",
    "tags": ["a"],
  ])
  let shaped = ToolResultShaper.shape(raw, budgetBytes: 700)

  check(shaped.utf8.count <= 700, "within the budget (\(shaped.utf8.count))")

  // Bookkeeping goes last, shortest value first among itself: `id` ("abc") before `sourceSystem`.
  let keys = ["type", "title", "createdAt", "content", "tags", "id", "sourceSystem"]
  var cursor = shaped.startIndex

  for key in keys {
    guard let found = shaped.range(of: "\"\(key)\":", range: cursor..<shaped.endIndex) else {
      check(false, "\(key) is written, in order: \(shaped.prefix(200))")

      return
    }
    cursor = found.upperBound
  }

  check(true, "type, title, createdAt, content, the rest, then bookkeeping, in that order")
}

test("a hit that has to lose members loses its bookkeeping before the date") {
  let raw = pretty([
    "type": "event", "link": "/events/e1", "title": "Dentist: Dr. Nair",
    "startTime": "2025-10-09T21:30:00.000Z", "endTime": "2025-10-09T22:30:00.000Z",
    "sourceId": "evt_" + String(repeating: "x", count: 40), "sourceSystem": "google_calendar",
    "sentimentScore": 0.4, "importanceScore": 0.3, "confidenceScore": 1,
    "metadata": ["htmlLink": "https://calendar.example.com/event?eid=" + String(repeating: "q", count: 60)],
    "locationName": "Fremont Smile Dental, Fremont", "category": "health",
  ])
  let shaped = ToolResultShaper.shape(raw, budgetBytes: 230)

  check(shaped.utf8.count <= 230, "within the budget (\(shaped.utf8.count))")
  check(shaped.contains("\"startTime\":\"2025-10-09T21:30:00.000Z\""), "the start time survives: \(shaped)")
  check(shaped.contains("\"title\":\"Dentist: Dr. Nair\""), "so does the title")
  check(!shaped.contains("sourceId"), "the bookkeeping is what was dropped")
}

test("an unset column costs nothing: nulls, empties, false and foreign keys are not sent") {
  let uuid = "0199aaaa-bbbb-7ccc-9ddd-eeeeeeeeeeee"
  let raw = pretty([
    "type": "communication", "link": "/communications/\(uuid)", "id": uuid, "entityType": "communication",
    "subject": NSNull(), "summary": "", "attachments": [] as [Any], "metadata": [:] as [String: Any],
    "isEncrypted": false, "isArchived": false, "threadId": uuid, "fromEntityId": uuid,
    "toEntityIds": [uuid], "content": String(repeating: "Did you see the heron? ", count: 30),
    "importanceScore": 0.3, "durationSeconds": 0, "isRecurring": true,
  ])
  let shaped = ToolResultShaper.shape(raw, budgetBytes: 600)

  guard let hit = parse(shaped) as? [String: Any] else {
    check(false, "parses: \(shaped)")

    return
  }

  expectEqual(Set(hit.keys), ["type", "link", "content", "importanceScore", "durationSeconds", "isRecurring"],
    "only what means something is left")
  expectEqual(hit["durationSeconds"] as? Int, 0, "0 is a number, not an unset column")
  expectEqual(hit["isRecurring"] as? Bool, true, "true is information")
}

test("a link is only useful whole: it is never shortened, whatever the string cap") {
  let link = "/communications/0199aaaa-bbbb-7ccc-9ddd-eeeeeeeeeeee"

  for budget in [160, 256, 400] {
    let raw = pretty(["type": "communication", "link": link, "title": "T",
                      "content": String(repeating: "word ", count: 400)])
    let shaped = ToolResultShaper.shape(raw, budgetBytes: budget)

    check(shaped.contains("\"link\":\"\(link)\""), "link whole at \(budget): \(shaped)")
  }
}

test("the first hits share the room, so three different hits reach the model, not one long one") {
  let raw = Corpus.result(tool: "knowledge_search", arguments: ["query": "heron"])
  let shaped = ToolResultShaper.shape(raw, budgetBytes: 1024)

  check(shaped.utf8.count <= 1024, "within the budget (\(shaped.utf8.count))")

  guard let (hits, _, _) = shapedItems(shaped) else {
    check(false, "parses: \(shaped.prefix(120))")

    return
  }

  expectEqual(hits.count, 3, "three hits share the room")
  expectEqual(
    hits.compactMap { $0["type"] as? String }, ["note", "communication", "photo"],
    "in the order the appliance ranked them")
  check(
    hits.allSatisfy { ($0["content"] as? String ?? $0["text"] as? String ?? $0["title"] as? String) != nil },
    "each carries something to read, not only its address")
  check(shaped.contains("Lake Merritt"), "the answer's place reaches the model")
}

test("where a budget is too tight for three readable hits, fewer share it") {
  let raw = Corpus.result(tool: "knowledge_search", arguments: ["query": "heron"])
  let shaped = ToolResultShaper.shape(raw, budgetBytes: 512)

  guard let (hits, _, _) = shapedItems(shaped) else {
    check(false, "parses: \(shaped.prefix(120))")

    return
  }

  check(hits.count <= 2, "at most two share 512 bytes (\(hits.count))")
  check(shaped.contains("Lake Merritt"), "and the one that is there says where")
}

test("the dentist's appointment time survives a tight budget on a realistic result") {
  let raw = Corpus.result(tool: "knowledge_search", arguments: ["query": "dentist"])

  for budget in [512, 1024] {
    let shaped = ToolResultShaper.shape(raw, budgetBytes: budget)

    check(shaped.utf8.count <= budget, "within \(budget) (\(shaped.utf8.count))")
    check(shaped.contains("2025-10-09T21:30:00.000Z"), "the start time reaches the model at \(budget)")
  }
}

test("a realistic result is far smaller with the unset columns gone") {
  let raw = Corpus.result(tool: "knowledge_search", arguments: ["query": "dentist"])
  let shaped = ToolResultShaper.shape(raw, budgetBytes: 8192)

  check(raw.utf8.count > 25_000, "the raw result is the size of the real one (\(raw.utf8.count))")
  check(shaped.utf8.count <= 8192, "within the budget (\(shaped.utf8.count))")
  check(shaped.contains("Dr. Priya Nair"), "and says who")
}

test("a graph keeps a few edges beside a few nodes: what says how people relate survives a tight budget") {
  let raw = Corpus.result(tool: "memory_recall", arguments: ["personName": "Maria Alvarez"])

  for budget in [700, 1024, 2048] {
    let shaped = ToolResultShaper.shape(raw, budgetBytes: budget)

    check(shaped.utf8.count <= budget, "within \(budget) (\(shaped.utf8.count))")

    guard let object = parse(shaped) as? [String: Any] else {
      check(false, "a graph is still JSON at \(budget): \(shaped.prefix(120))")

      continue
    }

    let nodes = object["nodes"] as? [Any] ?? []
    let edges = object["edges"] as? [Any] ?? []

    check(nodes.contains { $0 is [String: Any] }, "a node survives at \(budget)")
    check(edges.contains { $0 is [String: Any] }, "and so does an edge at \(budget)")
    check(shaped.contains("Maria Alvarez"), "the person named reaches the model at \(budget)")
  }

  let roomy = ToolResultShaper.shape(raw, budgetBytes: 2048)
  check(roomy.contains("FRIEND_OF") || roomy.contains("WORKS_AT"), "a relationship type is in what the model reads")
  check(!roomy.contains("\"seedEntityIds\""), "the list of seed UUIDs is gone: ids the model cannot use")
}

test("every list in a result is bounded, not only `items`, and each says how many it left out") {
  let manyNodes = (0..<30).map { ["name": "Person \($0)", "type": "person", "note": String(repeating: "n", count: 120)] }
  let manyEdges = (0..<40).map { ["type": "KNOWS", "from": ["name": "A\($0)"], "to": ["name": "B\($0)"]] as [String: Any] }
  let raw = pretty(["nodes": manyNodes, "edges": manyEdges, "stats": ["nodeCount": 30, "edgeCount": 40]])
  let shaped = ToolResultShaper.shape(raw, budgetBytes: 900)

  check(shaped.utf8.count <= 900, "within the budget (\(shaped.utf8.count))")

  guard let object = parse(shaped) as? [String: Any] else {
    check(false, "parses: \(shaped.prefix(120))")

    return
  }

  for key in ["nodes", "edges"] {
    let list = object[key] as? [Any] ?? []

    check(list.contains { $0 is [String: Any] }, "\(key) keeps hits")
    check((list.last as? String)?.contains("more results omitted") == true, "\(key) says it was cut")
  }

  expectEqual((object["stats"] as? [String: Any])?["nodeCount"] as? Int, 30, "the small member is kept whole")
}

test("an envelope's own header is capped, so a runaway summary cannot take the hits' room") {
  let hits = (0..<10).map { ["type": "note", "link": "/notes/n\($0)", "title": "Note \($0)", "content": "text \($0)"] }
  let raw = pretty([
    "summary": String(repeating: "very long summary sentence ", count: 200), "limit": 25, "items": hits,
  ])
  let shaped = ToolResultShaper.shape(raw, budgetBytes: 1024)

  check(shaped.utf8.count <= 1024, "within the budget (\(shaped.utf8.count))")

  guard let (kept, _, header) = shapedItems(shaped) else {
    check(false, "still a JSON object with hits, not a cut: \(shaped.prefix(120))")

    return
  }

  check(!kept.isEmpty, "hits survive a header that was huge")
  check((header["summary"] as? String).map { $0.count <= 201 && $0.hasSuffix("…") } ?? false, "the summary is capped and says so")
}

test("when nothing fits as JSON the cut is of the compact, pruned text, not of what the appliance sent") {
  let raw = pretty([
    "summary": "Showing the top 3 of at least 3 matches.", "totalMatches": NSNull(), "limit": 25,
    "items": (0..<3).map { ["type": "note", "link": "/notes/n\($0)", "title": "Note \($0)", "tags": [] as [Any]] as [String: Any] },
  ])
  let shaped = ToolResultShaper.shape(raw, budgetBytes: 80)

  check(shaped.utf8.count <= 80, "within the budget (\(shaped.utf8.count))")
  check(shaped.hasSuffix(ToolResultShaper.truncationMarker), "a cut that is not JSON says so: \(shaped)")
  check(!shaped.contains("\n") && !shaped.contains("  "), "no pretty-printing whitespace is spent: \(shaped.debugDescription)")
  check(shaped.hasPrefix("{\"summary\":"), "it begins with the compact text, summary first: \(shaped)")
  check(!shaped.contains("null"), "and without the unset columns")
}

test("numbers are written the short way, and a boolean is told from a 1") {
  let padding = String(repeating: "p", count: 600)
  let raw = pretty([
    "score": 0.8123, "count": 1, "flag": true, "zero": 0, "off": false, "none": NSNull(),
    "pad": padding,
  ])
  let shaped = ToolResultShaper.shape(raw, budgetBytes: 512)

  check(
    shaped.contains("\"score\":0.8123"), "0.8123 stays 0.8123, not 0.81230000000000002: \(shaped)")
  check(shaped.contains("\"count\":1"), "an integer stays an integer")
  check(shaped.contains("\"zero\":0"), "0 is a number, not false")
  check(shaped.contains("\"flag\":true"), "true stays true")
  check(!shaped.contains("\"off\""), "false is an unset column and is not sent")
  check(!shaped.contains("\"none\""), "null is an unset column and is not sent")
}

test("a top-level array is bounded the same way") {
  let list = (0..<40).map {
    ["id": $0, "name": "person number \($0)", "notes": String(repeating: "n", count: 400)]
      as [String: Any]
  }
  let raw = pretty(list)
  let shaped = ToolResultShaper.shape(raw, budgetBytes: 1024)

  check(shaped.utf8.count <= 1024, "within the budget (\(shaped.utf8.count))")

  let parsed = parse(shaped) as? [Any]
  check(parsed != nil, "still a JSON array: \(shaped.prefix(80))")
  check((parsed?.last as? String)?.contains("more results omitted") == true, "closing note")
}

test("every string is capped, so one long message cannot take the budget") {
  let raw = pretty(["content": String(repeating: "word ", count: 2_000), "id": "abc"])
  let shaped = ToolResultShaper.shape(raw, budgetBytes: 2048)

  check(shaped.utf8.count <= 2048, "within the budget (\(shaped.utf8.count))")

  let object = parse(shaped) as? [String: Any]
  check((object?["content"] as? String)?.hasSuffix("…") == true, "long string cut and marked")
  expectEqual(object?["id"] as? String, "abc", "short string untouched")
}

test("text that is not JSON is cut at the budget, on a character boundary, and says so") {
  let raw = String(repeating: "plain words. ", count: 400)
  let shaped = ToolResultShaper.shape(raw, budgetBytes: 300)

  check(shaped.utf8.count <= 300, "within the budget (\(shaped.utf8.count))")
  check(shaped.hasSuffix(ToolResultShaper.truncationMarker), "ends in the marker")
  check(shaped.hasPrefix("plain words. plain words."), "keeps the start")

  let cjk = String(repeating: "記憶の検索結果", count: 200)
  let cjkShaped = ToolResultShaper.shape(cjk, budgetBytes: 301)

  check(cjkShaped.utf8.count <= 301, "multi-byte text within the budget (\(cjkShaped.utf8.count))")
  check(!cjkShaped.contains("\u{FFFD}"), "no character cut in half")
}

test("JSON a serializer cannot write back never crashes the turn") {
  // 1e999 parses to infinity, which JSONSerialization refuses to emit — by raising an Objective-C
  // exception that Swift cannot catch. It must be noticed first and the text cut instead.
  let raw = "{\"items\":[" + String(repeating: "1e999,", count: 200) + "1]}"
  let shaped = ToolResultShaper.shape(raw, budgetBytes: 256)

  check(shaped.utf8.count <= 256, "within the budget (\(shaped.utf8.count))")
}

test("a budget too small to hold the markers is raised, not trusted") {
  let shaped = ToolResultShaper.shape(String(repeating: "x", count: 1_000), budgetBytes: 3)

  check(
    shaped.utf8.count <= ToolResultShaper.minimumBudgetBytes,
    "bounded by the floor (\(shaped.utf8.count))")
  check(shaped.hasSuffix(ToolResultShaper.truncationMarker), "still says it was cut")
}

/// How deep the containers of a parsed JSON value go (a scalar is 0).
func depth(of value: Any) -> Int {
  switch value {
  case let array as [Any]: return 1 + (array.map(depth(of:)).max() ?? 0)
  case let object as [String: Any]: return 1 + (object.values.map(depth(of:)).max() ?? 0)
  default: return 0
  }
}

test("JSON in is JSON out at every budget from 400 bytes up, on the realistic results") {
  // The closing "N more omitted" element used to be reserved as a share of the budget, which for a small
  // list was less than the element: one hit too many was kept and the final guard cut valid JSON in the
  // middle. At the budget the app shipped (512) the dentist and the graph came out cut; across 300...2048
  // 152, 170 and 199 budgets did. The element is held back exactly now, and what is left is a budget too
  // small for a header, one hit and the note (the largest invalid one measured was 336 bytes, a graph with
  // two lists; 400 is the line these tests hold).
  let results = [
    ("heron", Corpus.result(tool: "knowledge_search", arguments: ["query": "heron"])),
    ("dentist", Corpus.result(tool: "knowledge_search", arguments: ["query": "dentist"])),
    ("graph", Corpus.result(tool: "memory_recall", arguments: ["personName": "Maria Alvarez"])),
    ("graph of the user", Corpus.result(tool: "memory_recall", arguments: [:])),
  ]

  for (name, raw) in results {
    var notJSON: [Int] = []
    var overBudget: [Int] = []
    var unmarked: [Int] = []

    for budget in 128...2048 {
      let shaped = ToolResultShaper.shape(raw, budgetBytes: budget)

      if shaped.utf8.count > budget { overBudget.append(budget) }
      if parse(shaped) == nil {
        if budget >= 400 { notJSON.append(budget) }
        // Below that it is a cut of the compact text, and says so.
        if !shaped.hasSuffix(ToolResultShaper.truncationMarker) { unmarked.append(budget) }
      }
    }

    check(overBudget.isEmpty, "\(name): never over the budget: \(overBudget.prefix(3))")
    check(notJSON.isEmpty, "\(name): valid JSON from 400 bytes up: \(notJSON.prefix(5))")
    check(unmarked.isEmpty, "\(name): a cut that is not JSON says so: \(unmarked.prefix(3))")
  }
}

test("an array of plain values is one member of an object, not a list: the object still loses members") {
  // A single entity with `tags: ["a","b"]` used to count as a list carrier, so its other members were written
  // whole and the result was cut mid-JSON at every budget from 100 to 700.
  var entity: [String: Any] = [
    "type": "person", "link": "/people/maria", "name": "Maria Alvarez", "tags": ["friend", "baker"],
  ]
  for n in 0..<28 { entity["attribute\(n)"] = "value number \(n) " + String(repeating: "x", count: 30) }
  let raw = pretty(entity)

  var failures: [Int] = []
  for budget in 200...700 {
    let shaped = ToolResultShaper.shape(raw, budgetBytes: budget)

    if shaped.utf8.count > budget || !(parse(shaped) is [String: Any]) { failures.append(budget) }
  }
  check(failures.isEmpty, "valid JSON object within the budget at every budget from 200 to 700: \(failures.prefix(5))")

  let tight = ToolResultShaper.shape(raw, budgetBytes: 300)
  let kept = parse(tight) as? [String: Any] ?? [:]
  check(kept["name"] as? String == "Maria Alvarez", "what the entity is called survives")
  check(kept["link"] as? String == "/people/maria", "and where it lives")
}

test("nesting deeper than the cap is dropped, and a very deep result cannot overflow a small stack") {
  check(ToolResultShaper.maximumDepth >= 8, "real results (a hit with its metadata) are never cut short by the cap")

  // Written as text: building (and freeing) a dictionary 5 000 levels deep is recursive itself.
  func nest(_ levels: Int) -> String {
    let label = String(repeating: "y", count: 40)
    let leaf = "{\"leaf\":\"the deepest value \(String(repeating: "x", count: 50))\"}"

    return "{\"type\":\"note\",\"link\":\"/notes/n\",\"title\":\"deep\",\"nest\":"
      + String(repeating: "{\"label\":\"\(label)\",\"level\":", count: levels) + leaf
      + String(repeating: "}", count: levels) + "}"
  }

  // A document of moderate depth is parsed, and what lies below the cap is dropped.
  let moderate = ToolResultShaper.shape(nest(40), budgetBytes: 1500)
  if let parsed = parse(moderate) {
    check(depth(of: parsed) <= ToolResultShaper.maximumDepth + 1, "no deeper than the cap: \(depth(of: parsed))")
    check((parsed as? [String: Any])?["title"] as? String == "deep", "the shallow part is untouched")
  } else {
    check(false, "a 40-level document comes back as JSON")
  }

  // A very deep one never reaches Foundation's recursive parser: 512 levels overflowed a 512 KB stack and
  // 400 a 256 KB one, which is what a background thread gets. It is cut as text, within the budget.
  for levels in [400, 5_000] {
    let raw = nest(levels)
    var shaped = ""
    let finished = DispatchSemaphore(value: 0)
    let thread = Thread {
      shaped = ToolResultShaper.shape(raw, budgetBytes: 4096)
      finished.signal()
    }
    thread.stackSize = 256 * 1024
    thread.start()

    check(finished.wait(timeout: .now() + 60) == .success, "\(levels) levels came back, on a 256 KB stack")
    check(shaped.utf8.count <= 4096, "within the budget (\(shaped.utf8.count))")
    check(shaped.hasSuffix(ToolResultShaper.truncationMarker), "and says it was cut")
  }
}

test("a result with thousands of members is shaped in about a second, not a minute") {
  // Dropping members used to rebuild and measure every prefix of the object: quadratic, 45 s for 8 000.
  var object: [String: Any] = ["type": "note", "link": "/notes/n", "title": "wide"]
  for n in 0..<8_000 { object["column\(n)"] = "value \(n) " + String(repeating: "z", count: 20) }
  let raw = pretty(object)

  let started = Date()
  let shaped = ToolResultShaper.shape(raw, budgetBytes: 700)
  let seconds = Date().timeIntervalSince(started)

  check(seconds < 20, "8 000 members took \(String(format: "%.1f", seconds)) s")
  check(shaped.utf8.count <= 700 && parse(shaped) is [String: Any], "and what came out is a JSON object within the budget")
}

test("an id stays when the link beside it is empty, and an entityType when the type is null") {
  // Both used to vanish with the empty one: the id because ANY string link made it redundant, the entityType
  // because ANY `type` key did. A link and a type that are pruned themselves leave the other one standing.
  let filler = String(repeating: "padding ", count: 60)
  let emptyLink = ToolResultShaper.shape(
    pretty(["id": "note-17", "link": "", "title": "kept", "body": filler]), budgetBytes: 120)
  let nullType = ToolResultShaper.shape(
    "{\"entityType\":\"person\",\"type\":null,\"name\":\"kept\",\"body\":\"\(filler)\"}", budgetBytes: 120)

  check(emptyLink.contains("\"id\":\"note-17\""), "the id is the address when the link is empty: \(emptyLink)")
  check(nullType.contains("\"entityType\":\"person\""), "the entityType is the type when `type` is null: \(nullType)")

  // And they still go beside a link and a type that are there.
  let linked = ToolResultShaper.shape(
    pretty(["id": "note-17", "link": "/notes/note-17", "title": "kept", "body": filler]), budgetBytes: 160)
  check(!linked.contains("\"id\""), "the id beside a real link is redundant: \(linked)")
}

print("\n\(checks - failures) of \(checks) checks passed")
exit(failures == 0 ? 0 : 1)
