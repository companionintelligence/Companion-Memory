import Foundation

/// Binds CI's published intents to LiteRT-LM's tool calling — the iOS half of the on-device agent
/// harness, and the platform where the binding has to be written by hand.
///
/// **Why iOS looks different from Android.** LiteRT-LM's Swift `Tool` is a `Decodable` protocol
/// whose JSON Schema is produced by `Mirror`-reflecting compile-time `@ToolParam` properties
/// (`swift/Tool.swift`), and the Swift surface has no `OpenApiTool` equivalent — verified against
/// the vendored source: 18 public types, one tool protocol, no schema-string entry point. Android's
/// `OpenApiTool` *does* take a runtime schema string, so there one adapter covers every intent the
/// appliance publishes. Here each intent needs a struct, and a new server-side intent needs an app
/// release to become callable. That asymmetry is structural, not an oversight.
///
/// **What is still shared.** Both platforms read the same catalog and obey the same server-computed
/// `dispatch` ruling; neither re-derives the policy. Only the binding differs.
///
/// **Why the dependencies are static.** `ToolManager` stores only the *metatype* and constructs a
/// fresh instance per call ("These instances are used only for schema generation. Execution uses new
/// instances." — `swift/ToolManager.swift`), and `Tool: Decodable` + required `init()` means a
/// stored client property would break the synthesized conformance. So `run()` reaches the client
/// through this enum rather than through injection.
enum CompanionToolContext {
  /// Set by `LocalLLMPlugin.configureIntentTools`; nil disables tool calling entirely.
  static var client: CompanionIntentClient?

  /// The server's ruling per executable tool name, refreshed with the catalog.
  static var rulings: [String: DispatchRuling] = [:]

  /// The most bytes of one tool result handed back to the model when the window's room cannot be read
  /// (``windowTokensLeft``). `loadModel` sets it from the context window it just configured; until then it
  /// assumes a 1024-token window (the smallest ever shipped, Qwen3-0.6B's), so a result is bounded even if
  /// nothing did. See ``ToolResultShaper`` for why.
  static var resultBudgetBytes = LocalLLMPolicy.toolResultByteBudget(contextTokens: 1024)

  /// How many tokens the window has left right now, asked of the engine at the moment a tool runs. A
  /// result is then sized against the room there really is — earlier turns, the tool catalogue and the
  /// model's own call included — instead of a share of the window as configured. Set by the plugin; while
  /// it is `nil`, or answers `nil`, ``resultBudgetBytes`` applies. The on-device bench clears it to hold a
  /// budget fixed.
  static var windowTokensLeft: (@Sendable () async -> Int?)?

  /// Hand a JSON result back to the model as a parsed value rather than as text. LiteRT-LM writes a
  /// `String` response into the chat template as an escaped JSON string — every quote becomes `\"` —
  /// which costs tokens and is harder for a small model to read than the JSON itself.
  static var structuredResults = false
  /// Set by `LocalLLMPlugin.configureIntentTools` from the web layer's `connectionMode`: anything but
  /// `connected`. The phone's own search (`LocalSearchTool`) then answers `knowledge_search` ahead of
  /// the appliance's, whose call would fail anyway. UNCOMPILED — see LocalSearch.swift.
  static var localSearchPreferred = false

  /// Runs an intent after re-checking the server's ruling.
  ///
  /// The re-check is not redundant with registration: registration and invocation are separated by
  /// the whole lifetime of a loaded model, and this is the last chokepoint before a destructive or
  /// third-party-touching call would actually leave the device.
  ///
  /// The result is shaped to ``resultBudgetBytes`` before it goes back: the appliance returns the
  /// whole of it — tens of kilobytes for a search — which is far more than the model's context
  /// window can take in.
  static func execute(_ toolName: String, arguments: [String: Any]) async -> Any {
    guard let ruling = rulings[toolName], ruling.isExecutable else {
      return errorPayload(rulings[toolName]?.explanation ?? "\"\(toolName)\" may not run on this device")
    }
    guard let client else {
      return errorPayload("Companion is not connected to an appliance right now")
    }

    do {
      let result = try await client.callTool(toolName, arguments: arguments)
      let tokensLeft = await windowTokensLeft?()
      let budget = tokensLeft.map { LocalLLMPolicy.toolResultByteBudget(tokensLeft: $0) } ?? resultBudgetBytes
      let shaped = ToolResultShaper.shape(result, budgetBytes: budget)

      // Sizes and the tool's name only: what a tool returned is the user's data, not log material.
      NSLog(
        "[LocalLLM] %@ returned %ld bytes; passing %ld to the model (budget %ld, window left %ld tokens)",
        toolName, result.utf8.count, shaped.utf8.count, budget, tokensLeft ?? -1)

      return structuredResults ? asJSONValue(shaped) : shaped
    } catch {
      // Returned as content, not thrown: the model can then tell the user what failed or try a
      // different intent, whereas a thrown error aborts the whole generation.
      NSLog("[LocalLLM] %@ failed (%@)", toolName, String(describing: type(of: error)))

      return errorPayload(error.localizedDescription)
    }
  }

