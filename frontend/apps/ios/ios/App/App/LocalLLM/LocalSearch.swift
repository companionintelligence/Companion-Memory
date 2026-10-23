import Foundation
import SQLite3

// UNCOMPILED (2026-10-22): written on Linux alongside the Android port; build and run on a Mac before
// relying on it. Three things to check first: that the SQLCipher pod the SQLite plugin links exports
// `sqlite3_key` to this target (it is the same libsqlite3 symbol set plus the key functions); that
// `UtilsSecret.getPassphrase(account:)` from `@capacitor-community/sqlite` is reachable from here, or
// else read the keychain item it stores directly (service `unlockSecret`, account `<iosKeychainPrefix>`
// + `secret`, see the plugin's `UtilsSecret.swift`); and that the replica lives at
// `Library/CapacitorDatabase/<dbName>SQLite.db`, where that plugin keeps its files on iOS.

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

struct LocalSearchArgs {
  var query: String = ""
  var entityTypes: [String] = []
  var since: String?
  var until: String?
  var sort: String?
  var countOnly = false
}

/// Reads the replica read-only through SQLCipher, keyed with the SQLite plugin's passphrase. The SQL
/// is `LocalSearch.kt`'s: a text query drives through the FTS index with the type term kept off the
/// type index (`+d.entity_type`), a broad time-ordered scope walks the time index the same way.
final class LocalSearchStore {
  /// Set by `LocalLLMPlugin.configureIntentTools` from `localSearch.databaseFile`; nil when the phone has no replica.
  static var shared: LocalSearchStore?

  static let leanEntityTypes = ["communication", "content", "file", "event", "note", "person", "place", "receipt", "task"]
  private static let bulkTypes: Set<String> = ["communication", "event", "content"]
  private static let pageLimit = 25

  private let fileURL: URL
  private let keychainAccount: String

