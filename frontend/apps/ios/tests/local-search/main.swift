import Foundation
import Security
import SQLCipher

// Runs the phone's `knowledge_search` store (LocalSearchStore.swift) against a real SQLCipher database, the
// way the app reads the PowerSync replica: an encrypted file with the replica's table and FTS index, opened
// read-only with the SQLite plugin's passphrase. `scripts/test-local-search.sh` compiles the app's own
// LocalSearchStore.swift with the SQLCipher pod's sources built for this Mac and runs this file; the project
// has no XCTest target.
//
// What it cannot show is the iPhone: the keychain item here is a test item in this Mac's keychain (read by
// the same `keychainPassphrase` the app uses), and the file is in a temp directory rather than the app's
// Library/LocalDatabase.
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

func test(_ name: String, _ body: () throws -> Void) {
  print("- \(name)")

  do {
    try body()
  } catch {
    failures += 1
    print("  FAIL: threw \(error)")
  }
}

// MARK: - The replica

let directory = FileManager.default.temporaryDirectory.appendingPathComponent("local-search-\(UUID().uuidString)")
try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
defer { try? FileManager.default.removeItem(at: directory) }

let passphrase = String(repeating: "ab12", count: 16)
let fileName = "ci-powersyncSQLite.db"
let databasePath = directory.appendingPathComponent(fileName).path

/// The replica's own DDL (`frontend/apps/web/src/api/powersync/searchIndex.ts`, trimmed to the columns the
/// store reads) and a few rows: two that match "harbour", an older note, a person with no date, and a type
/// the lean search never returns.
func buildReplica() {
  var db: OpaquePointer?
  precondition(sqlite3_open_v2(databasePath, &db, SQLITE_OPEN_CREATE | SQLITE_OPEN_READWRITE, nil) == SQLITE_OK)
  precondition(sqlite3_key(db, passphrase, Int32(passphrase.utf8.count)) == SQLITE_OK)

  let statements = [
    """
    CREATE TABLE mobile_search_documents (
      id TEXT PRIMARY KEY NOT NULL, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '', occurred_at TEXT, related_id TEXT, detail TEXT)
    """,
    """
    CREATE VIRTUAL TABLE mobile_search_documents_fts USING fts5(
      title, body, content='mobile_search_documents', tokenize = 'porter unicode61 remove_diacritics 2')
    """,
    """
    CREATE TRIGGER mobile_search_documents_fts_insert AFTER INSERT ON mobile_search_documents BEGIN
      INSERT INTO mobile_search_documents_fts(rowid, title, body) VALUES (NEW.rowid, NEW.title, NEW.body);
    END
    """,
    """
    INSERT INTO mobile_search_documents (id, entity_type, entity_id, title, body, occurred_at, detail) VALUES
      ('d1', 'communication', 'c1', 'Lunch at Harbour Grill', 'Booked a table for four', '2026-03-08 12:00:00',
       '{"from":"Ann","from_id":"hidden-id","direction":"inbound"}'),
      ('d2', 'event', 'e1', 'Harbour walk', 'Along the water', '2026-05-01 09:30:00', NULL),
      ('d3', 'note', 'n1', 'Groceries', 'eggs and milk', '2026-01-02 10:00:00', NULL),
      ('d4', 'person', 'p1', 'Maria Hall', 'Neighbour', NULL, NULL),
      ('d5', 'answer', 'a1', 'Harbour answer', 'not a lean type', '2026-06-01 00:00:00', NULL)
    """,
  ]

  for statement in statements {
    precondition(sqlite3_exec(db, statement, nil, nil, nil) == SQLITE_OK, String(cString: sqlite3_errmsg(db)))
  }

  sqlite3_close(db)
}

buildReplica()