  /// The parsed JSON object or array, or `text` itself when it is neither (an error message, a cut-off
  /// string): only a container is worth handing over as a value.
  static func asJSONValue(_ text: String) -> Any {
    guard
      let value = try? JSONSerialization.jsonObject(with: Data(text.utf8), options: [.fragmentsAllowed]),
      value is [String: Any] || value is [Any]
    else { return text }

    return value
  }

  /// Refreshes the catalog and reports which of the known tools the appliance says may run here.
  ///
  /// Returns an empty list rather than throwing when the catalog can't be read: a model answering
  /// from its own weights is a worse assistant but still an assistant, whereas failing the load
  /// because the appliance is unreachable would make the offline tier depend on being online — the
  /// exact failure the on-device path exists to avoid.
  static func refreshRulings() async -> [any Tool] {
    let appliance = await refreshApplianceRulings()
    return withLocalSearch(appliance)
  }

  /// The phone's search joins the set when a replica is on this phone: in place of the appliance's
  /// `knowledge_search` while not connected, and as the whole set when the catalog gave none —
  /// which until 2026-10-22 left the model with no tools at all. Mirrors Android's
  /// `IntentToolProvider.toolsForLoad`. UNCOMPILED — see LocalSearch.swift.
  static func withLocalSearch(_ appliance: [any Tool]) -> [any Tool] {
    guard let store = LocalSearchStore.shared, store.isAvailable else { return appliance }
    let applianceSearch = appliance.contains { type(of: $0).name == LocalSearchTool.name && !($0 is LocalSearchTool) }
    if applianceSearch && !localSearchPreferred { return appliance }
    NSLog(localSearchPreferred
          ? "[LocalLLM] Not connected: knowledge_search answers from this phone's replica"
          : "[LocalLLM] The appliance offered no knowledge_search; this phone's replica answers it")
    return appliance.filter { !(type(of: $0).name == LocalSearchTool.name) } + [LocalSearchTool()]
  }

  private static func refreshApplianceRulings() async -> [any Tool] {
    guard let client else { return [] }

    do {
      let manifest = try await client.fetchManifest()

      rulings = Dictionary(
        manifest.intents.compactMap { intent in
          intent.dispatch.map { (intent.tool, $0) }
        },
        uniquingKeysWith: { first, _ in first })

      let executable = allTools.filter { rulings[type(of: $0).name]?.isExecutable == true }

      if manifest.tier == nil {
        // Pre-1.2.0 appliance: it ignored `?tier=local`, so no rulings came back and every tool
        // will refuse. Say so — silently toolless is indistinguishable from "no intents exist".
        NSLog(
          "[LocalLLM] Appliance returned no per-tier dispatch rulings (manifest %@); "
            + "no tools will be offered. Upgrade CI-Server to 1.2.0+ for on-device tool calling.",
          manifest.version)
      } else {
        // The success line: without it a working catalog is only the absence of the failure line
        // below. Android logs the same count from `IntentToolProvider`.
        NSLog(
          "[LocalLLM] Offering %ld of this app's %ld tools to the local model (the appliance publishes %ld intents)",
          executable.count, allTools.count, manifest.intents.count)
      }

      return executable
    } catch {
      NSLog("[LocalLLM] Intent catalog unavailable; the local model will run without tools: %@",
            error.localizedDescription)

      return []
    }
  }

  /// Every intent this app knows how to expose. Kept in sync with the appliance by hand — see the
  /// type comment for why iOS cannot generate these. Each tool's `@ToolParam`s must be same-named
  /// properties of that intent's published schema, and each `run()` must send exactly those:
  /// `IntentCatalogService.realTools.test.ts` (backend) checks it against the real tool classes.
  ///
  /// `memory.remember` is deliberately not offered. It is the appliance's intent for storing a fact,
  /// and it writes graph entities (`operations: [{ kind: "entity.create", … }]`), not a Note — no
  /// intent the local tier may run creates one. The flat `content` argument this app used to send is
  /// not in its schema, so every call failed validation; a model with no remember tool at least
  /// cannot be told "saved" by one.
  static var allTools: [any Tool] {
    [SearchMemoryTool(), RecallMemoryTool(), FindPeopleTool()]
  }

