import Foundation

/// Runs a plan's cells one after another and appends one JSON line per cell to
/// `Documents/bench/results-<plan>.jsonl`, flushed as it goes.
///
/// Built to survive its own failures. The cell in flight is written to `in-flight-<plan>.txt` before
/// it starts; a process that dies mid-cell (jetsam is the interesting case: a context window too
/// large for the device) leaves that file behind, and the next launch records the cell as `crashed`
/// and moves on. Finished cells are skipped, so a run can be relaunched until it completes.
final class BenchRunner {
  private let plan: BenchPlan
  private let resultsURL: URL
  private let inFlightURL: URL
  private let statusURL: URL

  private var session: RawSession?
  private var engineKey: String?
  /// The app's own engine, for `prod` cells. Created lazily and kept: the plugin keeps one too.
  private var productionEngine: LocalLLMEngine?

  init(plan: BenchPlan) {
    self.plan = plan
    resultsURL = Bench.directory.appendingPathComponent("results-\(plan.id).jsonl")
    inFlightURL = Bench.directory.appendingPathComponent("in-flight-\(plan.id).txt")
    statusURL = Bench.directory.appendingPathComponent("status-\(plan.id).json")
  }

  // MARK: Plan

  func run() async {
    var finished = completedIds()

    if let stuck = try? String(contentsOf: inFlightURL, encoding: .utf8), !stuck.isEmpty,
      !finished.contains(stuck), let cell = plan.cells.first(where: { $0.id == stuck })
    {
      Bench.log("cell \(stuck) never finished: recording it as crashed")
      record(Self.failure(cell, status: "crashed", error: "the process ended during this cell"))
      finished.insert(stuck)
    }
    try? FileManager.default.removeItem(at: inFlightURL)

    let pending = plan.cells.filter { !finished.contains($0.id) }
    Bench.log("plan \(plan.id): \(pending.count) of \(plan.cells.count) cells to run")

    for (index, cell) in pending.enumerated() {
      writeStatus(running: cell.id, done: finished.count + index, total: plan.cells.count)
      try? cell.id.write(to: inFlightURL, atomically: true, encoding: .utf8)

      let result = await execute(cell)

      record(result)
      try? FileManager.default.removeItem(at: inFlightURL)

      if cell.restartAfter {
        Bench.log("restarting the process for the next cell")
        exit(0)
      }
    }

    session = nil
    writeStatus(running: nil, done: plan.cells.count, total: plan.cells.count)
    try? "done".write(
      to: Bench.directory.appendingPathComponent("DONE-\(plan.id)"), atomically: true, encoding: .utf8)
    Bench.log("plan \(plan.id) finished")
  }

  private func completedIds() -> Set<String> {
    guard let text = try? String(contentsOf: resultsURL, encoding: .utf8) else { return [] }

    var ids = Set<String>()

    for line in text.split(separator: "\n") {
      if let data = line.data(using: .utf8),
        let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
        let cell = object["cell"] as? [String: Any], let id = cell["id"] as? String
      {
        ids.insert(id)
      }
    }

    return ids
  }

  private func record(_ result: BenchResult) {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]

    guard let data = try? encoder.encode(result), let line = String(data: data, encoding: .utf8)
    else { return }