/// A store over the test replica, in `tmp/<directory>` the way the plugin's `iosDatabaseLocation` names a folder.
func store(
  file: String = fileName, key: String = passphrase, prefix: String = "ci-memory"
) -> LocalSearchStore {
  LocalSearchStore(
    databaseFile: file, databaseLocation: "tmp/\(directory.lastPathComponent)", keychainPrefix: prefix,
    readPassphrase: { account in account == "ci-memory_CapacitorSQLitePlugin" ? key : "" })
}

func search(_ args: LocalSearchArgs, key: String = passphrase) throws -> [String: Any] {
  let json = try store(key: key).run(args)
  return try JSONSerialization.jsonObject(with: Data(json.utf8)) as! [String: Any]
}

func titles(_ result: [String: Any]) -> [String] {
  (result["items"] as! [[String: Any]]).map { $0["title"] as! String }
}

// MARK: - Reading the encrypted replica

test("a text query finds the matching documents through the FTS index and keeps the Android envelope") {
  let result = try search(LocalSearchArgs(query: "harbour"))

  expectEqual(result["mode"] as? String, "local", "mode")
  expectEqual(result["totalMatches"] as? Int, 2, "the answer-typed row is out of scope, the note does not match")
  expectEqual(Set(titles(result)), ["Lunch at Harbour Grill", "Harbour walk"], "titles")
  expectEqual(result["truncated"] as? Bool, false, "all shown")

  let item = (result["items"] as! [[String: Any]]).first { $0["id"] as? String == "c1" }!
  expectEqual(item["type"] as? String, "communication", "type")
  expectEqual(item["link"] as? String, "/memory/saved/communication/c1", "link")
  expectEqual(item["from"] as? String, "Ann", "a display field from detail is carried")
  check(item["from_id"] == nil, "ids in detail are not shown to the model")
}

test("stemming and prefixes match the way the web layer's search does") {
  expectEqual(titles(try search(LocalSearchArgs(query: "booking"))), ["Lunch at Harbour Grill"], "porter stems booking -> book(ed)")
  expectEqual(titles(try search(LocalSearchArgs(query: "walks"))), ["Harbour walk"], "porter stems walks -> walk")
  expectEqual(titles(try search(LocalSearchArgs(query: "groc"))), ["Groceries"], "prefix match")
}

test("countOnly returns the exact count and no items") {
  let result = try search(LocalSearchArgs(query: "harbour", countOnly: true))

  expectEqual(result["totalMatches"] as? Int, 2, "count")
  expectEqual((result["items"] as! [Any]).count, 0, "no items")
  expectEqual(result["mode"] as? String, "count", "mode")
}

test("entityTypes narrows the scope, and an unknown type falls back to every lean type") {
  expectEqual(titles(try search(LocalSearchArgs(query: "harbour", entityTypes: ["event"]))), ["Harbour walk"], "event only")
  expectEqual(try search(LocalSearchArgs(query: "harbour", entityTypes: ["answer"]))["totalMatches"] as? Int, 2, "unknown -> lean")
}

test("since and until bound occurred_at by whole UTC days, also across a daylight-saving change") {
  // 2026-03-08 is when the US clocks go forward: a day added in the device's zone would be 23 hours long.
  expectEqual(
    titles(try search(LocalSearchArgs(query: "harbour", since: "2026-04-01"))), ["Harbour walk"], "since")
  expectEqual(
    titles(try search(LocalSearchArgs(query: "harbour", until: "2026-03-08"))), ["Lunch at Harbour Grill"], "until is inclusive of the day")
}

test("with no query the newest documents come first and undated ones last") {
  let result = try search(LocalSearchArgs())

  expectEqual(titles(result), ["Harbour walk", "Lunch at Harbour Grill", "Groceries", "Maria Hall"], "newest first, NULLS LAST")
  expectEqual(result["totalMatches"] as? Int, 4, "count")
}

test("a query of only whitespace or newlines is no query, as on Android") {
  expectEqual(titles(try search(LocalSearchArgs(query: " \n\t "))), ["Harbour walk", "Lunch at Harbour Grill", "Groceries", "Maria Hall"], "newest first")
  expectEqual(try search(LocalSearchArgs(query: "\n"))["totalMatches"] as? Int, 4, "count")
}

