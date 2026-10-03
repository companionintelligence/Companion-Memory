import Foundation

/// One measurement: a model, a context window, a way of shaping the tool result, a sampler, a
/// question — and what to record. A plan is a list of these; every field has a default so a plan
/// file only says what differs.
struct BenchCell: Codable {
  var id: String
  /// `load` (open the engine, say hello), `tool` (a tool-calling turn), `chat` (no tools, no
  /// retrieval), `inject` (the shaped result is put in the prompt: for a model without tool slots),
  /// `account` (what the preface and the tool schemas cost), `prod` (a tool turn through the real
  /// `LocalLLMEngine`).
  var mode = "tool"
  var model = "qwen3-0.6b-int4"
  var accelerator: String?
  /// The KV cache: input plus output tokens. `nil` is the catalog default the app ships.
  var maxTokens: Int?
  var topK: Int?
  var topP: Double?
  var temperature: Double?
  var seed = 0
  /// Bind the three intent tools. A model without the `tools` capability only gets them with
  /// `forceTools`, which is how the bench finds out whether its template would honour them.
  var bindTools = true
  var forceTools = false
  /// `shipped` (the app's system instruction), `none`, `terse`, `grounded`, or `custom` with `systemText`.
  var system = "shipped"
  var systemText: String?
  /// The most bytes of tool result handed back. `nil` means unshaped, as the app did before #2938.
  var toolBudget: Int?
  /// `legacy` is `ToolResultShaper` as it was on main, `prod` as it is now (see `ShaperLab`).
  var shaper = "prod"
  var prompt = "p1"
  /// `enable_thinking` on the first request.
  var thinking = false
  /// Carry that setting through the tool-result request. `false` is what the app does today.
  var carry = true
  var maxReplyTokens: Int?
  /// How many questions are asked in a row in one conversation (p1, p2, p3, p1, …).
  var turns = 1
  /// `string` hands the model the tool's answer as text, as the app does; `object` parses it first, so
  /// the chat template writes it as JSON instead of as an escaped string of JSON.
  var responseAs = "string"
  /// LiteRT-LM's constrained decoding for tool calls (`ExperimentalFlags.enableConversationConstrainedDecoding`),
  /// which the app leaves off until someone has run it on a device.
  var constrained = false
  /// End the process after this cell, so the next one starts from a clean address space. A memory
  /// reading taken in a process that has already held another engine includes whatever the allocator
  /// kept; the launcher starts the app again and the plan carries on.
  var restartAfter = false
  /// `EngineConfig.prefillChunkSize` and `.numThreads`: how a long prefill is fed in, and how many threads.
  var prefillChunk: Int?
  var threads: Int?
  /// Bind only these of the offered tools (by name); `nil` binds them all.
  var toolNames: [String]?
  var note: String?
}

struct BenchPlan: Codable {
  var id: String
  var cells: [BenchCell]
}

extension BenchCell {
  /// A plan file may leave anything out. Decoded through optionals so a missing key means "default".
  struct Sparse: Codable {
    var id: String
    var mode: String?
    var model: String?
    var accelerator: String?
    var maxTokens: Int?
    var topK: Int?
    var topP: Double?
    var temperature: Double?
    var seed: Int?
    var bindTools: Bool?
    var forceTools: Bool?
    var system: String?
    var systemText: String?
    var toolBudget: Int?
    var shaper: String?
    var prompt: String?
    var thinking: Bool?
    var carry: Bool?
    var maxReplyTokens: Int?
    var turns: Int?
    var responseAs: String?
    var constrained: Bool?
    var restartAfter: Bool?
    var prefillChunk: Int?
    var threads: Int?
    var toolNames: [String]?
    var note: String?
  }

  init(_ sparse: Sparse) {
    self.init(id: sparse.id)
    mode = sparse.mode ?? mode
    model = sparse.model ?? model
    accelerator = sparse.accelerator
    maxTokens = sparse.maxTokens
    topK = sparse.topK
    topP = sparse.topP
    temperature = sparse.temperature
    seed = sparse.seed ?? seed
    bindTools = sparse.bindTools ?? bindTools
    forceTools = sparse.forceTools ?? forceTools
    system = sparse.system ?? system
    systemText = sparse.systemText
    toolBudget = sparse.toolBudget
    shaper = sparse.shaper ?? shaper
    prompt = sparse.prompt ?? prompt
    thinking = sparse.thinking ?? thinking
    carry = sparse.carry ?? carry
    maxReplyTokens = sparse.maxReplyTokens
    turns = sparse.turns ?? turns
    responseAs = sparse.responseAs ?? responseAs
    constrained = sparse.constrained ?? constrained
    restartAfter = sparse.restartAfter ?? restartAfter
    prefillChunk = sparse.prefillChunk
    threads = sparse.threads
    toolNames = sparse.toolNames
    note = sparse.note
  }
}

// MARK: - Results

struct ToolCallRecord: Codable {
  var tool: String
  var arguments: String
  var rawBytes: Int
  var shapedBytes: Int
  var rawTokens: Int?
  var shapedTokens: Int?
  /// How the shaped result is rendered into the prompt (bytes of the rendered tool message), when readable.
  var renderedBytes: Int?
  var renderedTokens: Int?
  /// KV tokens the instant the tool was called: preface + question + the model's own tool call.
  var kvAtCall: Int?
  var msFromRequest: Int
  /// The tool message as the chat template wrote it (what the model actually reads).
  var renderedText: String?
}

struct TurnRecord: Codable {
  var prompt: String
  var answer: String
  var thought: String
  var raw: String
  var rawThought: String
  var chunks: Int
  var answerTokens: Int?
  var rawTokens: Int?
  var promptTokens: Int?
  var totalMs: Int
  var firstChunkMs: Int?
  /// Milliseconds from the tool's result being handed back to the first answer chunk (the prefill of
  /// the result, the template and the model's start-up on it).
  var postToolFirstChunkMs: Int?
  var postToolDecodeTokensPerSecond: Double?
  var toolCalls: [ToolCallRecord]
  var kvBefore: Int?
  var kvAfter: Int?
  var error: String?
  /// The worst the process looked during this turn (see `PeakSampler`).
  var peak: PeakSampler.Result?
  var score: Score
}

struct AccountRecord: Codable {
  /// Tokens of the rendered preface (system message and tool declarations) for each configuration.
  var prefaceNoSystemNoTools: Int?
  var prefaceSystemOnly: Int?
  var prefaceSystemAndTools: Int?
  var prefaceSystemAndToolsBytes: Int?
  var systemInstructionTokens: Int?
  var kvRightAfterCreate: Int?
  var perToolDeclarationTokens: [String: Int]
  var prefaceText: String?
}

struct LoadRecord: Codable {
  var accelerator: String
  var loadMs: Int
  var footprintBeforeMB: Double
  var footprintAfterMB: Double
  var availableBeforeMB: Double
  var availableAfterMB: Double
  var peak: PeakSampler.Result?
}

struct BenchResult: Codable {
  var cell: BenchCell
  /// `ok`, `load_failed`, `crashed` (the process died during the cell), `error`.
  var status: String
  var error: String?
  var device: [String: String]
  var before: DeviceProbe.Snapshot?
  var after: DeviceProbe.Snapshot?
  var cooledSeconds: Int
  var load: LoadRecord?
  var account: AccountRecord?
  var turns: [TurnRecord]
  /// `render` mode: message → the text the template made of it, and its length in tokens.
  var renders: [String: String]?
  var renderTokens: [String: Int]?
  var startedAt: String
}
