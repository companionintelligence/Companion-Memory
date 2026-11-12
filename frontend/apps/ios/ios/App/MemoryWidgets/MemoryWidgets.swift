import AppIntents
import SwiftUI
import WidgetKit

private enum WidgetStorage {
    static let group = "group.com.companionintelligence.memory.widgets"
    static let snapshotFilename = "snapshot.json"
    static let actionsKey = "pendingActions"
}

private struct WidgetSnapshot: Decodable {
    let version: Int
    let generatedAt: String
    let plan: Plan
    let insight: Insight
    let jobs: Jobs

    struct Plan: Decodable {
        let openCount: Int
        let tasks: [Task]
        let updatedAt: String?
    }

    struct Task: Decodable, Identifiable {
        let id: String
        let title: String
        let dueAt: String?
    }

    struct Insight: Decodable {
        let systemStatus: String
        let stillLearning: Bool
        let prediction: String?
        let confidence: Double?
        let forecastGeneratedAt: String?
        let metricsUpdatedAt: String?
        let messages: Int
        let places: Int
        let kilometers: Double
    }

    struct Jobs: Decodable {
        let pending: Int
        let active: Int
        let failed: Int
        let deadLettered: Int
        let completed: Int
        let updatedAt: String?
    }

    static func load() -> WidgetSnapshot? {
        guard let folder = FileManager.default.containerURL(
            forSecurityApplicationGroupIdentifier: WidgetStorage.group
        ) else {
            return nil
        }
        let url = folder.appendingPathComponent(WidgetStorage.snapshotFilename)
        guard let data = try? Data(contentsOf: url),
              let snapshot = try? JSONDecoder().decode(WidgetSnapshot.self, from: data),
              snapshot.version == 1,
              let savedAt = date(from: snapshot.generatedAt) else {
            return nil
        }
        let age = Date().timeIntervalSince(savedAt)
        guard age >= -5 * 60, age < 48 * 60 * 60 else { return nil }
        return snapshot
    }

    static func date(from value: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let parsed = fractional.date(from: value) { return parsed }
        let standard = ISO8601DateFormatter()
        return standard.date(from: value)
    }

    static func dueDate(from value: String) -> Date? {
        guard value.range(of: #"^\d{4}-\d{2}-\d{2}$"#, options: .regularExpression) != nil else {
            return date(from: value)
        }
        let formatter = DateFormatter()
        formatter.calendar = Calendar(identifier: .gregorian)
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = .current
        formatter.dateFormat = "yyyy-MM-dd"
        return formatter.date(from: value)
    }
}

private struct WidgetEntry: TimelineEntry {
    let date: Date
    let snapshot: WidgetSnapshot?
}

private struct SnapshotProvider: TimelineProvider {
    func placeholder(in context: Context) -> WidgetEntry {
        WidgetEntry(date: Date(), snapshot: nil)
    }

    func getSnapshot(in context: Context, completion: @escaping (WidgetEntry) -> Void) {
        completion(WidgetEntry(date: Date(), snapshot: WidgetSnapshot.load()))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<WidgetEntry>) -> Void) {
        let entry = WidgetEntry(date: Date(), snapshot: WidgetSnapshot.load())
        completion(Timeline(entries: [entry], policy: .after(Date().addingTimeInterval(30 * 60))))
    }
}

private enum WidgetKind {
    case plan
    case insight
    case questions
    case stats
    case jobs

    var deepLink: URL {
        switch self {
        case .plan: return URL(string: "companion://widget/plan")!
        case .insight: return URL(string: "companion://widget/ask")!
        case .questions: return URL(string: "companion://widget/questions")!
        case .stats: return URL(string: "companion://widget/stats")!
        case .jobs: return URL(string: "companion://widget/jobs")!
        }
    }
}

private struct WidgetCard: View {
    @Environment(\.widgetFamily) private var family
    let kind: WidgetKind
    let entry: WidgetEntry

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            switch kind {
            case .plan:
                planContent
            case .insight:
                insightContent
            case .questions:
                questionsContent
            case .stats:
                statsContent
            case .jobs:
                jobsContent
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .padding(16)
        .modifier(WidgetCardBackground())
        .widgetURL(kind.deepLink)
        .privacySensitive()
    }

