import CoreLocation
import Foundation

/// One OS fix, in the shape the web side's `DeviceLocationFix` carries.
struct LocationFix: Equatable {
    let latitude: Double
    let longitude: Double
    let accuracyMeters: Double?
    let altitudeMeters: Double?
    let altitudeAccuracyMeters: Double?
    let headingDegrees: Double?
    let speedMetersPerSecond: Double?
    let capturedAtMs: Int64

    /// Core Location reports "unknown" as a negative accuracy, speed or course; those become
    /// nil here, which `PositionRecordJson.record` then omits.
    init(_ location: CLLocation) {
        latitude = location.coordinate.latitude
        longitude = location.coordinate.longitude
        accuracyMeters = location.horizontalAccuracy >= 0 ? location.horizontalAccuracy : nil
        altitudeMeters = location.verticalAccuracy >= 0 ? location.altitude : nil
        altitudeAccuracyMeters = location.verticalAccuracy >= 0 ? location.verticalAccuracy : nil
        headingDegrees = location.course >= 0 ? location.course : nil
        speedMetersPerSecond = location.speed >= 0 ? location.speed : nil
        capturedAtMs = Int64((location.timestamp.timeIntervalSince1970 * 1000).rounded())
    }

    init(
        latitude: Double,
        longitude: Double,
        accuracyMeters: Double?,
        altitudeMeters: Double?,
        altitudeAccuracyMeters: Double?,
        headingDegrees: Double?,
        speedMetersPerSecond: Double?,
        capturedAtMs: Int64
    ) {
        self.latitude = latitude
        self.longitude = longitude
        self.accuracyMeters = accuracyMeters
        self.altitudeMeters = altitudeMeters
        self.altitudeAccuracyMeters = altitudeAccuracyMeters
        self.headingDegrees = headingDegrees
        self.speedMetersPerSecond = speedMetersPerSecond
        self.capturedAtMs = capturedAtMs
    }
}

/// Builds the wire record for a fix, field for field what `buildPositionRecord` in
/// `@ci/common/src/utils/deviceSources/location.ts` builds -- and what the Android
/// `PositionRecordJson` builds -- so a record this module queues from a WebView-less process
/// is indistinguishable from one the web side queues.
///
/// The rules copied from there, and the reasons they matter:
/// - `location.x` is **longitude**, `location.y` is **latitude** (GeoJSON order).
/// - Optional fields are **omitted**, never coerced. `accuracy_meters` must be positive (a
///   zod check and a DB CHECK constraint -- a 0 would 400 the whole batch); a heading outside
///   0-360 is discarded downstream; a negative speed is junk.
/// - `source_id` is `<deviceKey>:<epochMillis>`, the idempotency handle the appliance dedupes
///   on and the outbox's own `idempotencyKey`.
/// - `time` is the JS `Date#toISOString()` form, always with three fractional digits.
///
/// The Android `PositionRecordJsonTest` pins this shape against the web side's fixture; the
/// three builders must change together.
enum PositionRecordJson {
    static let outboxKind = "positions"
    static let source = "gps"
    static let sourceType = "device"
    static let sourceSystem = "companion-device"

    private static let isoFormatter: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "UTC")
        formatter.dateFormat = "yyyy-MM-dd'T'HH:mm:ss.SSS'Z'"
        return formatter
    }()

    static func sourceId(deviceKey: String, capturedAtMs: Int64) -> String {
        return "\(deviceKey):\(capturedAtMs)"
    }

    static func isoTime(_ capturedAtMs: Int64) -> String {
        return isoFormatter.string(from: Date(timeIntervalSince1970: Double(capturedAtMs) / 1000))
    }

    /// The record itself, or nil when the fix is not worth sending (same refusals as the web).
    static func record(_ fix: LocationFix, deviceKey: String, provider: String) -> [String: Any]? {
        if !fix.latitude.isFinite || !fix.longitude.isFinite {
            return nil
        }
        if fix.latitude < -90 || fix.latitude > 90 || fix.longitude < -180 || fix.longitude > 180 {
            return nil
        }

        var record: [String: Any] = [
            "time": isoTime(fix.capturedAtMs),
            "location": ["x": fix.longitude, "y": fix.latitude] as [String: Any]
        ]
        if let accuracy = fix.accuracyMeters, accuracy.isFinite, accuracy > 0 {
            record["accuracy_meters"] = accuracy
        }
        if let altitude = fix.altitudeMeters, altitude.isFinite {
            record["altitude_meters"] = altitude
        }
        if let heading = fix.headingDegrees, heading.isFinite, heading >= 0, heading <= 360 {
            record["heading_degrees"] = heading
        }
        if let speed = fix.speedMetersPerSecond, speed.isFinite, speed >= 0 {
            record["speed_meters_per_second"] = speed
        }
        record["source"] = source
        record["provider"] = provider
        record["source_type"] = sourceType
        record["source_system"] = sourceSystem
        record["source_id"] = sourceId(deviceKey: deviceKey, capturedAtMs: fix.capturedAtMs)
        return record
    }

    /// The outbox payload: the `/api/v1/positions` envelope, posted onward verbatim.
    static func payload(_ record: [String: Any]) -> [String: Any] {
        return ["records": [record]]
    }

    /// The `significantLocation` event body: the `NativeLocationEvent` shape the web side
    /// converts with `fixFromNativeLocationEvent`, so iOS and Android emit one event body and
    /// the hook needs no platform-specific adapter.
    static func eventBody(_ fix: LocationFix) -> [String: Any] {
        return [
            "latitude": fix.latitude,
            "longitude": fix.longitude,
            "accuracy": fix.accuracyMeters ?? NSNull(),
            "altitude": fix.altitudeMeters ?? NSNull(),
            "altitudeAccuracy": fix.altitudeAccuracyMeters ?? NSNull(),
            "bearing": fix.headingDegrees ?? NSNull(),
            "speed": fix.speedMetersPerSecond ?? NSNull(),
            "time": fix.capturedAtMs
        ]
    }

    /// Compact JSON text for the outbox payload column.
    static func jsonText(_ object: [String: Any]) throws -> String {
        let data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        guard let text = String(data: data, encoding: .utf8) else {
            throw OutboxStoreError.sqlFailed("payload is not UTF-8")
        }
        return text
    }
}