test("sort: recent orders a text query by time instead of rank") {
  expectEqual(
    titles(try search(LocalSearchArgs(query: "harbour", sort: "recent"))),
    ["Harbour walk", "Lunch at Harbour Grill"], "recent")
}

test("a query with no searchable word finds nothing instead of failing") {
  let result = try search(LocalSearchArgs(query: "!!!"))

  expectEqual(result["totalMatches"] as? Int, 0, "count")
}

// MARK: - The key

test("a wrong key is reported as a key problem, not as a missing table") {
  do {
    _ = try search(LocalSearchArgs(query: "harbour"), key: String(repeating: "ff", count: 32))
    check(false, "a wrong key must not read the replica")
  } catch LocalSearchStore.StoreError.key {
    check(true, "")
  }
}

test("the store is unavailable without a file or a key, and available with both") {
  check(!store(file: "missing.db").isAvailable, "no file")
  check(!store(key: "").isAvailable, "no key")
  check(!store(prefix: "").isAvailable, "no keychain prefix: the plugin stores nothing under an empty one")
  check(store().isAvailable, "file and key")
}

test("the keychain account and location are the SQLite plugin's") {
  expectEqual(LocalSearchStore.keychainAccount(prefix: "ci-memory"), "ci-memory_CapacitorSQLitePlugin", "account")
  expectEqual(LocalSearchStore.keychainAccount(prefix: ""), nil, "empty prefix")

  let library = FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask)[0]
  expectEqual(
    LocalSearchStore.fileURL(location: "Library/LocalDatabase", file: "x.db"),
    library.appendingPathComponent("LocalDatabase").appendingPathComponent("x.db"), "iosDatabaseLocation from capacitor.config.ts")
  expectEqual(
    LocalSearchStore.fileURL(location: "Documents", file: "x.db")?.deletingLastPathComponent().lastPathComponent,
    FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0].lastPathComponent, "the plugin's default")
  expectEqual(LocalSearchStore.fileURL(location: "Elsewhere/x", file: "x.db"), nil, "a location the plugin refuses")
  expectEqual(LocalSearchStore.fileURL(location: "", file: "x.db"), nil, "an empty location")

  let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
  for spelling in ["Cache", "cache", "CACHE"] {
    expectEqual(LocalSearchStore.fileURL(location: "\(spelling)/a", file: "x.db"), caches.appendingPathComponent("a/x.db"), "\(spelling) matches case-insensitively")
  }
  expectEqual(
    LocalSearchStore.fileURL(location: "Applications/a", file: "x.db"),
    FileManager.default.urls(for: .applicationDirectory, in: .userDomainMask)[0].appendingPathComponent("a/x.db"), "Applications")
}

test("keychainPassphrase reads the item the plugin writes: generic password, service unlockSecret") {
  let account = "ci-memory-test-\(UUID().uuidString)_CapacitorSQLitePlugin"
  let item: [String: Any] = [
    kSecClass as String: kSecClassGenericPassword,
    kSecAttrAccount as String: account,
    kSecAttrService as String: "unlockSecret",
    kSecValueData as String: Data("s3cret-value".utf8),
  ]
  let added = SecItemAdd(item as CFDictionary, nil)
  defer {
    SecItemDelete([
      kSecClass as String: kSecClassGenericPassword, kSecAttrAccount as String: account,
      kSecAttrService as String: "unlockSecret",
    ] as CFDictionary)
  }

  guard added == errSecSuccess else {
    print("  SKIP: this Mac's keychain refused the test item (status \(added))")
    return
  }

  expectEqual(LocalSearchStore.keychainPassphrase(account: account), "s3cret-value", "stored value")
  expectEqual(LocalSearchStore.keychainPassphrase(account: account + "x"), "", "absent item")
}

print("\(checks) checks, \(failures) failures")
exit(failures == 0 ? 0 : 1)