    @ViewBuilder
    private var planContent: some View {
        HStack {
            eyebrow("PLAN")
            Spacer()
            Text(entry.snapshot.flatMap { $0.plan.updatedAt == nil ? nil : "\($0.plan.openCount) open" } ?? "—")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
        }
        if let snapshot = entry.snapshot, snapshot.plan.updatedAt != nil {
            if family == .systemSmall {
                Text(snapshot.plan.tasks.first?.title ?? "Nothing due next")
                    .font(.headline)
                    .lineLimit(3)
                Spacer(minLength: 0)
                freshness(snapshot.plan.updatedAt)
            } else {
                ForEach(snapshot.plan.tasks.prefix(family == .systemLarge ? 3 : 2)) { task in
                    HStack(alignment: .center, spacing: 8) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(task.title)
                                .font(.subheadline.weight(.medium))
                                .lineLimit(1)
                            Text(dueLabel(task.dueAt))
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                        Spacer(minLength: 2)
                        TaskDoneButton(taskId: task.id)
                    }
                }
                Spacer(minLength: 0)
                freshness(snapshot.plan.updatedAt)
            }
        } else {
            Text("Open Memory to sync your plan")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            Spacer(minLength: 0)
        }
    }

    @ViewBuilder
    private var insightContent: some View {
        eyebrow("INSIGHT")
        if let snapshot = entry.snapshot {
            Text(snapshot.insight.prediction ?? "No forecast yet")
                .font(family == .systemSmall ? .headline : .title3.weight(.semibold))
                .lineLimit(2)
            HStack(spacing: 4) {
                if let probability = snapshot.insight.confidence {
                    Text("\(Int(max(0, min(1, probability)) * 100))% likely")
                } else {
                    Text(snapshot.insight.systemStatus == "READY" ? "Forecast ready" : "Forecast warming up")
                }
                if snapshot.insight.stillLearning { Text("· still learning") }
            }
            .font(.caption)
            .foregroundStyle(.secondary)
            if family != .systemSmall {
                Text(snapshot.insight.metricsUpdatedAt == nil
                    ? "Activity stats syncing"
                    : "\(snapshot.insight.messages) messages  ·  \(snapshot.insight.places) places  ·  \(snapshot.insight.kilometers, specifier: "%.1f") km")
                    .font(.caption)
                    .lineLimit(2)
                freshness(snapshot.insight.forecastGeneratedAt)
            }
            Spacer(minLength: 0)
            Link(destination: kind.deepLink) {
                Label("Ask Memory", systemImage: "bubble.left")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Color.accentColor)
            }
        } else {
            Text("Forecasts, activity and questions")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            Spacer(minLength: 0)
            Link(destination: kind.deepLink) {
                Label("Ask Memory", systemImage: "bubble.left")
                    .font(.caption.weight(.semibold))
            }
        }
    }

    @ViewBuilder
    private var jobsContent: some View {
        eyebrow("JOBS")
        if let jobs = entry.snapshot?.jobs, jobs.updatedAt != nil {
            if family == .systemSmall {
                metric(value: jobs.active, label: "Active")
                metric(value: jobs.pending, label: "Pending")
                metric(value: jobs.failed + jobs.deadLettered, label: "Needs attention", warning: true)
            } else {
                HStack(alignment: .top, spacing: 14) {
                    VStack(alignment: .leading, spacing: 12) {
                        metric(value: jobs.active, label: "Active")
                        metric(value: jobs.pending, label: "Pending")
                    }
                    VStack(alignment: .leading, spacing: 12) {
                        metric(value: jobs.failed + jobs.deadLettered, label: "Needs attention", warning: true)
                        metric(value: jobs.completed, label: "Completed")
                    }
                }
                Spacer(minLength: 0)
                freshness(jobs.updatedAt)
            }
            Link(destination: kind.deepLink) {
                Label("Open read-only dashboard", systemImage: "arrow.up.right")
                    .font(.caption2.weight(.semibold))
            }
        } else {
            Text("Open Memory to sync queue health")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            Spacer(minLength: 0)
        }
    }

    @ViewBuilder
    private var questionsContent: some View {
        eyebrow("QUESTIONS")
        Text("What would you like to understand?")
            .font(family == .systemSmall ? .headline : .title3.weight(.semibold))
            .lineLimit(3)
        Text("Ask across your saved memories and records.")
            .font(.caption)
            .foregroundStyle(.secondary)
        Spacer(minLength: 0)
        Link(destination: kind.deepLink) {
            Label("Ask Memory", systemImage: "bubble.left")
                .font(.caption.weight(.semibold))
        }
    }

    @ViewBuilder
    private var statsContent: some View {
        eyebrow("STATS")
        if let snapshot = entry.snapshot, snapshot.insight.metricsUpdatedAt != nil {
            HStack(alignment: .top, spacing: 8) {
                metric(value: snapshot.insight.messages, label: "Messages")
                metric(value: snapshot.insight.places, label: "Places")
                metric(value: Int(snapshot.insight.kilometers.rounded()), label: "Km")
            }
            Spacer(minLength: 0)
            freshness(snapshot.insight.metricsUpdatedAt)
        } else {
            Text("Open Memory to sync today’s activity.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            Spacer(minLength: 0)
        }
        Link(destination: kind.deepLink) {
            Label("View activity", systemImage: "arrow.up.right")
                .font(.caption.weight(.semibold))
        }
    }

    private func eyebrow(_ text: String) -> some View {
        Text(text)
            .font(.caption2.weight(.bold))
            .tracking(1.2)
            .foregroundStyle(Color.accentColor)
    }

    private func metric(value: Int, label: String, warning: Bool = false) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            Text("\(value)")
                .font(.title3.weight(.semibold))
                .foregroundStyle(warning && value > 0 ? .orange : .primary)
            Text(label)
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
    }

    @ViewBuilder
    private func freshness(_ isoString: String?) -> some View {
        if let isoString, let date = WidgetSnapshot.date(from: isoString) {
            Text("Updated \(date, style: .relative)")
                .font(.caption2)
                .foregroundStyle(.tertiary)
                .lineLimit(1)
        } else {
            Text("Waiting for a fresh sync")
                .font(.caption2)
                .foregroundStyle(.tertiary)
        }
    }

    private func dueLabel(_ isoString: String?) -> String {
        guard let isoString, let date = WidgetSnapshot.dueDate(from: isoString) else {
            return "Unscheduled"
        }
        let calendar = Calendar.current
        if calendar.isDateInToday(date) { return "Today" }
        if calendar.isDateInTomorrow(date) { return "Tomorrow" }
        if date < Date() { return "Overdue" }
        return date.formatted(date: .abbreviated, time: .omitted)
    }
}