    Bench.append(line + "\n", to: resultsURL)
  }

  private func writeStatus(running: String?, done: Int, total: Int) {
    let status = "{\"plan\":\"\(plan.id)\",\"running\":\(running.map { "\"\($0)\"" } ?? "null"),\"done\":\(done),\"total\":\(total),\"at\":\"\(Date())\"}"

    try? status.write(to: statusURL, atomically: true, encoding: .utf8)
    Task { @MainActor in BenchConsole.shared.status = "\(done)/\(total) \(running ?? "done")" }
  }

  static func failure(_ cell: BenchCell, status: String, error: String) -> BenchResult {
    BenchResult(
      cell: cell, status: status, error: error, device: DeviceProbe.describe(), before: nil,
      after: nil, cooledSeconds: 0, load: nil, account: nil, turns: [], renders: nil, renderTokens: nil,
      startedAt: "\(Date())")
  }

  // MARK: One cell

  private func execute(_ cell: BenchCell) async -> BenchResult {
    Bench.log("▶ \(cell.id) [\(cell.mode)]")

    guard let info = LocalLLMModels.find(cell.model) else {
      return Self.failure(cell, status: "error", error: "unknown model \(cell.model)")
    }
    guard let file = try? LocalLLMModels.modelFile(info),
      FileManager.default.fileExists(atPath: file.path)
    else {
      return Self.failure(cell, status: "error", error: "model file not on the device: \(info.fileName)")
    }

    await DeviceProbe.waitForPower()
    let cooled = await DeviceProbe.coolDown()
    var result = BenchResult(
      cell: cell, status: "ok", error: nil, device: DeviceProbe.describe(),
      before: DeviceProbe.snapshot(), after: nil, cooledSeconds: cooled, load: nil, account: nil,
      turns: [], renders: nil, renderTokens: nil, startedAt: "\(Date())")

    if cell.mode == "prod" {
      await executeProduction(cell, info: info, file: file, into: &result)
      result.after = DeviceProbe.snapshot()

      return result
    }

    let accelerator =
      cell.accelerator.flatMap(LocalLLMAccelerator.init(rawValue:)) ?? info.accelerators.first ?? .cpu
    let maxTokens = cell.maxTokens ?? info.defaultMaxTokens
    let key = "\(cell.model)|\(accelerator.rawValue)|\(maxTokens)|\(cell.prefillChunk ?? 0)|\(cell.threads ?? 0)"

    // Opening the engine is itself the measurement for `load`, so it is never reused there.
    if cell.mode == "load" || engineKey != key || session == nil {
      session = nil
      engineKey = nil
      // Let the old engine's memory go back before the new one asks for its own.
      try? await Task.sleep(nanoseconds: 500_000_000)

      let before = DeviceProbe.snapshot()
      let loadPeak = PeakSampler()
      loadPeak.start()

      do {
        let opened = try await RawSession.open(
          path: file.path, accelerator: accelerator, maxTokens: maxTokens,
          prefillChunk: cell.prefillChunk, threads: cell.threads)
        let after = DeviceProbe.snapshot()

        session = opened
        engineKey = key
        result.load = LoadRecord(
          accelerator: accelerator.rawValue, loadMs: Int(opened.loadSeconds * 1000),
          footprintBeforeMB: before.footprintMB, footprintAfterMB: after.footprintMB,
          availableBeforeMB: before.availableMB, availableAfterMB: after.availableMB,
          peak: loadPeak.stop())
        Bench.log(
          "  loaded on \(accelerator.rawValue) in \(Int(opened.loadSeconds * 1000)) ms, window \(maxTokens), footprint \(Int(after.footprintMB)) MB, \(Int(after.availableMB)) MB left")
      } catch {
        _ = loadPeak.stop()
        result.status = "load_failed"
        result.error = GenerationFailure.reason(for: error)
        Bench.log("  load failed: \(result.error ?? "")")

        return result
      }
    }

    guard let session else { return result }

    let tools: [any Tool] =
      cell.bindTools && (info.capabilities.contains(.tools) || cell.forceTools)
      ? LocalLLMPolicy.toolsToBind(
        CompanionToolContext.executableTools(), capabilities: [.tools]
      ).filter { cell.toolNames?.contains(type(of: $0).name) ?? true } : []

    let spec = RawSession.ConversationSpec(
      topK: cell.topK ?? info.defaultTopK, topP: Float(cell.topP ?? Double(info.defaultTopP)),
      temperature: Float(cell.temperature ?? Double(info.defaultTemperature)), seed: cell.seed,
      tools: cell.mode == "inject" || cell.mode == "chat" ? [] : tools,
      system: Self.systemText(for: cell, hasTools: !tools.isEmpty), constrained: cell.constrained)

    do {
      try await session.begin(spec)
    } catch {
      result.status = "error"
      result.error = "conversation: \(GenerationFailure.reason(for: error))"

      return result
    }

    switch cell.mode {
    case "account":
      result.account = await account(cell, session: session, info: info, tools: tools)
    case "render":
      (result.renders, result.renderTokens) = await renders(cell, session: session)
    default:
      result.turns = await turns(cell, session: session)
    }

    await session.end()
    result.after = DeviceProbe.snapshot()

    if let last = result.turns.last {
      Bench.log(
        "  ← \(last.answerTokens.map(String.init) ?? "?") tokens in \(last.totalMs) ms, score useful=\(last.score.useful) grounded=\(last.score.groundedGroups) clean=\(last.score.clean) | \(last.answer.prefix(110).replacingOccurrences(of: "\n", with: " "))"
      )
    }

    return result
  }

  private static func systemText(for cell: BenchCell, hasTools: Bool) -> String? {
    switch cell.system {
    case "none":
      return nil
    case "terse":
      return "Answer from the tool result in one or two short sentences. If it does not contain the answer, say so."
    case "grounded":
      return LocalLLMEngine.toolSystemInstruction
        + " Answer in at most three short sentences, using only what the tool returned."
    case "imperative":
      return "You are Companion, answering questions about the user's own memory on their device. "
        + "For ANY question about the user's own notes, messages, people, places or past, you MUST call a tool "
        + "first; never answer such a question from your own knowledge. After the tool's result arrives, answer "
        + "in one or two short sentences using only what it contains, and say so if it does not contain the answer."
    case "custom":
      return cell.systemText
    default:
      // What the app does: a system message only when there are tools to explain.
      return hasTools ? LocalLLMEngine.toolSystemInstruction : nil
    }
  }

  // MARK: The app's own engine

  /// A cell through `LocalLLMEngine`, set up the way `LocalLLMPlugin.loadModel` sets it up: the tools the
  /// appliance's ruling allows, the load request resolved against the model's catalog entry, the tool
  /// result budget taken from the window just configured. Whatever the experiments chose has to hold
  /// here, because this is what ships. `maxTokens`, the sampler and `toolBudget` are overrides; left
  /// out, they are the catalog's and the policy's.
  private func executeProduction(
    _ cell: BenchCell, info: LocalLLMModelInfo, file: URL, into result: inout BenchResult
  ) async {
    session = nil
    engineKey = nil

    let engine = productionEngine ?? LocalLLMEngine()
    productionEngine = engine

    let tools = LocalLLMPolicy.toolsToBind(
      CompanionToolContext.executableTools(), capabilities: info.capabilities)
    let request = LocalLLMLoadRequest(
      path: file.path, info: info, tools: tools,
      requestedAccelerator: cell.accelerator.flatMap(LocalLLMAccelerator.init(rawValue:)),
      wantsSpeculativeDecoding: false, maxTokens: cell.maxTokens, topK: cell.topK,
      topP: cell.topP, temperature: cell.temperature)

    // A cell that names a budget holds it; one that does not gets what the app gets: the result sized
    // against the room the window has at the moment the tool runs.
    CompanionToolContext.resultBudgetBytes =
      cell.toolBudget ?? LocalLLMPolicy.toolResultByteBudget(contextTokens: request.maxTokens)
    if cell.toolBudget == nil {
      CompanionToolContext.windowTokensLeft = { [engine] in await engine.contextTokensLeft() }
    } else {
      CompanionToolContext.windowTokensLeft = nil
    }
    CompanionToolContext.structuredResults = cell.responseAs == "object"

    let before = DeviceProbe.snapshot()
    let loadPeak = PeakSampler()
    loadPeak.start()
    let started = ProcessInfo.processInfo.systemUptime

    do {
      let outcome = try await engine.load(request)
      let after = DeviceProbe.snapshot()

      result.load = LoadRecord(
        accelerator: outcome.accelerator.rawValue,
        loadMs: Int((ProcessInfo.processInfo.systemUptime - started) * 1000),
        footprintBeforeMB: before.footprintMB, footprintAfterMB: after.footprintMB,
        availableBeforeMB: before.availableMB, availableAfterMB: after.availableMB,
        peak: loadPeak.stop())
    } catch {
      _ = loadPeak.stop()
      result.status = "load_failed"
      result.error = GenerationFailure.reason(for: error)

      return
    }

    do {
      try await engine.resetConversation()
    } catch {
      result.status = "error"
      result.error = "reset: \(GenerationFailure.reason(for: error))"

      return
    }

    let order = ["p1", "p2", "p3"]
    let first = order.firstIndex(of: cell.prompt) ?? 0

    for index in 0..<max(cell.turns, 1) {
      let prompt = Corpus.prompts[order[(first + index) % order.count]] ?? Corpus.prompts["p1"]!
      result.turns.append(await productionTurn(cell, engine: engine, prompt: prompt))
    }
  }

  private func productionTurn(
    _ cell: BenchCell, engine: LocalLLMEngine, prompt: BenchPrompt
  ) async -> TurnRecord {
    let recorder = ToolRecorder()
    let budget = CompanionToolContext.resultBudgetBytes

    FakeAppliance.shared.handler = { name, arguments in
      let raw = Corpus.result(tool: name, arguments: arguments)
      let argumentsText = String(
        decoding: (try? JSONSerialization.data(withJSONObject: arguments, options: [.sortedKeys])) ?? Data(),
        as: UTF8.self)

      recorder.calls.append(
        ToolCallRecord(
          tool: name, arguments: argumentsText, rawBytes: raw.utf8.count,
          shapedBytes: ToolResultShaper.shape(raw, budgetBytes: budget).utf8.count, rawTokens: nil,
          shapedTokens: nil, renderedBytes: nil, renderedTokens: nil,
          kvAtCall: await engine.contextTokensUsed(), msFromRequest: recorder.msSinceStart(),
          renderedText: nil))
      recorder.returnedAt = ProcessInfo.processInfo.systemUptime

      return raw
    }

    recorder.start()
    let peakSampler = PeakSampler()
    peakSampler.start()
    let started = ProcessInfo.processInfo.systemUptime
    let kvBefore = await engine.contextTokensUsed()

    var answer = ""
    var thought = ""
    var stats: GenerationStats?
    var failure: String?
    var firstChunkMs: Int?

    do {
      let stream = try await engine.generate(prompt: prompt.text, enableThinking: cell.thinking)

      for try await event in stream {
        switch event {
        case .delta(let text, let reasoning):
          if firstChunkMs == nil { firstChunkMs = Int((ProcessInfo.processInfo.systemUptime - started) * 1000) }
          answer += text
          thought += reasoning
        case .finished(let outcome):
          stats = outcome.stats
        }
      }
    } catch {
      failure = GenerationFailure.reason(for: error)
    }

    let totalMs = Int((ProcessInfo.processInfo.systemUptime - started) * 1000)
    let peak = peakSampler.stop()

    return TurnRecord(
      prompt: prompt.text, answer: answer, thought: thought, raw: "", rawThought: "",
      chunks: stats?.outputTokens ?? 0, answerTokens: stats?.outputTokens, rawTokens: nil,
      promptTokens: nil, totalMs: totalMs, firstChunkMs: firstChunkMs ?? stats?.timeToFirstTokenMs,
      postToolFirstChunkMs: nil, postToolDecodeTokensPerSecond: stats?.decodeTokensPerSecond,
      toolCalls: recorder.calls, kvBefore: kvBefore, kvAfter: await engine.contextTokensUsed(),
      error: failure, peak: peak,
      score: Scoring.score(answer: answer, thought: thought, prompt: prompt))
  }

  // MARK: Turns

  private func turns(_ cell: BenchCell, session: RawSession) async -> [TurnRecord] {
    let order = ["p1", "p2", "p3"]
    let first = order.firstIndex(of: cell.prompt) ?? 0
    var records: [TurnRecord] = []

    for index in 0..<max(cell.turns, 1) {
      let prompt = Corpus.prompts[order[(first + index) % order.count]] ?? Corpus.prompts["p1"]!
      records.append(await oneTurn(cell, session: session, prompt: prompt))
    }

    return records
  }

  private func oneTurn(_ cell: BenchCell, session: RawSession, prompt: BenchPrompt) async -> TurnRecord {
    let budget = cell.toolBudget ?? Int.max / 4
    let recorder = ToolRecorder()
    var text = prompt.text

    if cell.mode == "load" {
      text = "Say hello in five words."
    } else if cell.mode == "inject" {
      let raw = Corpus.result(tool: "knowledge_search", arguments: ["query": prompt.keys[0]])
      let shaped = ShaperLab.shape(raw, variant: cell.shaper, budget: budget)
      text = "Here is what my memory search found:\n\(shaped)\n\nUsing only that, \(prompt.text)"
      recorder.calls.append(
        ToolCallRecord(
          tool: "inject", arguments: "{}", rawBytes: raw.utf8.count, shapedBytes: shaped.utf8.count,
          rawTokens: await session.tokens(of: raw), shapedTokens: await session.tokens(of: shaped),
          renderedBytes: nil, renderedTokens: nil, kvAtCall: nil, msFromRequest: 0, renderedText: nil))
    }

    // What the appliance answers a tool call with — and what is recorded about it.
    CompanionToolContext.resultBudgetBytes = budget
    CompanionToolContext.windowTokensLeft = nil  // the budget is the experiment's, so it is held fixed
    CompanionToolContext.structuredResults = cell.responseAs == "object"
    FakeAppliance.shared.handler = { name, arguments in
      let raw = Corpus.result(tool: name, arguments: arguments)
      let handed = cell.shaper == "prod" ? raw : ShaperLab.shape(raw, variant: cell.shaper, budget: budget)
      // `CompanionToolContext.execute` bounds whatever it is given, so what reaches the model is this:
      let shaped = ToolResultShaper.shape(handed, budgetBytes: budget)
      let kv = await session.kvTokens()
      let argumentsText = String(
        decoding: (try? JSONSerialization.data(withJSONObject: arguments, options: [.sortedKeys])) ?? Data(),
        as: UTF8.self)

      recorder.calls.append(
        ToolCallRecord(
          tool: name, arguments: argumentsText, rawBytes: raw.utf8.count,
          shapedBytes: shaped.utf8.count, rawTokens: await session.tokens(of: raw),
          shapedTokens: await session.tokens(of: shaped), renderedBytes: nil, renderedTokens: nil,
          kvAtCall: kv, msFromRequest: recorder.msSinceStart(), renderedText: nil))
      recorder.returnedAt = ProcessInfo.processInfo.systemUptime

      return handed
    }

    recorder.start()
    let peakSampler = PeakSampler()
    peakSampler.start()

    let turn = await session.turn(
      prompt: text, thinking: cell.thinking, carryContext: cell.carry,
      maxReplyTokens: cell.maxReplyTokens)

    let peak = peakSampler.stop()
    var postFirst: Int?
    var postRate: Double?

    if let returned = recorder.returnedAt {
      let after = turn.chunkTimes.filter { $0 > returned }

      if let first = after.first { postFirst = Int((first - returned) * 1000) }
      if after.count >= 4, let first = after.first, let last = after.last, last > first {
        postRate = (Double(after.count - 1) / (last - first) * 10).rounded() / 10
      }
    }

    let scoring = cell.mode == "load" ? nil : prompt

    return TurnRecord(
      prompt: text, answer: turn.answer, thought: turn.thought, raw: turn.raw,
      rawThought: turn.rawThought, chunks: turn.chunks,
      answerTokens: await session.tokens(of: turn.answer),
      rawTokens: await session.tokens(of: turn.raw + turn.rawThought),
      promptTokens: await session.tokens(of: text), totalMs: turn.totalMs,
      firstChunkMs: turn.firstChunkMs, postToolFirstChunkMs: postFirst,
      postToolDecodeTokensPerSecond: postRate, toolCalls: recorder.calls, kvBefore: turn.kvBefore,
      kvAfter: turn.kvAfter, error: turn.error, peak: peak,
      score: Scoring.score(answer: turn.answer, thought: turn.thought, prompt: scoring))
  }

  // MARK: Rendering

  /// What the chat template makes of each kind of message, and what it costs in tokens. No generation.
  private func renders(_ cell: BenchCell, session: RawSession) async -> ([String: String], [String: Int]) {
    let prompt = Corpus.prompts[cell.prompt] ?? Corpus.prompts["p1"]!
    let raw = Corpus.result(tool: "knowledge_search", arguments: ["query": prompt.keys[0]])
    let budget = cell.toolBudget ?? 1024
    let shaped = ShaperLab.shape(raw, variant: cell.shaper, budget: budget)
    let arguments: [String: Any] = ["query": prompt.keys[0]]
    let messages: [(String, [String: Any])] = [
      ("user", ["role": "user", "content": [["type": "text", "text": prompt.text]]]),
      (
        "assistant-call",
        [
          "role": "model",
          "tool_calls": [["type": "function", "function": ["name": "knowledge_search", "arguments": arguments]]],
        ]
      ),
      (
        "tool-as-string",
        ["role": "tool", "content": [["type": "tool_response", "name": "knowledge_search", "response": shaped]]]
      ),
      (
        "tool-as-object",
        [
          "role": "tool",
          "content": [["type": "tool_response", "name": "knowledge_search", "response": Self.parsed(shaped)]],
        ]
      ),
    ]

    var texts: [String: String] = [:]
    var tokens: [String: Int] = [:]

    for (name, message) in messages {
      guard let text = await session.render(message) else { continue }

      texts[name] = text
      if let count = await session.tokens(of: text) { tokens[name] = count }
    }

    texts["shaped"] = shaped
    tokens["shaped"] = await session.tokens(of: shaped) ?? 0

    return (texts, tokens)
  }

  /// The shaped text as a JSON value, or the text itself when it is not JSON.
  static func parsed(_ text: String) -> Any {
    (try? JSONSerialization.jsonObject(with: Data(text.utf8), options: [.fragmentsAllowed])) ?? text
  }

  // MARK: Context accounting

  /// What the fixed part of the window costs: the rendered preface under each configuration, read
  /// with the model's own tokenizer.
  private func account(
    _ cell: BenchCell, session: RawSession, info: LocalLLMModelInfo, tools: [any Tool]
  ) async -> AccountRecord {
    let system = LocalLLMEngine.toolSystemInstruction
    var record = AccountRecord(perToolDeclarationTokens: [:])

    func spec(system: String?, tools: [any Tool]) -> RawSession.ConversationSpec {
      RawSession.ConversationSpec(
        topK: info.defaultTopK, topP: info.defaultTopP, temperature: info.defaultTemperature,
        seed: 0, tools: tools, system: system)
    }

    func prefaceTokens(_ spec: RawSession.ConversationSpec) async -> (tokens: Int?, text: String?) {
      do { try await session.begin(spec) } catch { return (nil, nil) }

      let text = await session.preface()

      return (await text.asyncFlatMap { await session.tokens(of: $0) }, text)
    }

    record.prefaceNoSystemNoTools = await prefaceTokens(spec(system: nil, tools: [])).tokens
    record.prefaceSystemOnly = await prefaceTokens(spec(system: system, tools: [])).tokens
    record.systemInstructionTokens = await session.tokens(of: system)

    for tool in tools {
      let name = type(of: tool).name
      let alone = await prefaceTokens(spec(system: system, tools: [tool])).tokens

      if let alone, let base = record.prefaceSystemOnly { record.perToolDeclarationTokens[name] = alone - base }
    }

    let all = await prefaceTokens(spec(system: system, tools: tools))

    record.prefaceSystemAndTools = all.tokens
    record.prefaceSystemAndToolsBytes = all.text?.utf8.count
    record.prefaceText = all.text
    record.kvRightAfterCreate = await session.kvTokens()

    return record
  }
}

/// What a turn's tool calls did, collected from the fake appliance's side.
final class ToolRecorder: @unchecked Sendable {
  var calls: [ToolCallRecord] = []
  var returnedAt: Double?
  private var startedAt: Double = 0

  func start() { startedAt = ProcessInfo.processInfo.systemUptime }

  func msSinceStart() -> Int { Int((ProcessInfo.processInfo.systemUptime - startedAt) * 1000) }
}

extension Optional {
  func asyncFlatMap<T>(_ transform: (Wrapped) async -> T?) async -> T? {
    guard let value = self else { return nil }

    return await transform(value)
  }
}
