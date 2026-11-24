import BackgroundTasks
import Foundation
import SQLCipher

// UNCOMPILED as written (2026-10-30). See ReplicaSync.swift and the README.

// MARK: - The replica, opened as the Capacitor SQLite plugin opens it

enum ReplicaCoreError: Error {
    case openFailed(String)
    case sqlFailed(String)
}

/// The replica opened the way `@capacitor-community/sqlite` opens it on iOS, so the app and
/// this see the same file: SQLCipher, the file under `Library/LocalDatabase/`
/// (`iosDatabaseLocation` in `frontend/apps/ios/capacitor.config.ts`), keyed with
/// `PRAGMA key = '<passphrase>'` (that plugin's `UtilsSQLCipher.openOrCreateDatabase`), the
/// passphrase it keeps in the Keychain under service `unlockSecret`, account
/// `<iosKeychainPrefix>_CapacitorSQLitePlugin`. PowerSync's core is registered as an auto
/// extension before the open, as `@powersync/capacitor` does from JS.
///
/// The plugin writes that Keychain item with the iOS default, `WhenUnlocked`; [ReplicaKeychain]
/// moves it to `AfterFirstUnlockThisDeviceOnly` so a run can read it with the phone locked.
/// Until it has (a background launch before the app's first unlocked open), [open] answers nil
/// and the run waits for the next period.
final class SQLCipherReplicaCore: ReplicaCore {
    static let databaseDirectory = "LocalDatabase"
    /// `iosKeychainPrefix: 'ci-memory'` + the plugin's fixed account name.
    static let keychainAccount = "ci-memory_CapacitorSQLitePlugin"
    static let keychainService = "unlockSecret"
    private static let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
    private static let registerCore: Void = {
        _ = ci_register_powersync_core()
    }()

    private var database: OpaquePointer?

    private init(database: OpaquePointer) {
        self.database = database
    }

    /// Nil when there is nothing to sync: no file yet, or no passphrase readable right now.
    static func open(databaseFile: String) throws -> SQLCipherReplicaCore? {
        let library = FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask)[0]
        let url = library.appendingPathComponent(databaseDirectory).appendingPathComponent(databaseFile)
        guard FileManager.default.fileExists(atPath: url.path), let passphrase = readPassphrase() else {
            return nil
        }