  init(databaseFile: String, keychainPrefix: String) {
    // Where @capacitor-community/sqlite keeps its databases on iOS.
    let library = FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask)[0]
    fileURL = library.appendingPathComponent("CapacitorDatabase").appendingPathComponent(databaseFile)
    keychainAccount = keychainPrefix + "secret"
  }

  var isAvailable: Bool {
    FileManager.default.fileExists(atPath: fileURL.path) && !passphrase().isEmpty
  }

  private func passphrase() -> String {
    UtilsSecret.getPassphrase(account: keychainAccount)
  }

  struct Row {
    let entityType: String
    let entityId: String
    let title: String?
    let body: String?
    let occurredAt: String?
    let detail: String?
  }

  enum StoreError: Error { case open(String), key, prepare(String) }

  func run(_ args: LocalSearchArgs) throws -> String {
    let db = try open()
    defer { sqlite3_close(db) }

    let scope = Self.scope(args)
    let query = args.query.trimmingCharacters(in: .whitespaces)
    let total = try Self.countStatement(args).map { try count(db, $0) } ?? 0

    if args.countOnly {
      return Self.envelope(
        summary: Self.describeCount(total, query: query.isEmpty ? nil : query, scope: scope),
        totalMatches: total, truncated: false, limit: 0, mode: "count", items: [])
    }

    let rows = try Self.pageStatement(args, limit: Self.pageLimit).map { try fetch(db, $0) } ?? []
    let newestFirst = args.sort == "recent" || query.isEmpty

    return Self.envelope(
      summary: Self.describePage(total, shown: rows.count, newestFirst: newestFirst),
      totalMatches: total, truncated: rows.count < total, limit: Self.pageLimit, mode: "local",
      items: rows.map(Self.item))
  }

  // MARK: - SQL (mirrors LocalSearch.kt)

  struct Statement { let sql: String; let params: [String] }

  static func scope(_ args: LocalSearchArgs) -> [String] {
    let asked = args.entityTypes.map { $0.trimmingCharacters(in: .whitespaces).lowercased() }.filter { leanEntityTypes.contains($0) }
    if asked.isEmpty { return leanEntityTypes }
    var seen = Set<String>()
    return asked.filter { seen.insert($0).inserted }
  }

  static func matchExpression(_ query: String) -> String? {
    let terms = query.lowercased().split(whereSeparator: { !($0.isLetter || $0.isNumber) }).map(String.init)
    if terms.isEmpty { return nil }
    return "{title body}: (" + terms.map { "\"\($0)\"*" }.joined(separator: " OR ") + ")"
  }

  static func occurredAtBound(_ text: String, upper: Bool) -> String? {
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.timeZone = TimeZone(identifier: "UTC")
    formatter.dateFormat = "yyyy-MM-dd"
    guard let date = formatter.date(from: String(text.prefix(10))) else { return nil }
    let day = upper ? Calendar(identifier: .gregorian).date(byAdding: .day, value: 1, to: date)! : date
    return formatter.string(from: day) + " 00:00:00"
  }

  private static func clauses(_ args: LocalSearchArgs, ordered: Bool) -> (from: String, whereSql: String, params: [String], hasQuery: Bool)? {
    let types = scope(args)
    let hasQuery = !args.query.trimmingCharacters(in: .whitespaces).isEmpty
    let match = matchExpression(args.query)
    if hasQuery && match == nil { return nil }

    var whereParts: [String] = []
    var params: [String] = []
    let from: String
    if let match {
      whereParts.append("mobile_search_documents_fts MATCH ?")
      params.append(match)
      from = "FROM mobile_search_documents_fts JOIN mobile_search_documents d ON d.rowid = mobile_search_documents_fts.rowid"
    } else {
      from = "FROM mobile_search_documents d"
    }

    let timeOrdered = ordered && (!hasQuery || args.sort == "recent")
    let broad = types.count > 1 && types.contains(where: { bulkTypes.contains($0) })
    let typeTerm = (hasQuery || (timeOrdered && broad)) ? "+d.entity_type" : "d.entity_type"
    whereParts.append("\(typeTerm) IN (\(types.map { _ in "?" }.joined(separator: ", ")))")
    params.append(contentsOf: types)

    if let since = args.since, let lower = occurredAtBound(since, upper: false) {
      whereParts.append("d.occurred_at >= ?")
      params.append(lower)
    }
    if let until = args.until, let upperBound = occurredAtBound(until, upper: true) {
      whereParts.append("d.occurred_at < ?")
      params.append(upperBound)
    }

    return (from, whereParts.joined(separator: " AND "), params, hasQuery)
  }

  static func pageStatement(_ args: LocalSearchArgs, limit: Int) -> Statement? {
    guard let c = clauses(args, ordered: true) else { return nil }
    let order = (c.hasQuery && args.sort != "recent")
      ? "ORDER BY bm25(mobile_search_documents_fts, 10.0, 1.0, 0.0, 0.0, 0.0), d.id"
      : "ORDER BY d.occurred_at DESC NULLS LAST, d.id"
    return Statement(
      sql: "SELECT d.entity_type, d.entity_id, d.title, d.body, d.occurred_at, d.detail \(c.from) WHERE \(c.whereSql) \(order) LIMIT ?",
      params: c.params + [String(limit)])
  }

  static func countStatement(_ args: LocalSearchArgs) -> Statement? {
    guard let c = clauses(args, ordered: false) else { return nil }
    return Statement(sql: "SELECT count(*) \(c.from) WHERE \(c.whereSql)", params: c.params)
  }

  // MARK: - Envelope (mirrors LocalSearch.kt)

  private static let hiddenDetailKeys: Set<String> = ["from_id", "to_ids", "people", "location_id", "participants_truncated"]

  static func item(_ row: Row) -> [String: Any] {
    var item: [String: Any] = [
      "id": row.entityId,
      "type": row.entityType,
      "title": row.title.flatMap { $0.isEmpty ? nil : $0 } ?? NSNull(),
      "link": "/memory/saved/\(row.entityType)/\(row.entityId)",
      "time": row.occurredAt ?? NSNull(),
      "content": row.body.flatMap { $0.isEmpty ? nil : $0 } ?? NSNull(),
    ]
    if let text = row.detail, let data = text.data(using: .utf8),
       let detail = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
      for (key, value) in detail where !hiddenDetailKeys.contains(key) {
        item[key] = value
      }
    }
    return item
  }

  static func envelope(summary: String, totalMatches: Int, truncated: Bool, limit: Int, mode: String, items: [[String: Any]]) -> String {
    let payload: [String: Any] = [
      "summary": summary, "totalMatches": totalMatches, "truncated": truncated, "limit": limit, "mode": mode, "items": items,
    ]
    let data = (try? JSONSerialization.data(withJSONObject: payload)) ?? Data()
    return String(decoding: data, as: UTF8.self)
  }

  private static func scopeLabel(_ scope: [String]) -> String {
    Set(scope) == Set(leanEntityTypes) ? "entries" : scope.map(plural).joined(separator: ", ")
  }

  private static func plural(_ type: String) -> String {
    switch type {
    case "communication": return "messages"
    case "person": return "people"
    default: return type + "s"
    }
  }

  static func describeCount(_ total: Int, query: String?, scope: [String]) -> String {
    let what = query.map { "\(total) \(scopeLabel(scope)) match \"\($0)\"" } ?? "\(total) \(scopeLabel(scope)) on this phone"
    return "\(what) (exact count from the phone's search index; no items returned)."
  }

  static func describePage(_ total: Int, shown: Int, newestFirst: Bool) -> String {
    let order = newestFirst ? ", newest first" : ""
    if total <= shown { return "\(total) matches; all shown\(order)." }
    return "Showing the \(newestFirst ? "newest" : "top") \(shown) of \(total) matches (exact count)\(order). Report the total, not the number shown."
  }

  // MARK: - SQLCipher

  private func open() throws -> OpaquePointer {
    let key = passphrase()
    guard !key.isEmpty else { throw StoreError.key }
    var db: OpaquePointer?
    guard sqlite3_open_v2(fileURL.path, &db, SQLITE_OPEN_READONLY | SQLITE_OPEN_FULLMUTEX, nil) == SQLITE_OK, let db else {
      throw StoreError.open(String(cString: sqlite3_errmsg(db)))
    }
    guard sqlite3_key(db, key, Int32(key.utf8.count)) == SQLITE_OK else {
      sqlite3_close(db)
      throw StoreError.key
    }
    return db
  }

  private func prepare(_ db: OpaquePointer, _ statement: Statement) throws -> OpaquePointer {
    var stmt: OpaquePointer?
    guard sqlite3_prepare_v2(db, statement.sql, -1, &stmt, nil) == SQLITE_OK, let stmt else {
      throw StoreError.prepare(String(cString: sqlite3_errmsg(db)))
    }
    let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
    for (index, param) in statement.params.enumerated() {
      sqlite3_bind_text(stmt, Int32(index + 1), param, -1, transient)
    }
    return stmt
  }

  private func count(_ db: OpaquePointer, _ statement: Statement) throws -> Int {
    let stmt = try prepare(db, statement)
    defer { sqlite3_finalize(stmt) }
    return sqlite3_step(stmt) == SQLITE_ROW ? Int(sqlite3_column_int(stmt, 0)) : 0
  }

  private func fetch(_ db: OpaquePointer, _ statement: Statement) throws -> [Row] {
    let stmt = try prepare(db, statement)
    defer { sqlite3_finalize(stmt) }
    var rows: [Row] = []
    while sqlite3_step(stmt) == SQLITE_ROW {
      func text(_ column: Int32) -> String? {
        guard let pointer = sqlite3_column_text(stmt, column) else { return nil }
        return String(cString: pointer)
      }
      rows.append(Row(
        entityType: text(0) ?? "", entityId: text(1) ?? "", title: text(2), body: text(3), occurredAt: text(4), detail: text(5)))
    }
    return rows
  }
}
