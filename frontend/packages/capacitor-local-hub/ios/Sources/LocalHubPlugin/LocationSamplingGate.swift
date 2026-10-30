import Foundation

/// A fix the gate compares against: the last one actually queued.
struct GateSample: Equatable {
    let latitude: Double
    let longitude: Double
    let atMs: Int64
}

/// The persist gate, the same rule as `createLocationSampler` on the web side and
/// `LocationSamplingGate` on Android: record a fix when the phone has **moved far enough OR
/// waited long enough** since the last one it queued, and never when the fix is looser than
/// `LocationTrackingConfig.maxAccuracyMeters`.
///
/// Pure. The caller advances the gate (keeps the new `GateSample`) only after the record is
/// durably queued, so a failed enqueue does not swallow the fix and restart the clock.
enum LocationSamplingGate {
    private static let earthRadiusMeters = 6_371_000.0

    enum Decision: Equatable {
        case accept
        case reject(String)
    }

    static func decide(
        config: LocationTrackingConfig,
        last: GateSample?,
        latitude: Double,
        longitude: Double,
        accuracyMeters: Double?,
        atMs: Int64
    ) -> Decision {
        if !latitude.isFinite || !longitude.isFinite {
            return .reject("non-finite coordinates")
        }
        if latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180 {
            return .reject("coordinates out of range")
        }
        if let accuracy = accuracyMeters, accuracy.isFinite, accuracy > config.maxAccuracyMeters {
            return .reject("accuracy \(accuracy)m looser than \(config.maxAccuracyMeters)m")
        }
        guard let last = last else {
            return .accept
        }
        let moved = haversineMeters(last.latitude, last.longitude, latitude, longitude)
        if moved >= config.minDistanceMeters {
            return .accept
        }
        if atMs - last.atMs >= config.minIntervalMs {
            return .accept
        }
        return .reject("moved \(Int(moved))m < \(Int(config.minDistanceMeters))m and \(atMs - last.atMs)ms < \(config.minIntervalMs)ms")
    }

    /// Great-circle distance in metres; spherical is ample for a movement gate.
    static func haversineMeters(_ aLat: Double, _ aLng: Double, _ bLat: Double, _ bLng: Double) -> Double {
        let dLat = (bLat - aLat) * .pi / 180
        let dLng = (bLng - aLng) * .pi / 180
        let s = sin(dLat / 2) * sin(dLat / 2)
            + cos(aLat * .pi / 180) * cos(bLat * .pi / 180) * sin(dLng / 2) * sin(dLng / 2)
        return earthRadiusMeters * 2 * atan2(sqrt(s), sqrt(1 - s))
    }
}
