import Foundation

// A verbatim snapshot of `ToolResultShaper` as it stood on main before the shaper was redesigned
// (PR #2938 version), kept ONLY so the device bench can measure the old and the new side by side.
// Nothing in the app uses it. Delete it when nobody needs the comparison.

// MARK: - Tool results

/// Bounds a tool's result before it goes back into the model's context window.
///
/// The appliance answers a tool call with the whole result, pretty-printed — 25 hydrated entities from
/// `knowledge.search` is ~40 KB of JSON, which its own chat harness measured and now bounds with
/// `boundToolResultForPrompt` (`backend/apps/api/src/domains/llm/toolResultBudget.ts`). On the phone
/// that text went straight into a 1024-token window already holding the system prompt and the tool
/// declarations — many times more than fits. How LiteRT-LM reacts to an input that large is what
/// ``GenerationFailure``'s logging is there to show; either way the model cannot answer from it.
/// This is that function's device twin, with the same shape of answer:
///
/// - a result that already fits is returned untouched;
/// - otherwise JSON is re-emitted compactly with each string capped, so one long message cannot eat
///   the budget, and each object's identifying fields (`type`, `link`, `title` …) written first so
///   that whatever a cut loses is prose, not the address of the thing;
/// - a search envelope (`{summary, …, items: […]}`) keeps its header whole and bounds only the list,
///   closing it with an element that says how many results were left out, so the text stays valid
///   JSON and the model knows the list was cut rather than exhaustive;
/// - anything else — not JSON, or JSON of another shape — is cut at the budget and says so.
///
/// Budgets are UTF-8 bytes, not characters: bytes are what a token budget is estimated from.
enum LegacyToolResultShaper {
  /// Below this a budget cannot hold the markers, so it is raised to it.
  static let minimumBudgetBytes = 64
  static let truncationMarker = "…[truncated]"
  /// Held back from the list's budget so the closing "N more omitted" element cannot itself overflow.
  private static let omissionReserveBytes = 96

  static func shape(_ text: String, budgetBytes: Int) -> String {
    let budget = max(budgetBytes, minimumBudgetBytes)

    guard text.utf8.count > budget else { return text }

    guard
      let value = try? JSONSerialization.jsonObject(
        with: Data(text.utf8), options: [.fragmentsAllowed])
    else { return truncated(text, to: budget) }

    let capped = capStrings(in: value, to: min(max(budget / 5, 48), 320))
    let shaped: String?

    if let items = capped as? [Any] {
      shaped = json(boundItems(items, budget: budget))
    } else if let object = capped as? [String: Any], let items = object["items"] as? [Any] {
      shaped = envelope(object, items: items, budget: budget)
    } else {
      shaped = json(capped)
    }

    // A capped-but-broken tail beats an overflowed window, which loses the whole turn.
    guard let shaped else { return truncated(text, to: budget) }

    return shaped.utf8.count <= budget ? shaped : truncated(shaped, to: budget)
  }

  /// Cuts `text` to `budget` bytes, at a character boundary, ending in ``truncationMarker``.
  static func truncated(_ text: String, to budget: Int) -> String {
    guard text.utf8.count > budget else { return text }

    let room = max(0, budget - truncationMarker.utf8.count)
    var used = 0
    var kept = String.UnicodeScalarView()

    for scalar in text.unicodeScalars {
      let width = UTF8.width(scalar)
      guard used + width <= room else { break }
      kept.append(scalar)
      used += width
    }

    return String(kept) + truncationMarker
  }

  /// Caps every string in `value` at `cap` characters. A communication's `content` is unbounded; the
  /// model needs the gist and the identifiers, not the transcript.
  private static func capStrings(in value: Any, to cap: Int) -> Any {
    switch value {
    case let string as String:
      return string.count > cap ? String(string.prefix(cap)) + "…" : string
    case let array as [Any]:
      return array.map { capStrings(in: $0, to: cap) }
    case let object as [String: Any]:
      return object.mapValues { capStrings(in: $0, to: cap) }
    default:
      return value
    }
  }

  /// Whole leading items until the budget is spent, then an element naming how many were dropped. If
  /// even the first item is over budget, a cut-down preview of it stands in for the nothing the loop
  /// would otherwise keep: the model gets part of what it asked for.
  private static func boundItems(_ items: [Any], budget: Int) -> [Any] {
    var kept: [Any] = []
    var spent = 2  // the list's own brackets

    for item in items {
      let cost = (json(item) ?? "null").utf8.count + (kept.isEmpty ? 0 : 1)
      guard spent + cost <= budget - omissionReserveBytes else { break }
      kept.append(item)
      spent += cost
    }

    var consumed = kept.count

    if kept.isEmpty, let first = items.first {
      kept.append(preview(of: first, room: max(0, budget - omissionReserveBytes)))
      consumed = 1
    }

    let omitted = items.count - consumed

    if omitted > 0 {
      kept.append("[\(omitted) more results omitted — refine the query to narrow them down]")
    }

    return kept
  }

