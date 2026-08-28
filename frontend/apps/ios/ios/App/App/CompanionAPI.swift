import Foundation

/// Minimal CI-Server API client for the native App Intents. Mirrors what the web app
/// does (`x-api-key` auth against the configured origin) but in plain `URLSession` so
/// it can run outside the Capacitor webview. All calls are authenticated with the
/// Keychain API key and fail clearly when the app isn't configured/signed in.
struct CompanionAPI {
    private let baseURL: URL
    private let apiKey: String

    /// Build a client from the shared Keychain config, throwing a Siri-friendly error
    /// when the prerequisites aren't met.
    static func make() throws -> CompanionAPI {
        guard let baseURL = CompanionConfig.baseUrl else {
            throw CompanionIntentError.notConfigured
        }
        guard let apiKey = CompanionConfig.apiKey else {
            throw CompanionIntentError.notSignedIn
        }

        return CompanionAPI(baseURL: baseURL, apiKey: apiKey)
    }

    // MARK: - GraphQL

    /// Run a memory/content search. Returns the top result titles (best-effort) and the
    /// total count.
    func search(query: String) async throws -> (count: Int, titles: [String]) {
        let gql = """
        query AppIntentSearch($query: String!) {
          search(input: { query: $query }) {
            totalCount
            edges { node { __typename
              ... on Node { id }
              ... on NoteType { title }
              ... on EventType { title }
              ... on PersonType { name }
              ... on PlaceType { name }
            } }
          }
        }
        """

        let json = try await graphql(query: gql, variables: ["query": query])
        let search = (json["data"] as? [String: Any])?["search"] as? [String: Any]
        let count = search?["totalCount"] as? Int ?? 0
        let edges = search?["edges"] as? [[String: Any]] ?? []

        let titles: [String] = edges.prefix(5).compactMap { edge in
            let node = edge["node"] as? [String: Any]
            return (node?["title"] as? String) ?? (node?["name"] as? String)
        }

        return (count, titles)
    }

    /// Create a note ("Remember this"). Returns the saved note's title.
    func createNote(title: String, content: String) async throws -> String {
        let gql = """
        mutation AppIntentCreateNote($input: CreateNoteInput!) {
          createNote(input: $input) { success note { id title } }
        }
        """

        let json = try await graphql(
            query: gql,
            variables: ["input": ["title": title, "content": content]]
        )

        let createNote = (json["data"] as? [String: Any])?["createNote"] as? [String: Any]
        guard createNote?["success"] as? Bool == true else {
            throw CompanionIntentError.requestFailed("Couldn't save that to your memory.")
        }

        let note = createNote?["note"] as? [String: Any]
        return (note?["title"] as? String) ?? title
    }

    /// Plan tasks the user can reschedule. Overdue is computed on the same
    /// local-date rule the web Plan board uses (earliest of dueAt / scheduledFor
    /// before today; deferred work stays hidden).
    func planTasks() async throws -> [PlanTaskSnapshot] {
        let gql = """
        query AppIntentPlanTasks {
          tasks(first: 100) {
            edges {
              node {
                id
                title
                status
                dueAt
                scheduledFor
                deferUntil
              }
            }
          }
        }
        """

        let json = try await graphql(query: gql, variables: [:])
        let tasks = (json["data"] as? [String: Any])?["tasks"] as? [String: Any]
        let edges = tasks?["edges"] as? [[String: Any]] ?? []
        let today = PlanDate.today

        return edges.compactMap { edge in
            guard let node = edge["node"] as? [String: Any],
                  let id = node["id"] as? String,
                  let title = node["title"] as? String
            else {
                return nil
            }

            let status = node["status"] as? String ?? "open"
            if status == "proposed" || status == "done" || status == "skipped" || status == "archived" {
                return nil
            }

            let dueAt = node["dueAt"] as? String
            let scheduledFor = node["scheduledFor"] as? String
            let deferUntil = node["deferUntil"] as? String
            let overdue = PlanTaskSnapshot.isOverdue(
                status: status,
                dueAt: dueAt,
                scheduledFor: scheduledFor,
                deferUntil: deferUntil,
                today: today
            )

            return PlanTaskSnapshot(id: id, title: title, isOverdue: overdue)
        }
    }

    /// Push an overdue (or any open) task onto a user-local calendar date, then
    /// place a planned block on that day — same two writes the Plan page makes.
    func reschedulePlanTask(id: String, date: String) async throws -> String {
        let updateGql = """
        mutation AppIntentUpdateTask($input: UpdateTaskInput!) {
          updateTask(input: $input) { success task { id title dueAt scheduledFor } }
        }
        """
        let scheduleGql = """
        mutation AppIntentScheduleTask($id: ID!, $date: String) {
          scheduleTask(id: $id, date: $date) {
            success
            status
            task { id title scheduledFor }
          }
        }
        """

        let update = try await graphql(
            query: updateGql,
            variables: ["input": ["id": id, "dueAt": PlanDate.noonISO(fromLocalDate: date)]]
        )
        let updatePayload = (update["data"] as? [String: Any])?["updateTask"] as? [String: Any]
        guard updatePayload?["success"] as? Bool == true else {
            throw CompanionIntentError.requestFailed("Couldn't move that task.")
        }

        let scheduled = try await graphql(
            query: scheduleGql,
            variables: ["id": id, "date": date]
        )
        let schedulePayload = (scheduled["data"] as? [String: Any])?["scheduleTask"] as? [String: Any]
        let task = (updatePayload?["task"] as? [String: Any])
        let title = (task?["title"] as? String) ?? "the task"

        if schedulePayload?["success"] as? Bool == true {
            return title
        }

        // Due date moved even if there was no calendar gap — still a reschedule.
        return title
    }

