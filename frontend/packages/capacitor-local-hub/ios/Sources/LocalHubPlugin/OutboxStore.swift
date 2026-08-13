import Foundation
// SQLCipher, NOT the system `SQLite3` module. The pod compiles SQLCipher's own `sqlite3.c` and,
// under this Podfile's `use_frameworks!`, exposes it as a Swift module named `SQLCipher` whose
// umbrella header is SQLCipher's `sqlite3.h`. Importing `SQLite3` here instead would silently
// bind these calls to the OS's *unencrypted* SQLite, which would compile, run, and produce a
// plaintext database -- the failure this whole file exists to prevent, in its most invisible
// form. See README.md: this is one of the specific things to check on the first real build.
import SQLCipher

/// One row of the durable capture outbox. `payload` is only populated by single-item reads.
struct OutboxItem {
    let id: String
    let kind: String
    let capturedAt: String
    let seq: Int64
    let status: String
    let attempts: Int
    let lastError: String?
    /// Raw JSON text exactly as it was enqueued, or `nil` on projections that omit it.
    let payload: String?
}

/// Aggregate counts backing the `counts` block of `GET /api/outbox`.
struct OutboxCounts {
    let pending: Int
    let needsAttention: Int
    let total: Int
}

/// Result of an enqueue attempt. `.duplicate` is what makes the enqueue endpoint idempotent:
/// a client that retries a POST it never saw the response to gets the original row back
/// rather than a second copy of the user's capture.
enum EnqueueOutcome {
    case created(OutboxItem)
    case duplicate(OutboxItem)
    /// The queue is at `maxItems`; the caller must surface this, never drop the capture.
    case atCapacity
}

enum OutboxStoreError: LocalizedError {
    case openFailed(String)
    case sqlFailed(String)
    /// The key was applied but the database still would not decrypt -- a wrong key, or a file
    /// that is not a SQLCipher database at all.
    case keyRejected(String)

    var errorDescription: String? {
        switch self {
        case let .openFailed(message):
            return "Could not open the Local Hub outbox database: \(message)"
        case let .sqlFailed(message):
            return "Local Hub outbox database error: \(message)"
        case let .keyRejected(message):
            return "The Local Hub outbox database could not be decrypted: \(message)"
        }
    }
}

/// Durable, on-disk store behind the Local Hub's `/api/outbox` routes -- the iOS counterpart
/// of `android/src/main/java/com/companionintelligence/localhub/OutboxStore.kt`. The schema,
/// the status vocabulary, the retry budget, and the capacity policy are all deliberately
/// identical to the Android side; the two are kept in sync by hand.
///
/// **Durability is the entire point of this class**, so a few properties are load-bearing
/// rather than incidental:
///
/// - Rows live in real SQLite under `Library/Application Support/`, inside the app
///   container, which iOS isolates from other apps. Nothing is buffered in memory:
///   `enqueue` commits its transaction before it returns, so a force-quit or reboot
///   immediately after the HTTP 201 cannot lose the item. `synchronous = FULL` is set
///   explicitly so a commit means "written through", not "written to the OS page cache".
/// - Ordering is strict FIFO by `seq`, an `INTEGER PRIMARY KEY AUTOINCREMENT`. The
///   `AUTOINCREMENT` keyword is deliberate: without it SQLite reuses the rowids of deleted
///   rows, so after a successful flush drained the tail a new item could be handed a seq
///   *lower* than one already issued and silently jump the queue. Ordering never consults
///   the wall clock -- `capturedAt` is client time and can move backwards.
/// - Capacity is a hard cap (`maxItems`) that rejects, never evicts.
///
/// **Encrypted at rest with SQLCipher (AES-256).** The key is 32 bytes of `SecRandomCopyBytes`
/// held in the Keychain with `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, applied as a
/// raw key (`PRAGMA key = "x'…'"`) so no PBKDF2 runs -- see `OutboxDatabaseKey`. Layered on top
/// of that, the file is given the `.completeUntilFirstUserAuthentication` Data Protection class
/// -- which pairs exactly with the keychain accessibility above, both meaning "available from
/// the first unlock after boot", which is what background ingest needs -- and is excluded from
/// backups, so a restored backup produces a database that cannot be opened rather than one that
/// silently follows the user's captures onto new hardware.
///
/// **What this does and does not protect.** It protects the file at rest: an attacker with
/// filesystem access sees ciphertext, and destroying the Keychain item makes every copy of the
/// file permanently unopenable. It does **not** protect a running, unlocked app -- once the
/// sidecar has opened the database, anything with code execution in this process can read it.
///
/// **No migration path exists or is needed on iOS**: unlike Android, no build that shipped this
/// file has ever run on a device, so there is no plaintext predecessor in any app container.
///
/// **Threading**: GCDWebServer invokes handlers on arbitrary dispatch queues, so several
/// calls can land here at once. Every public method funnels through the serial `queue`,
/// which makes each read-then-write sequence ("check idempotency key, then insert",
/// "read attempts, then increment") atomic against the others.
final class OutboxStore {
    static let databaseFileName = "ci-local-hub-outbox.sqlite3"