        _ = registerCore
        var handle: OpaquePointer?
        let flags = SQLITE_OPEN_READWRITE | SQLITE_OPEN_FULLMUTEX
        guard sqlite3_open_v2(url.path, &handle, flags, nil) == SQLITE_OK, let opened = handle else {
            let message = handle.map { String(cString: sqlite3_errmsg($0)) } ?? "sqlite3_open_v2 failed"
            sqlite3_close(handle)
            throw ReplicaCoreError.openFailed(message)
        }
        let core = SQLCipherReplicaCore(database: opened)
        do {
            let quoted = passphrase.replacingOccurrences(of: "'", with: "''")
            try core.execute("PRAGMA key = '\(quoted)';")
            // Decrypts the header now, so a wrong key fails here rather than as corruption later.
            try core.execute("SELECT count(*) FROM sqlite_master;")
            // The app's connection may be finishing a write as this starts.
            try core.execute("PRAGMA busy_timeout = 10000;")
            // Fails here, not mid-sync, if the core did not register.
            _ = try core.scalar("SELECT powersync_rs_version()")
        } catch {
            core.close()
            throw error
        }
        return core
    }

    private static func readPassphrase() -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: keychainAccount,
            kSecAttrService as String: keychainService,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        // errSecInteractionNotAllowed while the phone is locked; errSecItemNotFound before the
        // app has ever opened the replica. Either way, nothing to do this time.
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data,
              let passphrase = String(data: data, encoding: .utf8),
              !passphrase.isEmpty
        else {
            return nil
        }
        return passphrase
    }

    func control(_ op: String, _ payload: String?) throws -> String {
        try execute("BEGIN IMMEDIATE;")
        do {
            var statement: OpaquePointer?
            guard sqlite3_prepare_v2(database, "SELECT powersync_control(?, ?)", -1, &statement, nil) == SQLITE_OK else {
                throw ReplicaCoreError.sqlFailed(lastError())
            }
            defer { sqlite3_finalize(statement) }
            sqlite3_bind_text(statement, 1, op, -1, Self.transient)
            if let payload = payload {
                sqlite3_bind_text(statement, 2, payload, -1, Self.transient)
            } else {
                sqlite3_bind_null(statement, 2)
            }
            guard sqlite3_step(statement) == SQLITE_ROW, let raw = sqlite3_column_text(statement, 0) else {
                throw ReplicaCoreError.sqlFailed(lastError())
            }
            let reply = String(cString: raw)
            try execute("COMMIT;")
            return reply
        } catch {
            try? execute("ROLLBACK;")
            throw error
        }
    }

    func pendingUploads() throws -> Int {
        Int(try scalar("SELECT count(*) FROM ps_crud") ?? "0") ?? 0
    }

    func close() {
        if let database = database {
            sqlite3_close(database)
        }
        database = nil
    }

    deinit {
        close()
    }

    private func execute(_ sql: String) throws {
        var errorPointer: UnsafeMutablePointer<CChar>?
        guard sqlite3_exec(database, sql, nil, nil, &errorPointer) == SQLITE_OK else {
            let message = errorPointer.map { String(cString: $0) } ?? lastError()
            sqlite3_free(errorPointer)
            throw ReplicaCoreError.sqlFailed(message)
        }
    }

    private func scalar(_ sql: String) throws -> String? {
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(database, sql, -1, &statement, nil) == SQLITE_OK else {
            throw ReplicaCoreError.sqlFailed(lastError())
        }
        defer { sqlite3_finalize(statement) }
        guard sqlite3_step(statement) == SQLITE_ROW, let raw = sqlite3_column_text(statement, 0) else {
            return nil
        }
        return String(cString: raw)
    }

    private func lastError() -> String {
        database.map { String(cString: sqlite3_errmsg($0)) } ?? "no open database"
    }
}

// MARK: - Key custody

/// Brings the replica's key and file to the posture `frontend/apps/ios/SECURITY_ARCHITECTURE.md`
/// asks of every on-device secret (§3.1 and the backup table in §3.3):
///
/// - **The Keychain item** the SQLite plugin keeps the passphrase in moves from the default
///   `WhenUnlocked` to `AfterFirstUnlockThisDeviceOnly`. `AfterFirstUnlock` so the background
///   sync can open the replica while the phone is locked (from the first unlock after a boot
///   until power-off, as the API key already is); `ThisDeviceOnly` so the key no longer travels
///   in an encrypted backup onto other hardware.
/// - **The replica's directory** (`Library/LocalDatabase`) is excluded from backups, so a
///   restored phone gets neither the key nor a file it could not open: it signs in and
///   re-syncs from the user's own appliance, the designed outcome.
///
/// `SecItemUpdate` with the accessibility in the *attributes*, never the query: the plugin's
/// reads and updates name only class, account and service, so they keep matching the item and
/// an update keeps the new class. A fresh item (first open, or a re-mint after sign-out) is
/// written with the default again, so this runs at every launch and every time the app hands
/// over a sync config, which follows the replica's open. While the phone is locked the update
/// fails (`errSecInteractionNotAllowed` on a `WhenUnlocked` item) and the next call retries.
enum ReplicaKeychain {
    static func harden() {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrAccount as String: SQLCipherReplicaCore.keychainAccount,
            kSecAttrService as String: SQLCipherReplicaCore.keychainService,
        ]
        let attributes: [String: Any] = [
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
        if status != errSecSuccess && status != errSecItemNotFound {
            NSLog("[ReplicaSync] could not reseal the replica key yet (\(status)); will retry")
        }

        let library = FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask)[0]
        var directory = library.appendingPathComponent(SQLCipherReplicaCore.databaseDirectory, isDirectory: true)
        guard FileManager.default.fileExists(atPath: directory.path) else { return }
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        do {
            try directory.setResourceValues(values)
        } catch {
            NSLog("[ReplicaSync] could not exclude the replica from backups: \(error)")
        }
    }
}

