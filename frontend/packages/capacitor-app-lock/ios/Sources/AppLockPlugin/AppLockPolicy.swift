import Foundation

/// How long the app may sit in the background before it comes back locked. The raw values
/// are the `AppLockGrace` union in ../../../src/definitions.ts. Mirrors `Grace` in the
/// Android half.
enum Grace: String, CaseIterable {
    case immediately
    case thirtySeconds = "30s"
    case fiveMinutes = "5m"
    case never

    static let `default`: Grace = .thirtySeconds

    /// Seconds the app may be away; -1 for never.
    var seconds: TimeInterval {
        switch self {
        case .immediately: return 0
        case .thirtySeconds: return 30
        case .fiveMinutes: return 300
        case .never: return -1
        }
    }

    /// The grace a wire value names, or the default for anything unknown — never a crash on a stale pref.
    static func fromWire(_ value: String?) -> Grace {
        guard let value, let grace = Grace(rawValue: value) else { return .default }
        return grace
    }
}

/// The persisted settings. Defaults: off, 30 s, screen secured (which on iOS means the
/// switcher blur; there is no FLAG_SECURE equivalent).
struct AppLockSettings: Equatable {
    var enabled = false
    var grace: Grace = .default
    var secureScreen = true

    private static let enabledKey = "ci.appLock.enabled"
    private static let graceKey = "ci.appLock.grace"
    private static let secureScreenKey = "ci.appLock.secureScreen"

    /// Read by `AppLockPlugin.load()` before the web view has loaded a byte, so a cold start
    /// comes up locked instead of flashing the last page first.
    static func load(from defaults: UserDefaults = .standard) -> AppLockSettings {
        AppLockSettings(
            enabled: defaults.bool(forKey: enabledKey),
            grace: Grace.fromWire(defaults.string(forKey: graceKey)),
            secureScreen: defaults.object(forKey: secureScreenKey) as? Bool ?? true
        )
    }

    func save(to defaults: UserDefaults = .standard) {
        defaults.set(enabled, forKey: Self.enabledKey)
        defaults.set(grace.rawValue, forKey: Self.graceKey)
        defaults.set(secureScreen, forKey: Self.secureScreenKey)
    }
}

/// The lock decisions as pure functions of settings and time — the same three rules as the
/// Android `AppLockPolicy`, so both phones behave identically. The plugin owns the clock
/// and the state; this owns the rules. Nothing here touches a database key, which is what
/// lets sync run behind the lock (SECURITY_ARCHITECTURE.md § 4.4).
enum AppLockPolicy {
    /// A cold start comes up locked whenever the lock is on.
    static func locksOnLaunch(_ settings: AppLockSettings) -> Bool {
        settings.enabled
    }

    /// Whether returning to the foreground re-locks: on, grace not "never", and the time
    /// away reached the grace. `backgroundedAt` is nil when the app was never backgrounded.
    static func locksOnResume(_ settings: AppLockSettings, backgroundedAt: Date?, now: Date) -> Bool {
        guard settings.enabled, settings.grace != .never, let backgroundedAt else { return false }
        return now.timeIntervalSince(backgroundedAt) >= settings.grace.seconds
    }

    /// Whether leaving the foreground locks at once (the "immediately" grace only).
    static func locksOnPause(_ settings: AppLockSettings) -> Bool {
        settings.enabled && settings.grace == .immediately
    }
}
