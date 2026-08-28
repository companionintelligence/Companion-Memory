import AppIntents
import Foundation

// Native App Intents that expose Companion's core actions to Siri, Spotlight, and the
// Shortcuts app. Each runs outside the webview and talks to CI-Server directly via
// `CompanionAPI` (Keychain API key). Gated to iOS 16+ (the framework's minimum); the
// app itself still supports iOS 15, where these simply aren't offered.

@available(iOS 16.0, *)
struct AskCompanionIntent: AppIntent {
    static var title: LocalizedStringResource = "Ask Companion"
    static var description = IntentDescription(
        "Ask your Companion a question and get a spoken answer.",
        categoryName: "Companion"
    )
    // Runs in the background and replies with a dialog rather than opening the app.
    static var openAppWhenRun = false

    @Parameter(title: "Question", requestValueDialog: "What would you like to ask?")
    var question: String

    static var parameterSummary: some ParameterSummary {
        Summary("Ask Companion \(\.$question)")
    }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let api = try CompanionAPI.make()
        let answer = try await api.ask(prompt: question)

        return .result(dialog: IntentDialog(stringLiteral: answer))
    }
}

@available(iOS 16.0, *)
struct SearchMemoryIntent: AppIntent {
    static var title: LocalizedStringResource = "Search Memory"
    static var description = IntentDescription(
        "Search your Companion memory and hear how many results matched.",
        categoryName: "Companion"
    )
    static var openAppWhenRun = false

    @Parameter(title: "Search", requestValueDialog: "What should I search for?")
    var query: String

    static var parameterSummary: some ParameterSummary {
        Summary("Search Companion memory for \(\.$query)")
    }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let api = try CompanionAPI.make()
        let (count, titles) = try await api.search(query: query)

        let dialog: String
        if count == 0 {
            dialog = "I didn't find anything for “\(query)”."
        } else {
            let plural = count == 1 ? "result" : "results"
            let preview = titles.isEmpty ? "" : " Top matches: \(titles.joined(separator: ", "))."
            dialog = "I found \(count) \(plural) for “\(query)”.\(preview)"
        }

        return .result(dialog: IntentDialog(stringLiteral: dialog))
    }
}

@available(iOS 16.0, *)
struct RememberIntent: AppIntent {
    static var title: LocalizedStringResource = "Remember"
    static var description = IntentDescription(
        "Save a note to your Companion memory.",
        categoryName: "Companion"
    )
    static var openAppWhenRun = false

    @Parameter(title: "Note", requestValueDialog: "What should I remember?")
    var content: String

    static var parameterSummary: some ParameterSummary {
        Summary("Remember \(\.$content) in Companion")
    }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let api = try CompanionAPI.make()

        // Use a short first-line excerpt as the title; keep the full text as content.
        let firstLine = content.split(whereSeparator: \.isNewline).first.map(String.init) ?? content
        let title = String(firstLine.prefix(60))
        let saved = try await api.createNote(title: title, content: content)

        return .result(dialog: "Saved “\(saved)” to your memory.")
    }
}

@available(iOS 16.0, *)
struct OpenCompanionIntent: AppIntent {
    static var title: LocalizedStringResource = "Open Companion"
    static var description = IntentDescription("Open the Companion app.", categoryName: "Companion")
    static var openAppWhenRun = true

    func perform() async throws -> some IntentResult {
        .result()
    }
}

/// Named days the Plan page's When selector offers — AppEnum so Siri phrases can
/// interpolate them (`Move X to Tomorrow`).
@available(iOS 16.0, *)
enum PlanWhen: String, AppEnum {
    case today
    case tomorrow
    case nextWeek

    static var typeDisplayRepresentation = TypeDisplayRepresentation(name: "When")

    static var caseDisplayRepresentations: [PlanWhen: DisplayRepresentation] = [
        .today: "Today",
        .tomorrow: "Tomorrow",
        .nextWeek: "Next week",
    ]

    var localDate: String {
        switch self {
        case .today: return PlanDate.localDate(addingDays: 0)
        case .tomorrow: return PlanDate.localDate(addingDays: 1)
        case .nextWeek: return PlanDate.localDate(addingDays: 7)
        }
    }
}

@available(iOS 16.0, *)
struct PlanTaskEntity: AppEntity {
    static var typeDisplayRepresentation = TypeDisplayRepresentation(name: "Plan task")
    static var defaultQuery = PlanTaskQuery()

    var id: String
    var title: String
    var isOverdue: Bool

    init(snapshot: PlanTaskSnapshot) {
        id = snapshot.id
        title = snapshot.title
        isOverdue = snapshot.isOverdue
    }

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(
            title: "\(title)",
            subtitle: isOverdue ? "Overdue" : "On the plan"
        )
    }
}

@available(iOS 16.0, *)
struct PlanTaskQuery: EntityStringQuery {
    func entities(for identifiers: [PlanTaskEntity.ID]) async throws -> [PlanTaskEntity] {
        let all = try await CompanionAPI.make().planTasks()
        return all.filter { identifiers.contains($0.id) }.map(PlanTaskEntity.init(snapshot:))
    }

    func suggestedEntities() async throws -> [PlanTaskEntity] {
        let all = try await CompanionAPI.make().planTasks().map(PlanTaskEntity.init(snapshot:))
        let overdue = all.filter(\.isOverdue)
        return overdue.isEmpty ? all : overdue
    }

    func entities(matching string: String) async throws -> [PlanTaskEntity] {
        let needle = string.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let all = try await CompanionAPI.make().planTasks().map(PlanTaskEntity.init(snapshot:))
        guard !needle.isEmpty else {
            return all.filter(\.isOverdue)
        }

        let hits = all.filter { $0.title.lowercased().contains(needle) }
        let overdueHits = hits.filter(\.isOverdue)
        return overdueHits.isEmpty ? hits : overdueHits
    }
}