// MARK: - Network

enum ReplicaTransportError: Error {
    case badStatus(String, Int)
    case badResponse(String)
}

/// The two requests the JS connector and sync client make: `GET <origin>/api/powersync/token`
/// with the API key, and `POST <endpoint>/sync/stream` with `Authorization: Token`, NDJSON back
/// (as `AbstractRemote.fetchStream` sends it).
final class URLSessionReplicaTransport: ReplicaTransport {
    private let origin: String
    private let apiKey: String
    private let cutoffIso: String
    private let session: URLSession

    init(origin: String, apiKey: String, cutoffIso: String, session: URLSession = .shared) {
        self.origin = origin
        self.apiKey = apiKey
        self.cutoffIso = cutoffIso
        self.session = session
    }

    func fetchCredentials() async throws -> ReplicaCredentials {
        guard var components = URLComponents(string: "\(origin)/api/powersync/token") else {
            throw ReplicaTransportError.badResponse("bad origin \(origin)")
        }
        components.queryItems = [URLQueryItem(name: "cutoff", value: cutoffIso)]
        guard let url = components.url else { throw ReplicaTransportError.badResponse("bad token URL") }
        var request = URLRequest(url: url, timeoutInterval: 30)
        request.setValue(apiKey, forHTTPHeaderField: "x-api-key")

        let (data, response) = try await session.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200...299).contains(status) else { throw ReplicaTransportError.badStatus("token", status) }
        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let endpoint = json["powersync_url"] as? String,
              let token = json["token"] as? String
        else {
            throw ReplicaTransportError.badResponse("token response")
        }
        var trimmed = endpoint
        while trimmed.hasSuffix("/") {
            trimmed.removeLast()
        }
        return ReplicaCredentials(endpoint: trimmed, token: token)
    }

    func openStream(_ credentials: ReplicaCredentials, body: String) async throws -> SyncLineSource {
        guard let url = URL(string: "\(credentials.endpoint)/sync/stream") else {
            throw ReplicaTransportError.badResponse("bad sync URL")
        }
        var request = URLRequest(url: url, timeoutInterval: 60)
        request.httpMethod = "POST"
        request.httpBody = Data(body.utf8)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue("application/x-ndjson", forHTTPHeaderField: "Accept")
        request.setValue("Token \(credentials.token)", forHTTPHeaderField: "Authorization")
        request.setValue("ci-replica-background-sync", forHTTPHeaderField: "x-user-agent")

        let (bytes, response) = try await session.bytes(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 200 else {
            bytes.task.cancel()
            throw ReplicaTransportError.badStatus("sync stream", status)
        }
        return AsyncBytesLineSource(bytes)
    }
}

private final class AsyncBytesLineSource: SyncLineSource {
    private let task: URLSessionDataTask
    private var lines: AsyncLineSequence<URLSession.AsyncBytes>.AsyncIterator

    init(_ bytes: URLSession.AsyncBytes) {
        task = bytes.task
        lines = bytes.lines.makeAsyncIterator()
    }

    func nextLine() async throws -> String? {
        try await lines.next()
    }

    /// Cancelling the task ends a `nextLine()` waiting on the network with an error.
    func close() {
        task.cancel()
    }
}

// MARK: - Background task

