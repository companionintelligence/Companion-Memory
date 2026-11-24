import SwiftUI

@main
struct BenchApp: App {
  @StateObject private var console = BenchConsole.shared

  var body: some Scene {
    WindowGroup {
      BenchView(console: console)
        .task { await BenchEntry.start() }
    }
  }
}

struct BenchView: View {
  @ObservedObject var console: BenchConsole

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      Text("LLM Bench").font(.headline)
      Text(console.status).font(.system(.subheadline, design: .monospaced))
      Text("Leave this screen on and the phone plugged in.").font(.caption).foregroundColor(.secondary)
      Divider()
      ScrollViewReader { proxy in
        ScrollView {
          VStack(alignment: .leading, spacing: 2) {
            ForEach(Array(console.lines.enumerated()), id: \.offset) { index, line in
              Text(line).font(.system(size: 9, design: .monospaced)).id(index)
            }
          }
          .frame(maxWidth: .infinity, alignment: .leading)
        }
        .onChange(of: console.lines.count) { count in proxy.scrollTo(count - 1, anchor: .bottom) }
      }
    }
    .padding(10)
  }
}

/// What happens when the app starts: find the plan, stand up the fake appliance, run.
enum BenchEntry {
  static func start() async {
    // A launcher that stops reading our stderr must not take the run down with it.
    signal(SIGPIPE, SIG_IGN)

    await MainActor.run {
      UIApplication.shared.isIdleTimerDisabled = true
      UIDevice.current.isBatteryMonitoringEnabled = true
    }

    Bench.log("LLM bench started: \(DeviceProbe.describe())")
    // The models directory is created by the first call; the bench's files are pushed into it.
    _ = try? LocalLLMModels.modelsDirectory()

    guard let plan = loadPlan() else {
      await MainActor.run { BenchConsole.shared.status = "no plan: copy plan.json into Documents/bench" }
      Bench.log("no plan.json in Documents/bench; idle")

      return
    }

    do {
      try await FakeAppliance.shared.start()
    } catch {
      Bench.log("fake appliance failed to start: \(error)")

      return
    }

    CompanionToolContext.client = CompanionIntentClient(
      baseURL: FakeAppliance.shared.baseURL, apiKey: "bench")
    let tools = await CompanionToolContext.refreshRulings()
    Bench.log("appliance up at \(FakeAppliance.shared.baseURL), \(tools.count) tools offered")

    await Task.detached(priority: .userInitiated) { await BenchRunner(plan: plan).run() }.value
    await MainActor.run { BenchConsole.shared.status = "finished" }

    // Done: leave, so the launcher's `--console` returns and it can collect the results.
    try? await Task.sleep(nanoseconds: 2_000_000_000)
    exit(0)
  }

  /// `Documents/bench/plan.json`: `{"id": "...", "cells": [{"id": "...", ...}]}`, every cell field optional.
  private static func loadPlan() -> BenchPlan? {
    struct File: Codable {
      var id: String
      var cells: [BenchCell.Sparse]
    }

    let url = Bench.directory.appendingPathComponent("plan.json")

    guard let data = try? Data(contentsOf: url) else { return nil }

    do {
      let file = try JSONDecoder().decode(File.self, from: data)

      return BenchPlan(id: file.id, cells: file.cells.map(BenchCell.init))
    } catch {
      Bench.log("plan.json does not parse: \(error)")

      return nil
    }
  }
}