    /// Production hard cap. Enqueue answers HTTP 507 at this many rows -- it never evicts an
    /// older capture to make room, because the older capture is also user data nobody agreed
    /// to lose.
    static let defaultMaxItems = 5000

    /// Failed attempts tolerated before an item stops retrying and becomes user-visible.
    static let maxAttempts = 5

    static let statusPending = "pending"
    static let statusNeedsAttention = "needs_attention"

    let maxItems: Int

    /// 80% of `maxItems`; reported to callers so queue pressure is visible before the wall.
    var warnAt: Int { maxItems * 8 / 10 }

    private let queue = DispatchQueue(label: "com.companionintelligence.localhub.outbox")
    private var database: OpaquePointer?

    /// SQLite must copy bound strings: the Swift `String` backing them only lives for the
    /// duration of the `sqlite3_bind_text` call.
    private static let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)

    /// `Library/Application Support/<bundle id>/` -- inside the app container and not visible
    /// through file sharing the way `Documents/` can be.
    ///
    /// **Excluded from backups**, which is a change from the pre-encryption reasoning. The old
    /// comment argued the outbox should be backed up because it holds captures that have not
    /// reached the server. That is no longer coherent now the file is encrypted with a
    /// `ThisDeviceOnly` key: the key cannot travel with the backup, so a restored copy of the
    /// file would be permanently unreadable padding. Excluding it makes the outcome explicit
    /// instead of shipping a backup artifact that only looks like a safety net.
    static func defaultDatabaseURL() throws -> URL {
        let fileManager = FileManager.default
        let base = try fileManager.url(
            for: .applicationSupportDirectory,
            in: .userDomainMask,
            appropriateFor: nil,
            create: true
        )
        // Application Support is not guaranteed to exist on iOS until something creates it.
        let directory = base.appendingPathComponent(
            Bundle.main.bundleIdentifier ?? "com.companionintelligence.localhub",
            isDirectory: true
        )
        try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory.appendingPathComponent(databaseFileName, isDirectory: false)
    }

    init(databaseURL: URL, maxItems: Int = OutboxStore.defaultMaxItems) throws {
        self.maxItems = maxItems

        // Resolved before the file is opened, so a missing or unreadable key means no database
        // gets created at all -- there is no unencrypted fallback anywhere below this line.
        let keySpec = try OutboxDatabaseKey.rawKeySpec(for: databaseURL)

        var handle: OpaquePointer?
        // FULLMUTEX: the connection is shared across GCDWebServer's handler queues. The
        // serial `queue` above already serializes access, but a serialized connection means
        // a future caller that forgets cannot corrupt anything.
        let flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX
        guard sqlite3_open_v2(databaseURL.path, &handle, flags, nil) == SQLITE_OK, handle != nil else {
            let message = handle.map { String(cString: sqlite3_errmsg($0)) } ?? "sqlite3_open_v2 failed"
            sqlite3_close(handle)
            throw OutboxStoreError.openFailed(message)
        }
        database = handle

        do {
            // `PRAGMA key` must be the very first statement on the connection -- anything before
            // it touches the (still-encrypted) file and fails. The `x'…'` form makes SQLCipher
            // treat the 32 bytes as the key itself rather than as a passphrase to stretch.
            try execute("PRAGMA key = \"\(keySpec)\";")

            // Forces the header to be decrypted now. Without a read, `PRAGMA key` "succeeds"
            // even with a wrong key and the failure surfaces later as generic corruption at
            // some arbitrary call site.
            try verifyKeyAccepted()

            try applyFileProtection(to: databaseURL)

            // WAL for concurrent readers while the flusher writes; synchronous = FULL so a
            // committed enqueue is durable across a power loss, not merely across a crash. This
            // queue's write rate is low enough that the extra fsync is not worth optimizing away.
            try execute("PRAGMA journal_mode = WAL;")
            try execute("PRAGMA synchronous = FULL;")
            try createSchemaIfNeeded()
        } catch {
            sqlite3_close(database)
            database = nil
            throw error
        }
    }

    /// Reads the schema table, which is what actually exercises the key. A wrong key surfaces
    /// here as `SQLITE_NOTADB` ("file is not a database"), which is the correct answer -- an
    /// unopenable database is what makes destroying the Keychain item a real crypto-shred.
    private func verifyKeyAccepted() throws {
        var errorPointer: UnsafeMutablePointer<CChar>?
        let result = sqlite3_exec(database, "SELECT count(*) FROM sqlite_master;", nil, nil, &errorPointer)
        guard result == SQLITE_OK else {
            let message = errorPointer.map { String(cString: $0) } ?? lastErrorMessage()
            sqlite3_free(errorPointer)
            throw OutboxStoreError.keyRejected(message)
        }
    }

    /// `.completeUntilFirstUserAuthentication` on the database and its sidecar files, plus
    /// exclusion from backups.
    ///
    /// Applied to `-wal` and `-shm` too: those hold recently written pages, and protecting only
    /// the main file would leave the newest captures at the container default. They may not
    /// exist yet at this point (WAL mode is enabled just after), which is why a missing file is
    /// not an error here -- SQLite creates them with the main file's protection class.
    private func applyFileProtection(to databaseURL: URL) throws {
        let fileManager = FileManager.default
        for path in [databaseURL.path, databaseURL.path + "-wal", databaseURL.path + "-shm"] {
            guard fileManager.fileExists(atPath: path) else { continue }
            try fileManager.setAttributes(
                [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication],
                ofItemAtPath: path
            )
        }

        var excluded = databaseURL
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try excluded.setResourceValues(values)
    }

    deinit {
        sqlite3_close(database)
    }

    // MARK: - Schema

    private func createSchemaIfNeeded() throws {
        try execute("""
            CREATE TABLE IF NOT EXISTS outbox (
                seq INTEGER PRIMARY KEY AUTOINCREMENT,
                id TEXT NOT NULL UNIQUE,
                kind TEXT NOT NULL,
                payload TEXT NOT NULL,
                captured_at TEXT NOT NULL,
                idempotency_key TEXT NOT NULL UNIQUE,
                status TEXT NOT NULL,
                attempts INTEGER NOT NULL DEFAULT 0,
                last_error TEXT
            );
            """)
        // The flusher's hot query is "oldest pending item(s) first"; this index serves both
        // that and the status-filtered list without a sort step.
        try execute("CREATE INDEX IF NOT EXISTS outbox_status_seq ON outbox (status, seq);")
    }

    // MARK: - Public API

    /// Commits one item and returns it, or reports `.duplicate` for a replayed
    /// `idempotencyKey` / `.atCapacity` when the queue is full.
    ///
    /// `capturedAt` is stored verbatim: it is the *client's* capture time and must never be
    /// replaced with server/device-receive time, or the timeline the user sees would shift
    /// whenever a capture sat in the queue.
    func enqueue(
        kind: String,
        payloadJSON: String,
        capturedAt: String,
        idempotencyKey: String
    ) throws -> EnqueueOutcome {
        // Explicit closure result types throughout this file: multi-statement closures only
        // infer their return type on newer Swift compilers, and this code cannot be compiled
        // in the environment it was written in (see README).
        try queue.sync { () -> EnqueueOutcome in
            try inTransaction { () -> EnqueueOutcome in
                if let existing = try firstItem(
                    where: "idempotency_key = ?",
                    argument: idempotencyKey,
                    includePayload: true
                ) {
                    return .duplicate(existing)
                }

                if try count(status: nil) >= maxItems {
                    return .atCapacity
                }

                let statement = try prepare("""
                    INSERT INTO outbox (id, kind, payload, captured_at, idempotency_key, status, attempts)
                    VALUES (?, ?, ?, ?, ?, ?, 0);
                    """)
                defer { sqlite3_finalize(statement) }

                let identifier = UUID().uuidString
                bindText(statement, 1, identifier)
                bindText(statement, 2, kind)
                bindText(statement, 3, payloadJSON)
                bindText(statement, 4, capturedAt)
                bindText(statement, 5, idempotencyKey)
                bindText(statement, 6, Self.statusPending)
                guard sqlite3_step(statement) == SQLITE_DONE else {
                    throw OutboxStoreError.sqlFailed(lastErrorMessage())
                }

                guard let created = try firstItem(
                    where: "id = ?",
                    argument: identifier,
                    includePayload: true
                ) else {
                    throw OutboxStoreError.sqlFailed("Outbox row \(identifier) vanished immediately after insert")
                }
                return .created(created)
            }
        }
    }

    /// Oldest-first (FIFO) list. A `status` of `nil` means every status. Payloads omitted.
    func list(status: String?) throws -> [OutboxItem] {
        try queue.sync { () -> [OutboxItem] in
            var sql = "SELECT \(Self.listColumns) FROM outbox"
            if status != nil {
                sql += " WHERE status = ?"
            }
            sql += " ORDER BY seq ASC;"

            let statement = try prepare(sql)
            defer { sqlite3_finalize(statement) }
            if let status = status {
                bindText(statement, 1, status)
            }

            var items: [OutboxItem] = []
            while sqlite3_step(statement) == SQLITE_ROW {
                items.append(readItem(statement, includePayload: false))
            }
            return items
        }
    }

    /// One item *including* its payload, or `nil` if `id` is unknown.
    func item(id: String) throws -> OutboxItem? {
        try queue.sync { () -> OutboxItem? in
            try firstItem(where: "id = ?", argument: id, includePayload: true)
        }
    }

    /// Removes one item. Returns false if `id` was already gone.
    func delete(id: String) throws -> Bool {
        try queue.sync { () -> Bool in
            let statement = try prepare("DELETE FROM outbox WHERE id = ?;")
            defer { sqlite3_finalize(statement) }
            bindText(statement, 1, id)
            guard sqlite3_step(statement) == SQLITE_DONE else {
                throw OutboxStoreError.sqlFailed(lastErrorMessage())
            }
            return sqlite3_changes(database) > 0
        }
    }

    /// Records a failed flush attempt: increments `attempts`, stores `error`, and moves the
    /// item to `needs_attention` if `permanent` is set or the retry budget (`maxAttempts`) is
    /// exhausted. Returns the updated item, or `nil` if `id` is unknown.
    ///
    /// A `needs_attention` row is never deleted here -- surfacing it to the user is the whole
    /// point, so the only ways out are an explicit retry or an explicit discard.
    func recordFailedAttempt(id: String, error: String, permanent: Bool) throws -> OutboxItem? {
        try queue.sync { () -> OutboxItem? in
            try inTransaction { () -> OutboxItem? in
                guard let existing = try firstItem(where: "id = ?", argument: id, includePayload: false) else {
                    return nil
                }

                let attempts = existing.attempts + 1
                let status = (permanent || attempts >= Self.maxAttempts)
                    ? Self.statusNeedsAttention
                    : Self.statusPending

                let statement = try prepare("UPDATE outbox SET attempts = ?, status = ?, last_error = ? WHERE id = ?;")
                defer { sqlite3_finalize(statement) }
                sqlite3_bind_int(statement, 1, Int32(attempts))
                bindText(statement, 2, status)
                bindText(statement, 3, error)
                bindText(statement, 4, id)
                guard sqlite3_step(statement) == SQLITE_DONE else {
                    throw OutboxStoreError.sqlFailed(lastErrorMessage())
                }

                return try firstItem(where: "id = ?", argument: id, includePayload: false)
            }
        }
    }

    /// Puts an item back in the pending queue with a fresh retry budget. Applied to any
    /// existing item (not only `needs_attention` ones) so it is idempotent. `last_error` is
    /// deliberately kept: it is the only record of why the item stalled, and the next failed
    /// attempt overwrites it anyway.
    func retry(id: String) throws -> OutboxItem? {
        try queue.sync { () -> OutboxItem? in
            try inTransaction { () -> OutboxItem? in
                let statement = try prepare("UPDATE outbox SET status = ?, attempts = 0 WHERE id = ?;")
                defer { sqlite3_finalize(statement) }
                bindText(statement, 1, Self.statusPending)
                bindText(statement, 2, id)
                guard sqlite3_step(statement) == SQLITE_DONE else {
                    throw OutboxStoreError.sqlFailed(lastErrorMessage())
                }
                guard sqlite3_changes(database) > 0 else {
                    return nil
                }
                return try firstItem(where: "id = ?", argument: id, includePayload: false)
            }
        }
    }

    func counts() throws -> OutboxCounts {
        try queue.sync { () -> OutboxCounts in
            let pending = try count(status: Self.statusPending)
            let needsAttention = try count(status: Self.statusNeedsAttention)
            // Counted rather than summed so a row in some future status can't make total lie.
            let total = try count(status: nil)
            return OutboxCounts(pending: pending, needsAttention: needsAttention, total: total)
        }
    }

    // MARK: - SQLite plumbing

    private static let listColumns = "seq, id, kind, captured_at, status, attempts, last_error"
    private static let fullColumns = "seq, id, kind, captured_at, status, attempts, last_error, payload"

    /// BEGIN IMMEDIATE (not DEFERRED) so the write lock is taken up front rather than on the
    /// first write, which is what keeps a read-then-write body from failing with SQLITE_BUSY
    /// partway through.
    private func inTransaction<T>(_ body: () throws -> T) throws -> T {
        try execute("BEGIN IMMEDIATE;")
        do {
            let result = try body()
            // The COMMIT is what makes the enqueue durable, and it happens before the HTTP
            // response is written.
            try execute("COMMIT;")
            return result
        } catch {
            try? execute("ROLLBACK;")
            throw error
        }
    }

    private func count(status: String?) throws -> Int {
        var sql = "SELECT COUNT(*) FROM outbox"
        if status != nil {
            sql += " WHERE status = ?"
        }
        sql += ";"

        let statement = try prepare(sql)
        defer { sqlite3_finalize(statement) }
        if let status = status {
            bindText(statement, 1, status)
        }
        guard sqlite3_step(statement) == SQLITE_ROW else {
            throw OutboxStoreError.sqlFailed(lastErrorMessage())
        }
        return Int(sqlite3_column_int64(statement, 0))
    }

    private func firstItem(where clause: String, argument: String, includePayload: Bool) throws -> OutboxItem? {
        let columns = includePayload ? Self.fullColumns : Self.listColumns
        let statement = try prepare("SELECT \(columns) FROM outbox WHERE \(clause) LIMIT 1;")
        defer { sqlite3_finalize(statement) }
        bindText(statement, 1, argument)

        guard sqlite3_step(statement) == SQLITE_ROW else {
            return nil
        }
        return readItem(statement, includePayload: includePayload)
    }

    /// Column order must match `listColumns` / `fullColumns`.
    private func readItem(_ statement: OpaquePointer, includePayload: Bool) -> OutboxItem {
        OutboxItem(
            id: text(statement, 1) ?? "",
            kind: text(statement, 2) ?? "",
            capturedAt: text(statement, 3) ?? "",
            seq: sqlite3_column_int64(statement, 0),
            status: text(statement, 4) ?? "",
            attempts: Int(sqlite3_column_int64(statement, 5)),
            lastError: text(statement, 6),
            payload: includePayload ? text(statement, 7) : nil
        )
    }

    private func text(_ statement: OpaquePointer, _ index: Int32) -> String? {
        guard let raw = sqlite3_column_text(statement, index) else {
            return nil
        }
        return String(cString: raw)
    }

    private func bindText(_ statement: OpaquePointer, _ index: Int32, _ value: String) {
        sqlite3_bind_text(statement, index, value, -1, Self.transient)
    }

    private func prepare(_ sql: String) throws -> OpaquePointer {
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(database, sql, -1, &statement, nil) == SQLITE_OK,
              let prepared = statement else {
            sqlite3_finalize(statement)
            throw OutboxStoreError.sqlFailed(lastErrorMessage())
        }
        return prepared
    }

    private func execute(_ sql: String) throws {
        var errorPointer: UnsafeMutablePointer<CChar>?
        guard sqlite3_exec(database, sql, nil, nil, &errorPointer) == SQLITE_OK else {
            let message = errorPointer.map { String(cString: $0) } ?? lastErrorMessage()
            sqlite3_free(errorPointer)
            throw OutboxStoreError.sqlFailed(message)
        }
    }

    private func lastErrorMessage() -> String {
        guard let database = database else {
            return "no open database"
        }
        return String(cString: sqlite3_errmsg(database))
    }
}
