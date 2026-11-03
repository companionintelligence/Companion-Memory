import Foundation

// Background replica sync, iOS half. The Android twin is `android/.../localhub/replica/`;
// keep the two in step. UNCOMPILED as written (2026-10-30, no Mac in reach): build and test on
// a Mac before relying on it -- see the README's "Background replica sync" section.

// MARK: - Config

/// What the app hands over each time its own PowerSync client connects, so a background launch
/// with no JavaScript can do exactly what that client does: where the appliance is, which file
/// is the replica, how far back the working set reaches (the token request's `cutoff`), and the
/// `start` options the JS client sends the core, schema included.
struct ReplicaSyncConfig: Codable, Equatable {
    let apiBaseUrl: String
    /// The file name on disk, as the Capacitor SQLite plugin names it (`<name>SQLite.db`).
    let databaseFile: String
    let lookbackDays: Int
    let startOptions: String

    /// Nil when anything needed is missing; a partial config must not sync.
    static func from(_ object: [String: Any]) -> ReplicaSyncConfig? {
        var apiBaseUrl = ((object["apiBaseUrl"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        while apiBaseUrl.hasSuffix("/") {
            apiBaseUrl.removeLast()
        }
        let databaseFile = ((object["databaseFile"] as? String) ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let lookbackDays = (object["lookbackDays"] as? NSNumber)?.intValue ?? 0
        let startOptions = (object["startOptions"] as? String) ?? ""
        guard !apiBaseUrl.isEmpty, !databaseFile.isEmpty, !databaseFile.contains("/"), lookbackDays > 0,
              let data = startOptions.data(using: .utf8),
              (try? JSONSerialization.jsonObject(with: data)) is [String: Any]
        else {
            return nil
        }
        return ReplicaSyncConfig(
            apiBaseUrl: apiBaseUrl,
            databaseFile: databaseFile,
            lookbackDays: lookbackDays,
            startOptions: startOptions
        )
    }
}

/// The config, kept where a background launch can read it before any JavaScript runs.
enum ReplicaSyncConfigStore {
    private static let key = "ci.localhub.replicaSync.config"

    static func load() -> ReplicaSyncConfig? {
        guard let data = UserDefaults.standard.data(forKey: key) else { return nil }
        return try? JSONDecoder().decode(ReplicaSyncConfig.self, from: data)
    }

    static func save(_ config: ReplicaSyncConfig) {
        if let data = try? JSONEncoder().encode(config) {
            UserDefaults.standard.set(data, forKey: key)
        }
    }

    static func clear() {
        UserDefaults.standard.removeObject(forKey: key)
    }
}

// MARK: - Gate

/// Who may sync the replica right now: the app's own client (while the app holds it) or the
/// background task (otherwise). Never both: each drives its own copy of the core's sync state
/// against the one file. The app claims before it connects and releases once disconnected; a
/// claim stops a background run in progress -- it cancels the run's stream, so a run waiting on
/// the network ends at once -- and waits for it. In memory: a relaunched process starts unclaimed,
/// which is right, since the WebView went with the old one.
final class ReplicaSyncGate {
    static let shared = ReplicaSyncGate()

    private let condition = NSCondition()
    private var appHolds = false
    private var running = false
    private var cancelRequested = false
    private var cancelHook: (() -> Void)?

    /// Blocks the calling thread until no background run is in progress, or for at most `timeout`.
    func claimForApp(timeout: TimeInterval) -> Bool {
        condition.lock()
        defer { condition.unlock() }
        appHolds = true
        if running {
            cancelRequested = true
            cancelHook?()
            let until = Date().addingTimeInterval(timeout)
            while running {
                if !condition.wait(until: until) { break }
            }
        }
        return !running
    }

    func releaseFromApp() {
        condition.lock()
        appHolds = false
        condition.unlock()
    }

    /// A background run asks to start; false while the app holds the replica or a run is going.
    func tryBeginBackgroundRun() -> Bool {
        condition.lock()
        defer { condition.unlock() }
        if appHolds || running { return false }
        running = true
        cancelRequested = false
        cancelHook = nil
        return true
    }

    /// How a run is stopped from elsewhere; set once its stream is open.
    func onCancel(_ hook: @escaping () -> Void) {
        condition.lock()
        cancelHook = hook
        let cancelNow = cancelRequested
        condition.unlock()
        if cancelNow { hook() }
    }

    /// The system is taking the task's time back (`expirationHandler`).
    func cancelRun() {
        condition.lock()
        cancelRequested = true
        let hook = cancelHook
        condition.unlock()
        hook?()
    }

    var isCancelled: Bool {
        condition.lock()
        defer { condition.unlock() }
        return cancelRequested
    }

    func endBackgroundRun() {
        condition.lock()
        running = false
        cancelRequested = false
        cancelHook = nil
        condition.broadcast()
        condition.unlock()
    }
}

// MARK: - Runner

/// The replica as the background sync sees it: PowerSync's core, reached through
/// `powersync_control`, inside the encrypted database the app's own client uses.
protocol ReplicaCore: AnyObject {
    /// One `powersync_control(op, payload)` call in its own write transaction; the core's JSON reply.
    func control(_ op: String, _ payload: String?) throws -> String
    /// Local writes the app has not uploaded yet (`ps_crud`).
    func pendingUploads() throws -> Int
    func close()
}

struct ReplicaCredentials: Equatable {
    let endpoint: String
    let token: String
}

/// The open `POST <endpoint>/sync/stream` response, one NDJSON line at a time.
protocol SyncLineSource: AnyObject {
    /// The next line, or nil when the server ended the stream. Throws once closed.
    func nextLine() async throws -> String?
    func close()
}

protocol ReplicaTransport {
    func fetchCredentials() async throws -> ReplicaCredentials
    func openStream(_ credentials: ReplicaCredentials, body: String) async throws -> SyncLineSource
}

/// One catch-up of the replica: what the JS client does while the app is open
/// (`rustSyncIteration` in `@powersync/common`), run to the first complete checkpoint and
/// stopped. `start` with the app's start options; open the stream the core asks for;
/// `connection`/`established`, then every line as `line_text`; done on `DidCompleteSync`, ended
/// early by `CloseSyncStream`, an expired token, cancellation, the deadline or the stream
/// ending; always `stop`. Skipped with local writes waiting to upload: that is the app's job,
/// and the core holds checkpoints back over them anyway.
final class ReplicaSyncRunner {
    enum Outcome: Equatable {
        case completed(lines: Int)
        case skipped(String)
        case stopped(String, lines: Int)
    }

    private let transport: ReplicaTransport
    private let openCore: () throws -> ReplicaCore?
    private let startOptions: String
    private let now: () -> Date

    init(
        transport: ReplicaTransport,
        openCore: @escaping () throws -> ReplicaCore?,
        startOptions: String,
        now: @escaping () -> Date = Date.init
    ) {
        self.transport = transport
        self.openCore = openCore
        self.startOptions = startOptions
        self.now = now
    }

    func run(
        deadline: Date,
        isCancelled: @escaping () -> Bool = { false },
        onStreamOpen: (SyncLineSource) -> Void = { _ in }
    ) async throws -> Outcome {
        guard let core = try openCore() else { return .skipped("no replica on this phone yet") }
        defer { core.close() }
        if try core.pendingUploads() > 0 {
            return .skipped("local changes are waiting for the app to upload them")
        }
        let credentials = try await transport.fetchCredentials()

        // Never leave the core mid-iteration in the file the app opens next.
        defer { _ = try? core.control("stop", nil) }

        var request: String?
        for instruction in try Self.instructions(core.control("start", startOptions)) {
            if let establish = instruction["EstablishSyncStream"] as? [String: Any],
               let body = establish["request"],
               let data = try? JSONSerialization.data(withJSONObject: body, options: [.fragmentsAllowed]) {
                request = String(data: data, encoding: .utf8)
            }
        }
        guard let body = request else { return .stopped("the core did not ask for a sync stream", lines: 0) }

        let stream = try await transport.openStream(credentials, body: body)
        defer { stream.close() }
        onStreamOpen(stream)
        _ = try core.control("connection", "established")

        var lines = 0
        while true {
            if isCancelled() { return .stopped("cancelled", lines: lines) }
            if now() >= deadline { return .stopped("out of time", lines: lines) }
            guard let line = try await stream.nextLine() else {
                return .stopped("the service ended the stream", lines: lines)
            }
            if line.trimmingCharacters(in: .whitespaces).isEmpty { continue }
            lines += 1
            for instruction in try Self.instructions(core.control("line_text", line)) {
                if instruction["DidCompleteSync"] != nil { return .completed(lines: lines) }
                if instruction["CloseSyncStream"] != nil { return .stopped("the core closed the stream", lines: lines) }
                if let fetch = instruction["FetchCredentials"] as? [String: Any], fetch["did_expire"] as? Bool == true {
                    return .stopped("the sync token expired", lines: lines)
                }
            }
        }
    }

    private static func instructions(_ raw: String) throws -> [[String: Any]] {
        guard let data = raw.data(using: .utf8),
              let array = try JSONSerialization.jsonObject(with: data) as? [[String: Any]]
        else {
            return []
        }
        return array
    }
}