  /// `{"truncated": true, "preview": "<the item's JSON, cut>"}`, no bigger than `room` bytes once
  /// serialised — the cut text is escaped inside the string, so it is shortened until *that* fits,
  /// not just the text.
  private static func preview(of item: Any, room: Int) -> [String: Any] {
    let text = json(item) ?? "null"
    let limit = room - 30  // what `{"truncated":true,"preview":…}` leaves for the string
    var allowance = max(0, limit)
    var cut = truncated(text, to: allowance)

    while allowance > 0, let escaped = json(cut), escaped.utf8.count > limit {
      allowance = max(0, allowance - (escaped.utf8.count - limit))
      cut = truncated(text, to: allowance)
    }

    return ["truncated": NSNumber(value: true), "preview": cut]
  }

  /// A search envelope: the header fields whole — `summary` first, the one sentence a small model
  /// reads reliably — then `items`, bounded by whatever the header left.
  private static func envelope(_ object: [String: Any], items: [Any], budget: Int) -> String? {
    var header = object
    header["items"] = nil

    guard let members = members(of: header) else { return nil }

    let lead = "{" + members.map { $0 + "," }.joined() + "\"items\":"
    let room = max(0, budget - lead.utf8.count - 1)  // the closing brace

    guard let list = json(boundItems(items, budget: room)) else { return nil }

    return lead + list + "}"
  }

  // MARK: Writing JSON

  /// Compact JSON for a parsed value, or nil when it has none (a non-finite number).
  ///
  /// Written out here instead of through `JSONSerialization.data` for three reasons. Foundation
  /// prints 0.8123 as 0.81230000000000002, which costs tokens and reads as noise. It raises an
  /// Objective-C exception on a non-finite number, which Swift cannot catch. And it orders keys
  /// alphabetically, where ``members(of:)`` writes what identifies an object first and the rest
  /// shortest-first, so a cut that has to lose something loses long prose before the identifiers
  /// — `content` sorts ahead of `id`, `link` and `title`.
  private static func json(_ value: Any) -> String? {
    switch value {
    case let string as String:
      return quoted(string)
    case let array as [Any]:
      var elements: [String] = []

      for element in array {
        guard let text = json(element) else { return nil }
        elements.append(text)
      }

      return "[" + elements.joined(separator: ",") + "]"
    case let object as [String: Any]:
      return members(of: object).map { "{" + $0.joined(separator: ",") + "}" }
    case let number as NSNumber:
      return literal(number)
    case is NSNull:
      return "null"
    default:
      return nil
    }
  }

  /// Keys written ahead of every other, in this order. `summary` is the search envelope's one
  /// sentence, which a small model reads reliably; `type` and `link` are on every search hit (the
  /// appliance adds them) and `link` is the only address the model may hand the user; `title`,
  /// `name` and `subject` are what the entities call themselves.
  private static let leadingKeys = ["summary", "type", "link", "title", "name", "subject"]

  /// An object's members as `"key":value` text: ``leadingKeys`` first, then the rest shortest value
  /// first (ties by key). Nil when any value has no JSON form.
  private static func members(of object: [String: Any]) -> [String]? {
    var entries: [(key: String, size: Int, member: String)] = []

    for (key, value) in object {
      guard let name = quoted(key), let text = json(value) else { return nil }
      entries.append((key, text.utf8.count, "\(name):\(text)"))
    }

    func rank(_ key: String) -> Int { leadingKeys.firstIndex(of: key) ?? leadingKeys.count }

    entries.sort { lhs, rhs in
      if rank(lhs.key) != rank(rhs.key) { return rank(lhs.key) < rank(rhs.key) }

      return (lhs.size, lhs.key) < (rhs.size, rhs.key)
    }

    return entries.map(\.member)
  }

  /// A string as a JSON literal. Slashes stay as they are: `\/` costs a byte apiece in every link.
  private static func quoted(_ string: String) -> String? {
    guard
      let data = try? JSONSerialization.data(
        withJSONObject: [string], options: [.withoutEscapingSlashes])
    else { return nil }

    // Without the brackets that were added around it.
    return String(decoding: data.dropFirst().dropLast(), as: UTF8.self)
  }

  /// A number as a JSON literal: `true`/`false` for a boolean (identified by type — 1 and 0 are
  /// numbers), the shortest form that reads back for a double, nil for one JSON cannot carry.
  private static func literal(_ number: NSNumber) -> String? {
    if CFGetTypeID(number) == CFBooleanGetTypeID() { return number.boolValue ? "true" : "false" }

    switch String(cString: number.objCType) {
    case "f", "d":
      let value = number.doubleValue

      return value.isFinite ? value.description : nil
    case "Q":
      return String(number.uint64Value)
    default:
      return String(number.int64Value)
    }
  }
}