  /// The subset the appliance's last ruling says may run here. Empty when tools are disabled, the
  /// catalog was unreachable, or the appliance predates the tier-aware manifest.
  static func executableTools() -> [any Tool] {
    guard client != nil else { return [] }

    return allTools.filter { rulings[type(of: $0).name]?.isExecutable == true }
  }

  /// Drops the configured appliance and every cached ruling.
  static func disable() {
    client = nil
    rulings = [:]
  }

  static func errorPayload(_ message: String) -> String {
    let payload = ["error": message]
    let data = (try? JSONSerialization.data(withJSONObject: payload)) ?? Data()

    return String(decoding: data, as: UTF8.self)
  }
}

// MARK: - Tools
//
// `static let name` is already snake_case so it survives LiteRT-LM's camelCase→snake_case
// conversion (`ExperimentalFlags.convertCamelToSnakeCaseInToolDescription`, on by default) unchanged
// — these names must match the manifest's `tool` field exactly, since that is what MCP dispatches on.

/// `knowledge.search` — full-text search across the user's memory. This is the tool for "what do I
/// know about X", "when did I …" and "how many …": the appliance's `memory.recall` is a graph
/// lookup of a person, not a free-text or date search, so those questions belong here.
struct SearchMemoryTool: Tool {
  static let name = "knowledge_search"
  static let description =
    "Search the user's own memory (notes, messages, documents, people, places) for a word or phrase. "
    + "Use this for any question about what the user knows, did or saw."

  // Key words, not the question. Described as "in the user's own words" this parameter came back with filler
  // from the instruction ("search my memory for blue heron") in 94 of 134 Simulator calls, and a keyword
  // search for that sentence matches `search`, `my`, `memory` and `for`. With this description: 0 of 27
  // (`tests/local-llm-device/summarize.py --queries`).
  @ToolParam(description: "The key words to look for: a name, a place or a thing. Not the whole question")
  var query: String

  /// Newest first. The appliance orders by each entry's own time; without it the page is by relevance and a
  /// "most recent" question gets whatever ranked first (on a device: a message from 2022 ahead of 2025).
  @ToolParam(description: "Set to \"recent\" for newest first: most recent, latest, last")
  var sort: String?

  @ToolParam(description: "Only entries on or after this date, YYYY-MM-DD")
  var since: String?

  func run() async throws -> Any {
    var arguments: [String: Any] = ["query": query]
    // Omitted rather than sent as null: the appliance validates against the intent's JSON Schema.
    if let sort, !sort.isEmpty { arguments["sort"] = sort }
    if let since, !since.isEmpty { arguments["since"] = since }

    return await CompanionToolContext.execute(Self.name, arguments: arguments)
  }
}

/// `memory.recall` — look a person up in the user's knowledge graph, with who they are connected
/// to. That is all the intent does: its parameters are a graph query (`personName`, `filters`,
/// `traversal`, …), with no free-text or date range, so this exposes only `personName`. The
/// `query` / `startDate` / `endDate` this struct used to declare were not in the appliance's schema
/// and were silently dropped, leaving every call to return the user's own graph.
struct RecallMemoryTool: Tool {
  static let name = "memory_recall"
  static let description =
    "Look up a person in the user's memory graph and who they are connected to (family, friends, "
    + "colleagues). To search notes, messages or documents, use knowledge_search instead."

  @ToolParam(
    description: "A name, or a relationship such as \"my wife\". Leave out for the user's own connections")
  var personName: String?

  func run() async throws -> Any {
    var arguments: [String: Any] = [:]
    // Omitted rather than sent as null: the appliance validates against the intent's JSON Schema,
    // and an explicit null is not the same as an absent optional there. Left out, it starts from
    // the user themself (`useCurrentUser` defaults to true).
    if let personName { arguments["personName"] = personName }

    return await CompanionToolContext.execute(Self.name, arguments: arguments)
  }
}

/// `people.find` — look someone up.
struct FindPeopleTool: Tool {
  static let name = "people_find"
  static let description = "Find a person the user knows, and what the user knows about them."

  @ToolParam(description: "The person's name, or a description of them")
  var query: String

  func run() async throws -> Any {
    await CompanionToolContext.execute(Self.name, arguments: ["query": query])
  }
}
