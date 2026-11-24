import Foundation
import SwiftUI

/// What the screen shows. The bench's real output is the results file; this is only so whoever is
/// holding the phone can see that it is alive.
@MainActor
final class BenchConsole: ObservableObject {
  static let shared = BenchConsole()

  @Published private(set) var lines: [String] = []
  @Published var status = "starting"

  private init() {}

  func append(_ line: String) {
    lines.append(line)

    if lines.count > 300 { lines.removeFirst(lines.count - 300) }
  }
}

/// Where the bench keeps its files, and the one logging call everything uses.
///
/// Everything goes to three places: stderr (what `devicectl device process launch --console`
/// streams), `Documents/bench/bench.log` (what survives a crash), and the screen.
enum Bench {
  /// `Documents/bench`, created on first use. `devicectl device copy to/from` reads and writes here.
  static let directory: URL = {
    let base = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
    let directory = base.appendingPathComponent("bench", isDirectory: true)

    try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)

    return directory
  }()

  private static let lock = NSLock()
  private static let formatter: DateFormatter = {
    let formatter = DateFormatter()
    formatter.dateFormat = "HH:mm:ss.SSS"

    return formatter
  }()

  static func log(_ message: String) {
    lock.lock()
    let line = "[\(formatter.string(from: Date()))] \(message)"
    lock.unlock()

    FileHandle.standardError.write(Data((line + "\n").utf8))
    append(line + "\n", to: directory.appendingPathComponent("bench.log"))

    Task { @MainActor in BenchConsole.shared.append(line) }
  }

  /// Appends and flushes: a run that dies (jetsam, a native crash) must still leave every earlier
  /// line on disk.
  static func append(_ text: String, to url: URL) {
    lock.lock()
    defer { lock.unlock() }

    guard let data = text.data(using: .utf8) else { return }

    if let handle = try? FileHandle(forWritingTo: url) {
      defer { try? handle.close() }
      _ = try? handle.seekToEnd()
      try? handle.write(contentsOf: data)
      try? handle.synchronize()
    } else {
      try? data.write(to: url)
    }
  }
}
