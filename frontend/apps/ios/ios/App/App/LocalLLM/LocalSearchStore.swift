import Foundation
import Security
// The SQLCipher pod the SQLite plugin links, not `SQLite3`: both export the same `sqlite3_*` symbols, but the
// system module and the pod's headers cannot be imported into one target (the SDK's sqlite3ext.h then fails
// with "unknown type name 'sqlite3_context'"), and only the pod has `sqlite3_key`.
import SQLCipher

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

  private let fileURL: URL?
  private let keychainAccount: String?
  private let readPassphrase: (String) -> String

  /// `databaseLocation` and `keychainPrefix` are the SQLite plugin's own `iosDatabaseLocation` and
  /// `iosKeychainPrefix` (capacitor.config.ts), read from the bridge's config by `LocalLLMPlugin`, so
  /// this finds the file and the key wherever that plugin put them. `readPassphrase` is the keychain
  /// lookup; only the tests replace it.
  init(
    databaseFile: String, databaseLocation: String, keychainPrefix: String,
    readPassphrase: @escaping (String) -> String = LocalSearchStore.keychainPassphrase
  ) {
    fileURL = Self.fileURL(location: databaseLocation, file: databaseFile)
    keychainAccount = Self.keychainAccount(prefix: keychainPrefix)
    self.readPassphrase = readPassphrase
  }

  var isAvailable: Bool {
    guard let fileURL else { return false }
    return FileManager.default.fileExists(atPath: fileURL.path) && !passphrase().isEmpty
  }

  // MARK: - Where the plugin keeps things

  /// `<databaseLocation>/<file>` as `@capacitor-community/sqlite`'s `UtilsFile.getFolderURL` resolves it: the first
  /// path segment names a sandbox directory (`Applications`, `Library`, `Documents`/`default`, `tmp`, or `cache` in
  /// any case), the rest is a subfolder. nil for any other first segment, which the plugin refuses, and for an
  /// empty location. `Documents` is what the plugin uses when the config sets none.
  static func fileURL(location: String, file: String, fileManager: FileManager = .default) -> URL? {
    let parts = location.split(separator: "/", maxSplits: 1).map(String.init)
    guard let root = parts.first else { return nil }

    let directory: FileManager.SearchPathDirectory
    switch root {
    case "Applications": directory = .applicationDirectory
    case "Library": directory = .libraryDirectory
    case "Documents", "default": directory = .documentDirectory
    case _ where root.caseInsensitiveCompare("cache") == .orderedSame: directory = .cachesDirectory
    case "tmp": return parts.dropFirst().reduce(fileManager.temporaryDirectory) { $0.appendingPathComponent($1) }.appendingPathComponent(file)
    default: return nil
    }

    guard let base = fileManager.urls(for: directory, in: .userDomainMask).first else { return nil }
    return parts.dropFirst().reduce(base) { $0.appendingPathComponent($1) }.appendingPathComponent(file)
  }

  /// The keychain account the plugin stores its encryption secret under (`UtilsSecret`:
  /// `"\(prefix)_CapacitorSQLitePlugin"`). The plugin refuses to store a secret under an empty prefix, so
  /// there is nothing to read for one.
  static func keychainAccount(prefix: String) -> String? {
    prefix.isEmpty ? nil : "\(prefix)_CapacitorSQLitePlugin"
  }

  /// The plugin's `UtilsSecret.getPassphrase(account:)`, which is internal to its module and so cannot be
  /// called from here: a generic-password item with this account and the service `unlockSecret`. Empty when
  /// the item is absent or unreadable, like the original.
  static func keychainPassphrase(account: String) -> String {
    let query: [String: Any] = [
      kSecClass as String: kSecClassGenericPassword,
      kSecAttrAccount as String: account,
      kSecAttrService as String: "unlockSecret",
      kSecMatchLimit as String: kSecMatchLimitOne,
      kSecReturnData as String: true,
    ]
    var item: CFTypeRef?
    guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
          let data = item as? Data, let value = String(data: data, encoding: .utf8)
    else { return "" }
    return value
  }

  private func passphrase() -> String {
    keychainAccount.map(readPassphrase) ?? ""
  }

  struct Row {
    let entityType: String
    let entityId: String
    let title: String?
    let body: String?
    let occurredAt: String?
    let detail: String?
  }

  enum StoreError: Error, LocalizedError {
    case open(String), key, prepare(String)

    var errorDescription: String? {
      switch self {
      case .open(let message): return "the replica could not be opened (\(message))"
      case .key: return "the replica's key is missing or does not open it"
      case .prepare(let message): return "the search could not be prepared (\(message))"
      }
    }
  }

  func run(_ args: LocalSearchArgs) throws -> String {
    let db = try open()
    defer { sqlite3_close(db) }

    let scope = Self.scope(args)
    let query = args.query.trimmingCharacters(in: .whitespacesAndNewlines)
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
    let asked = args.entityTypes.map { $0.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }.filter { leanEntityTypes.contains($0) }
    if asked.isEmpty { return leanEntityTypes }
    var seen = Set<String>()
    return asked.filter { seen.insert($0).inserted }
  }

  static func matchExpression(_ query: String) -> String? {
    let terms = query.lowercased().split(whereSeparator: { !($0.isLetter || $0.isNumber) }).map(String.init)
    if terms.isEmpty { return nil }
    return terms.map { "\"\($0)\"*" }.joined(separator: " OR ")
  }

  static func occurredAtBound(_ text: String, upper: Bool) -> String? {
    let formatter = DateFormatter()
    formatter.locale = Locale(identifier: "en_US_POSIX")
    formatter.timeZone = TimeZone(identifier: "UTC")
    formatter.dateFormat = "yyyy-MM-dd"
    guard let date = formatter.date(from: String(text.prefix(10))) else { return nil }
    // 86,400 s, not `Calendar.date(byAdding: .day)`: that counts days in the device's zone, so on the night the clocks
    // change it lands an hour short and the day-after bound would exclude the whole last day.
    let day = upper ? date.addingTimeInterval(86_400) : date
    return formatter.string(from: day) + " 00:00:00"
  }

  private static func clauses(_ args: LocalSearchArgs, ordered: Bool) -> (from: String, whereSql: String, params: [String], hasQuery: Bool)? {
    let types = scope(args)
    let hasQuery = !args.query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
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
      ? "ORDER BY bm25(mobile_search_documents_fts, 10.0, 1.0), d.id"
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
    guard let fileURL else { throw StoreError.open("the replica's location is not one the SQLite plugin supports") }
    let key = passphrase()
    guard !key.isEmpty else { throw StoreError.key }
    var db: OpaquePointer?
    guard sqlite3_open_v2(fileURL.path, &db, SQLITE_OPEN_READONLY | SQLITE_OPEN_FULLMUTEX, nil) == SQLITE_OK, let db else {
      let message = String(cString: sqlite3_errmsg(db))
      sqlite3_close(db)
      throw StoreError.open(message)
    }
    // A wrong key is only noticed on the first page read, so read one: better "wrong key" here than
    // "file is not a database" from whichever query happens to run first.
    guard sqlite3_key(db, key, Int32(key.utf8.count)) == SQLITE_OK,
          sqlite3_exec(db, "SELECT count(*) FROM sqlite_master", nil, nil, nil) == SQLITE_OK
    else {
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
    return sqlite3_step(stmt) == SQLITE_ROW ? Int(sqlite3_column_int64(stmt, 0)) : 0
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