    private func graphql(query: String, variables: [String: Any]) async throws -> [String: Any] {
        var request = authorizedRequest(path: "/api/graphql")
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["query": query, "variables": variables])

        let (data, response) = try await URLSession.shared.data(for: request)
        try Self.ensureOK(response, data)

        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw CompanionIntentError.requestFailed("Unexpected response from Companion.")
        }

        if let errors = json["errors"] as? [[String: Any]], let first = errors.first,
           let message = first["message"] as? String {
            throw CompanionIntentError.requestFailed(message)
        }

        return json
    }

    // MARK: - Chat ("Ask Companion")

    /// Ask the assistant a question and return its text answer. The endpoint streams a
    /// sequence of length-prefixed binary frames (`[channel|flags][UInt32 BE length]
    /// [payload]`); we keep only the TEXT channel (0) and decode it. Tools/thinking are
    /// disabled to keep the answer fast and self-contained for a voice reply.
    func ask(prompt: String) async throws -> String {
        var request = authorizedRequest(path: "/api/llm/generate")
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "prompt": prompt,
            "threadId": NSNull(),
            "enableTools": false,
            "enableThinking": false,
        ])

        let (data, response) = try await URLSession.shared.data(for: request)
        try Self.ensureOK(response, data)

        let text = Self.decodeTextChannel(from: data)
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            throw CompanionIntentError.requestFailed("Companion didn't return an answer.")
        }

        return trimmed
    }

    /// Parse the binary frame stream, concatenating the TEXT (channel 0) payloads.
    static func decodeTextChannel(from data: Data) -> String {
        let bytes = [UInt8](data)
        var offset = 0
        var text = Data()

        while offset + 5 <= bytes.count {
            let channel = bytes[offset] >> 6
            let length =
                (Int(bytes[offset + 1]) << 24) | (Int(bytes[offset + 2]) << 16)
                | (Int(bytes[offset + 3]) << 8) | Int(bytes[offset + 4])
            let payloadStart = offset + 5
            let payloadEnd = payloadStart + length

            guard length >= 0, payloadEnd <= bytes.count else { break }

            if channel == 0 {
                text.append(contentsOf: bytes[payloadStart..<payloadEnd])
            }

            offset = payloadEnd
        }

        return String(data: text, encoding: .utf8) ?? ""
    }

    // MARK: - Helpers

    private func authorizedRequest(path: String) -> URLRequest {
        var request = URLRequest(url: baseURL.appendingPathComponent(path))
        request.setValue(apiKey, forHTTPHeaderField: "x-api-key")
        request.timeoutInterval = 60
        return request
    }

    private static func ensureOK(_ response: URLResponse, _ data: Data) throws {
        guard let http = response as? HTTPURLResponse else { return }

        if http.statusCode == 401 || http.statusCode == 403 {
            throw CompanionIntentError.notSignedIn
        }

        guard (200..<300).contains(http.statusCode) else {
            throw CompanionIntentError.requestFailed("Companion returned an error (\(http.statusCode)).")
        }
    }
}

/// User-local `YYYY-MM-DD` helpers shared by Plan App Intents and the Plan page's chips.
enum PlanDate {
    static var today: String { localDate(addingDays: 0) }

    static func localDate(from date: Date) -> String {
        let formatter = DateFormatter()
        formatter.calendar = Calendar.current
        formatter.locale = Locale(identifier: "en_CA")
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: date)
    }

    static func localDate(addingDays days: Int) -> String {
        let calendar = Calendar.current
        let date = calendar.date(byAdding: .day, value: days, to: Date()) ?? Date()
        return localDate(from: date)
    }

    static func noonISO(fromLocalDate ymd: String) -> String {
        let parts = ymd.split(separator: "-").compactMap { Int($0) }
        guard parts.count == 3 else { return ISO8601DateFormatter().string(from: Date()) }

        var components = DateComponents()
        components.year = parts[0]
        components.month = parts[1]
        components.day = parts[2]
        components.hour = 12
        let date = Calendar.current.date(from: components) ?? Date()
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime]
        return iso.string(from: date)
    }

    static func localDate(fromISO iso: String) -> String? {
        let isoFormatter = ISO8601DateFormatter()
        isoFormatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let date = isoFormatter.date(from: iso) ?? {
            isoFormatter.formatOptions = [.withInternetDateTime]
            return isoFormatter.date(from: iso)
        }()
        guard let date else { return nil }

        let formatter = DateFormatter()
        formatter.calendar = Calendar.current
        formatter.locale = Locale(identifier: "en_CA")
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.string(from: date)
    }
}

struct PlanTaskSnapshot {
    let id: String
    let title: String
    let isOverdue: Bool

    /// Mirrors `isOverdue` / `sectionFor` on the web Plan board.
    static func isOverdue(
        status: String,
        dueAt: String?,
        scheduledFor: String?,
        deferUntil: String?,
        today: String
    ) -> Bool {
        if status == "proposed" || status == "done" || status == "skipped" || status == "archived" {
            return false
        }
        if let deferUntil, deferUntil > today {
            return false
        }

        let dueDate = dueAt.flatMap(PlanDate.localDate(fromISO:))
        let dates = [dueDate, scheduledFor].compactMap { $0 }
        guard let earliest = dates.min() else { return false }
        return earliest < today
    }
}
