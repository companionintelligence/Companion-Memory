import Darwin
import Foundation
import UIKit

/// Numbers about the phone itself, read at the moments they matter: what the process holds, how
/// much more the OS will let it take before jetsam ends it, and how hot the device is.
enum DeviceProbe {
  struct Snapshot: Codable {
    var footprintMB: Double
    /// `os_proc_available_memory()`: bytes this process may still allocate before the system kills
    /// it. This is the budget a larger context window has to fit inside, so it is the number that
    /// answers "how far does device memory allow".
    var availableMB: Double
    var thermal: String
    var batteryPercent: Int
  }

  static func snapshot() -> Snapshot {
    Snapshot(
      footprintMB: footprintBytes() / 1_048_576,
      availableMB: Double(os_proc_available_memory()) / 1_048_576,
      thermal: thermalName(ProcessInfo.processInfo.thermalState),
      batteryPercent: batteryPercent())
  }

  /// The footprint the OS enforces limits against (`phys_footprint`), not resident size.
  static func footprintBytes() -> Double {
    var info = task_vm_info_data_t()
    var count = mach_msg_type_number_t(
      MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<integer_t>.size)

    let result = withUnsafeMutablePointer(to: &info) {
      $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) {
        task_info(mach_task_self_, task_flavor_t(TASK_VM_INFO), $0, &count)
      }
    }

    return result == KERN_SUCCESS ? Double(info.phys_footprint) : 0
  }

  static func thermalName(_ state: ProcessInfo.ThermalState) -> String {
    switch state {
    case .nominal: return "nominal"
    case .fair: return "fair"
    case .serious: return "serious"
    case .critical: return "critical"
    @unknown default: return "unknown"
    }
  }

  static func batteryPercent() -> Int {
    UIDevice.current.isBatteryMonitoringEnabled = true
    let level = UIDevice.current.batteryLevel

    return level < 0 ? -1 : Int((level * 100).rounded())
  }

  /// `iPhone18,2`
  static func hardwareModel() -> String {
    var system = utsname()
    uname(&system)

    return withUnsafePointer(to: &system.machine) {
      $0.withMemoryRebound(to: CChar.self, capacity: Int(_SYS_NAMELEN)) { String(cString: $0) }
    }
  }

  static func describe() -> [String: String] {
    [
      "model": hardwareModel(),
      "os": UIDevice.current.systemVersion,
      "physicalMemoryMB": String(ProcessInfo.processInfo.physicalMemory / 1_048_576),
      "cores": String(ProcessInfo.processInfo.processorCount),
      "lowPowerMode": String(ProcessInfo.processInfo.isLowPowerModeEnabled),
    ]
  }

  /// Holds a run while the phone is nearly flat and not charging: a plan is hours of sustained CPU, and
  /// it should pause for a charger rather than take the battery to zero. Returns how long it waited.
  @discardableResult
  static func waitForPower(maxSeconds: Int = 7200) async -> Int {
    var waited = 0

    while waited < maxSeconds {
      let device = UIDevice.current
      device.isBatteryMonitoringEnabled = true

      let flat = device.batteryLevel >= 0 && device.batteryLevel < 0.08
      let charging = device.batteryState == .charging || device.batteryState == .full
      if !flat || charging { break }

      if waited == 0 { Bench.log("battery at \(batteryPercent())% and not charging: paused until it is plugged in") }
      try? await Task.sleep(nanoseconds: 15_000_000_000)
      waited += 15
    }

    return waited
  }

  /// Waits until the device has cooled to `fair` or better, so a long run does not measure the
  /// thermal governor instead of the model. Returns how long it waited.
  @discardableResult
  static func coolDown(maxSeconds: Int = 300) async -> Int {
    var waited = 0

    while waited < maxSeconds {
      let state = ProcessInfo.processInfo.thermalState
      if state == .nominal || state == .fair { break }

      try? await Task.sleep(nanoseconds: 5_000_000_000)
      waited += 5
    }

    return waited
  }
}


/// Watches the process while something runs and keeps the worst it saw: the highest footprint and the
/// least headroom before jetsam. A growing KV cache is a reallocation — the old buffer and the new one
/// exist together for a moment — so the peak is what a window has to be sized against, not the level
/// it settles at.
final class PeakSampler: @unchecked Sendable {
  struct Result: Codable {
    var peakFootprintMB: Double
    var minAvailableMB: Double
  }

  private let queue = DispatchQueue(label: "bench.peak-sampler", qos: .utility)
  private let lock = NSLock()
  private var timer: DispatchSourceTimer?
  private var peak = 0.0
  private var minAvailable = Double.infinity

  func start() {
    sample()

    let timer = DispatchSource.makeTimerSource(queue: queue)
    timer.schedule(deadline: .now(), repeating: .milliseconds(50))
    timer.setEventHandler { [weak self] in self?.sample() }
    timer.resume()
    self.timer = timer
  }

  func stop() -> Result {
    timer?.cancel()
    timer = nil
    sample()

    lock.lock()
    defer { lock.unlock() }

    return Result(peakFootprintMB: peak, minAvailableMB: minAvailable.isFinite ? minAvailable : 0)
  }

  private func sample() {
    let footprint = DeviceProbe.footprintBytes() / 1_048_576
    let available = Double(os_proc_available_memory()) / 1_048_576

    lock.lock()
    peak = max(peak, footprint)
    minAvailable = min(minAvailable, available)
    lock.unlock()
  }
}
