import Foundation

/// What the web side hands over when it turns Always on, persisted verbatim so a process
/// that has no WebView, no plugin instance and no JavaScript -- the app relaunched by iOS
/// in the background for a location event, or after a reboot -- can build exactly the
/// records the web side would have.
///
/// Every field is a value the web side owns: the device key and owner stamp come from its
/// storage, the gate numbers from `@ci/common`'s location.ts. Nothing here is invented
/// natively, so a record queued by this module and one queued by `captureLocationFix` for
/// the same fix carry the same `source_id` and collapse. Field for field the Android
/// `LocationTrackingConfig`, minus the foreground-service notification text iOS has no use
/// for (it is accepted and ignored).
struct LocationTrackingConfig: Equatable {
    static let defaultProvider = "companion-mobile"
    static let defaultMinDistanceMeters = 150.0
    static let defaultMinIntervalMs: Int64 = 5 * 60 * 1000
    static let defaultMaxAccuracyMeters = 200.0

    /// Stable per-install id that prefixes `source_id`; see `deviceSourceKey()` on the web side.
    let deviceKey: String
    let provider: String
    /// The outbox owner stamp (`outboxOwnerStamp()`), or nil when no account is signed in.
    let owner: String?
    let minDistanceMeters: Double
    let minIntervalMs: Int64
    /// Fixes looser than this are dropped, not queued.
    let maxAccuracyMeters: Double

    private enum Key {
        static let deviceKey = "deviceKey"
        static let provider = "provider"
        static let owner = "owner"
        static let minDistance = "minDistanceMeters"
        static let minInterval = "minIntervalMs"
        static let maxAccuracy = "maxAccuracyMeters"
    }

    func toJSON() -> [String: Any] {
        return [
            Key.deviceKey: deviceKey,
            Key.provider: provider,
            Key.owner: owner ?? NSNull(),
            Key.minDistance: minDistanceMeters,
            Key.minInterval: minIntervalMs,
            Key.maxAccuracy: maxAccuracyMeters
        ]
    }

    /// Parses the JS options object (or a persisted copy). Returns nil when `deviceKey` is
    /// missing or blank: without it no `source_id` can be built, and a record with a made-up
    /// key would never dedupe against the web side's.
    static func fromJSON(_ json: [String: Any]) -> LocationTrackingConfig? {
        let deviceKey = (json[Key.deviceKey] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if deviceKey.isEmpty {
            return nil
        }

        let owner = (json[Key.owner] as? String).flatMap { (value: String) -> String? in
            value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : value
        }
        let provider = (json[Key.provider] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)

        return LocationTrackingConfig(
            deviceKey: deviceKey,
            provider: provider.isEmpty ? defaultProvider : provider,
            owner: owner,
            minDistanceMeters: positiveOr(json[Key.minDistance], defaultMinDistanceMeters),
            minIntervalMs: Int64(positiveOr(json[Key.minInterval], Double(defaultMinIntervalMs))),
            maxAccuracyMeters: positiveOr(json[Key.maxAccuracy], defaultMaxAccuracyMeters)
        )
    }

    /// A JSON number arrives as `NSNumber` through Capacitor and `JSONSerialization` alike;
    /// anything else, or a non-positive value, falls back.
    private static func positiveOr(_ value: Any?, _ fallback: Double) -> Double {
        guard let number = value as? NSNumber else {
            return fallback
        }
        let double = number.doubleValue
        return double.isFinite && double > 0 ? double : fallback
    }
}