private struct TaskDoneButton: View {
    let taskId: String

    @ViewBuilder
    var body: some View {
        if #available(iOSApplicationExtension 17.0, *) {
            Button(intent: CompleteTaskFromWidgetIntent(taskId: taskId)) {
                Image(systemName: "checkmark.circle.fill")
                    .font(.title3)
                    .foregroundStyle(Color.accentColor)
                    .accessibilityLabel("Complete task")
            }
            .buttonStyle(.plain)
        } else {
            Link(destination: URL(string: "companion://widget/plan")!) {
                Image(systemName: "arrow.up.right.circle")
                    .font(.title3)
                    .foregroundStyle(Color.accentColor)
                    .accessibilityLabel("Open plan")
            }
        }
    }
}

private struct WidgetCardBackground: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOSApplicationExtension 17.0, *) {
            content.containerBackground(for: .widget) {
                Color(uiColor: .secondarySystemBackground)
            }
        } else {
            content.background(Color(uiColor: .secondarySystemBackground))
        }
    }
}

@available(iOSApplicationExtension 16.0, *)
private struct CompleteTaskFromWidgetIntent: AppIntent {
    static var title: LocalizedStringResource = "Complete task"
    static var openAppWhenRun = true

    @Parameter(title: "Task identifier")
    var taskId: String

    init() {}

    init(taskId: String) {
        self.taskId = taskId
    }

    func perform() async throws -> some IntentResult {
        let action: [String: String] = [
            "id": UUID().uuidString,
            "type": "completeTask",
            "taskId": String(taskId.prefix(256)),
            "createdAt": ISO8601DateFormatter().string(from: Date())
        ]
        if let defaults = UserDefaults(suiteName: WidgetStorage.group),
           let data = try? JSONSerialization.data(withJSONObject: action),
           let encoded = String(data: data, encoding: .utf8) {
            var pending = defaults.stringArray(forKey: WidgetStorage.actionsKey) ?? []
            pending.append(encoded)
            defaults.set(Array(pending.suffix(20)), forKey: WidgetStorage.actionsKey)
        }
        WidgetCenter.shared.reloadTimelines(ofKind: "CompanionMemoryPlanWidget")
        return .result()
    }
}

private struct PlanWidget: Widget {
    let kind = "CompanionMemoryPlanWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: SnapshotProvider()) { entry in
            WidgetCard(kind: .plan, entry: entry)
        }
        .configurationDisplayName("Plan")
        .description("See upcoming tasks, due dates and quick actions.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}

private struct InsightWidget: Widget {
    let kind = "CompanionMemoryInsightWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: SnapshotProvider()) { entry in
            WidgetCard(kind: .insight, entry: entry)
        }
        .configurationDisplayName("Insights")
        .description("See a forecast, activity stats and a shortcut to ask Memory.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}

private struct JobsWidget: Widget {
    let kind = "CompanionMemoryJobsWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: SnapshotProvider()) { entry in
            WidgetCard(kind: .jobs, entry: entry)
        }
        .configurationDisplayName("Jobs")
        .description("Read queue health without running or changing jobs.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}

private struct QuestionsWidget: Widget {
    let kind = "CompanionMemoryQuestionsWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: SnapshotProvider()) { entry in
            WidgetCard(kind: .questions, entry: entry)
        }
        .configurationDisplayName("Questions")
        .description("Open Memory chat to ask about your saved records.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}

private struct StatsWidget: Widget {
    let kind = "CompanionMemoryStatsWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: SnapshotProvider()) { entry in
            WidgetCard(kind: .stats, entry: entry)
        }
        .configurationDisplayName("Stats")
        .description("See today’s synced messages, places and distance.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}

@main
struct CompanionMemoryWidgetBundle: WidgetBundle {
    var body: some Widget {
        PlanWidget()
        QuestionsWidget()
        InsightWidget()
        StatsWidget()
        JobsWidget()
    }
}
