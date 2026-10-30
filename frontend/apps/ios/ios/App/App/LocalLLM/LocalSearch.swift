import Foundation

/// `knowledge_search` answered from the phone's PowerSync replica — the iOS half of Android's
/// `LocalSearch.kt` / `LocalSearchTool.kt`. Same lean parameters as `SearchMemoryTool` (the
/// appliance's tool), same result envelope (`summary`, `totalMatches`, `truncated`, `limit`,
/// `mode`, `items`) with `mode: "local"` and a lean hit: title, text, time, display fields.
///
/// Bound by `CompanionToolContext.refreshRulings` in place of `SearchMemoryTool` while the app is
/// not connected (`localSearchPreferred`), and as the whole tool set when the appliance's catalog
/// cannot be fetched — which used to leave the model with no tools at all.
struct LocalSearchTool: Tool {
  static let name = "knowledge_search"
  static let description =
    "Search everything you have: people, places, notes, messages, files, events. "
    + "For \"most recent\" or \"latest\" set sort to recent. "
    + "For \"how many\" questions set countOnly and use one specific word."

  @ToolParam(description: "Keywords to search for")
  var query: String?

  @ToolParam(description: "Only these kinds: communication, content, file, event, note, person, place, receipt, task")
  var entityTypes: [String]?

  @ToolParam(description: "Only entries on or after this date, YYYY-MM-DD")
  var since: String?

  @ToolParam(description: "Only entries on or before this date, YYYY-MM-DD")
  var until: String?

  @ToolParam(description: "recent = newest first. Use for \"most recent\", \"latest\", \"last\"")
  var sort: String?

  @ToolParam(description: "Return only the exact count, no items")
  var countOnly: Bool?

  func run() async throws -> Any {
    guard let store = LocalSearchStore.shared, store.isAvailable else {
      return CompanionToolContext.errorPayload("This phone has no saved copy of your memory to search")
    }

    let args = LocalSearchArgs(
      query: query ?? "", entityTypes: entityTypes ?? [], since: since, until: until, sort: sort,
      countOnly: countOnly ?? false)

    do {
      let result = try store.run(args)
      let tokensLeft = await CompanionToolContext.windowTokensLeft?()
      let budget = tokensLeft.map { LocalLLMPolicy.toolResultByteBudget(tokensLeft: $0) }
        ?? CompanionToolContext.resultBudgetBytes
      let shaped = ToolResultShaper.shape(result, budgetBytes: budget)
      NSLog("[LocalLLM] knowledge_search (phone) returned %ld bytes; passing %ld to the model (budget %ld)",
            result.utf8.count, shaped.utf8.count, budget)
      return CompanionToolContext.structuredResults ? CompanionToolContext.asJSONValue(shaped) : shaped
    } catch {
      return CompanionToolContext.errorPayload(
        "This phone's copy of your memory could not be searched: \(error.localizedDescription)")
    }
  }
}