@available(iOS 16.0, *)
struct ListOverduePlanTasksIntent: AppIntent {
    static var title: LocalizedStringResource = "What's Overdue"
    static var description = IntentDescription(
        "List overdue items on your Companion plan.",
        categoryName: "Plan"
    )
    static var openAppWhenRun = false

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let api = try CompanionAPI.make()
        let overdue = try await api.planTasks().filter(\.isOverdue)

        let dialog: String
        if overdue.isEmpty {
            dialog = "Nothing is overdue on your plan."
        } else if overdue.count == 1, let only = overdue.first {
            dialog = "\(only.title) is overdue."
        } else {
            let names = overdue.prefix(5).map(\.title).joined(separator: ", ")
            let extra = overdue.count > 5 ? " and \(overdue.count - 5) more" : ""
            dialog = "\(overdue.count) overdue: \(names)\(extra)."
        }

        return .result(dialog: IntentDialog(stringLiteral: dialog))
    }
}

@available(iOS 16.0, *)
struct ReschedulePlanTaskIntent: AppIntent {
    static var title: LocalizedStringResource = "Reschedule Plan Task"
    static var description = IntentDescription(
        "Move an overdue plan item to today, tomorrow, or next week.",
        categoryName: "Plan"
    )
    static var openAppWhenRun = false

    @Parameter(title: "Task", requestValueDialog: "Which plan item should I move?")
    var task: PlanTaskEntity

    @Parameter(title: "When", requestValueDialog: "Today, tomorrow, or next week?")
    var when: PlanWhen

    static var parameterSummary: some ParameterSummary {
        Summary("Move \(\.$task) to \(\.$when)")
    }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let api = try CompanionAPI.make()
        let title = try await api.reschedulePlanTask(id: task.id, date: when.localDate)
        let whenLabel: String
        switch when {
        case .today: whenLabel = "today"
        case .tomorrow: whenLabel = "tomorrow"
        case .nextWeek: whenLabel = "next week"
        }
        return .result(dialog: "Moved “\(title)” to \(whenLabel).")
    }
}

/// Same reschedule as the Plan page calendar input — `Date` is the selector Shortcuts
/// and Siri use when Today / Tomorrow / Next week is not the day.
@available(iOS 16.0, *)
struct ReschedulePlanTaskOnDateIntent: AppIntent {
    static var title: LocalizedStringResource = "Reschedule Plan Task to a Day"
    static var description = IntentDescription(
        "Move a plan item onto a specific calendar day.",
        categoryName: "Plan"
    )
    static var openAppWhenRun = false

    @Parameter(title: "Task", requestValueDialog: "Which plan item should I move?")
    var task: PlanTaskEntity

    @Parameter(title: "Day", requestValueDialog: "Which day?")
    var day: Date

    static var parameterSummary: some ParameterSummary {
        Summary("Move \(\.$task) to \(\.$day)")
    }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let api = try CompanionAPI.make()
        let date = PlanDate.localDate(from: day)
        let title = try await api.reschedulePlanTask(id: task.id, date: date)
        return .result(dialog: "Moved “\(title)” to \(date).")
    }
}

@available(iOS 16.0, *)
struct CompanionShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        // Ask/Search/Remember stay parameter-free in phrases: Siri cannot interpolate a
        // free-text String. Plan intents use AppEntity (`PlanTaskEntity`) and AppEnum
        // (`PlanWhen`); each phrase may name only one of those besides applicationName.
        AppShortcut(
            intent: AskCompanionIntent(),
            phrases: [
                "Ask my \(.applicationName)",
                "Ask \(.applicationName) a question",
            ],
            shortTitle: "Ask Companion",
            systemImageName: "bubble.left.and.bubble.right"
        )
        AppShortcut(
            intent: SearchMemoryIntent(),
            phrases: [
                "Search my \(.applicationName) memory",
                "Search \(.applicationName)",
            ],
            shortTitle: "Search Memory",
            systemImageName: "magnifyingglass"
        )
        AppShortcut(
            intent: RememberIntent(),
            phrases: [
                "Remember this in \(.applicationName)",
                "Add a note to \(.applicationName)",
            ],
            shortTitle: "Remember",
            systemImageName: "square.and.pencil"
        )
        AppShortcut(
            intent: OpenCompanionIntent(),
            phrases: ["Open \(.applicationName)"],
            shortTitle: "Open Companion",
            systemImageName: "globe"
        )
        AppShortcut(
            intent: ListOverduePlanTasksIntent(),
            phrases: [
                "What's overdue in \(.applicationName)",
                "List overdue \(.applicationName) tasks",
            ],
            shortTitle: "What's Overdue",
            systemImageName: "calendar.badge.exclamationmark"
        )
        AppShortcut(
            intent: ReschedulePlanTaskIntent(),
            phrases: [
                // One interpolated token besides applicationName — Xcode 17
                // rejects `$task` and `$when` in the same utterance.
                "Reschedule \(\.$task) in \(.applicationName)",
                "Reschedule a plan task \(\.$when) in \(.applicationName)",
            ],
            shortTitle: "Reschedule",
            systemImageName: "calendar.badge.clock"
        )
        AppShortcut(
            intent: ReschedulePlanTaskOnDateIntent(),
            phrases: [
                "Move \(\.$task) to a day in \(.applicationName)",
            ],
            shortTitle: "Reschedule to a day",
            systemImageName: "calendar"
        )
    }
}