/// Brings the replica up to date while the app is not on screen, so it is current when the app
/// next opens. A `BGAppRefreshTask`: iOS decides when it runs (we ask for no sooner than
/// [interval]), gives it about 30 seconds, and may run it rarely for an app used rarely.
///
/// Registered from `AppDelegate.application(_:didFinishLaunchingWithOptions:)` (iOS requires
/// registration before launch ends), scheduled when the app hands over a config, and
/// rescheduled at the start of each run. A run does nothing while the app holds the replica, with
/// no config or API key, with local writes waiting to upload, or while the phone is locked (see
/// [SQLCipherReplicaCore]).
///
/// To run it on demand in a debug session (Xcode, app paused, after a config was handed over):
///
///     e -l objc -- (void)[[BGTaskScheduler sharedScheduler] _simulateLaunchForTaskWithIdentifier:@"com.companionintelligence.localhub.replica-sync"]
public enum ReplicaBackgroundSync {
    /// Must also be listed under `BGTaskSchedulerPermittedIdentifiers` in the app's Info.plist.
    public static let taskIdentifier = "com.companionintelligence.localhub.replica-sync"
    static let interval: TimeInterval = 30 * 60
    /// Inside the roughly 30 seconds iOS grants a refresh task; a catch-up normally takes 1-2.
    static let runBudget: TimeInterval = 25
    /// `API_KEY_STORAGE` in the web app's `useAuth.ts`.
    private static let apiKey = "ci.apiKey"

    public static func register() {
        ReplicaKeychain.harden()
        BGTaskScheduler.shared.register(forTaskWithIdentifier: taskIdentifier, using: nil) { task in
            guard let refresh = task as? BGAppRefreshTask else {
                task.setTaskCompleted(success: false)
                return
            }
            handle(refresh)
        }
    }

    static func schedule() {
        let request = BGAppRefreshTaskRequest(identifier: taskIdentifier)
        request.earliestBeginDate = Date(timeIntervalSinceNow: interval)
        do {
            try BGTaskScheduler.shared.submit(request)
        } catch {
            NSLog("[ReplicaSync] could not schedule: \(error)")
        }
    }

    static func cancel() {
        BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: taskIdentifier)
    }

    private static func handle(_ task: BGAppRefreshTask) {
        schedule()
        let work = Task {
            // Location fixes first: a trip waiting on the phone matters more than a fresher copy.
            let uploaded = await OutboxBackgroundUpload.runOnce()
            let finished = await runOnce()
            task.setTaskCompleted(success: uploaded && finished)
        }
        task.expirationHandler = {
            ReplicaSyncGate.shared.cancelRun()
            work.cancel()
        }
    }

    /// One run; true when it finished (synced, or had nothing to do), false when it was cut short.
    static func runOnce() async -> Bool {
        guard let config = ReplicaSyncConfigStore.load() else { return true }
        let gate = ReplicaSyncGate.shared
        guard gate.tryBeginBackgroundRun() else {
            NSLog("[ReplicaSync] skipped: the app holds the replica")
            return true
        }
        defer { gate.endBackgroundRun() }
        let started = Date()
        do {
            guard let key = try CompanionSecureStore.credentials().get(apiKey), !key.isEmpty else { return true }
            let cutoff = ISO8601DateFormatter().string(from: started.addingTimeInterval(-Double(config.lookbackDays) * 86_400))
            let runner = ReplicaSyncRunner(
                transport: URLSessionReplicaTransport(origin: config.apiBaseUrl, apiKey: key, cutoffIso: cutoff),
                openCore: { try SQLCipherReplicaCore.open(databaseFile: config.databaseFile) },
                startOptions: config.startOptions
            )
            let outcome = try await runner.run(
                deadline: started.addingTimeInterval(runBudget),
                isCancelled: { gate.isCancelled || Task.isCancelled },
                onStreamOpen: { stream in gate.onCancel { stream.close() } }
            )
            NSLog("[ReplicaSync] \(outcome) in \(Int(Date().timeIntervalSince(started) * 1000)) ms")
            if case .stopped = outcome { return false }
            return true
        } catch {
            // Also how a cancelled run usually ends: cancelling its stream fails the read.
            NSLog("[ReplicaSync] run ended: \(error)")
            return false
        }
    }
}
