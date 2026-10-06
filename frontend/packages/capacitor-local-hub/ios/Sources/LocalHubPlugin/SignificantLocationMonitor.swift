import CoreLocation
import Foundation

/// Background samples for Always tracking on iOS.
///
/// `startUpdatingLocation` with `showsBackgroundLocationIndicator` is what paints the
/// solid blue pill for the whole time the app is away, including while the phone is
/// sitting still. Significant-change monitoring wakes on a real move (cell / ~500 m)
/// and does not hold that indicator. It is a second `CLLocationManager` so the
/// one-shot "use my location" fetch in `LocationTracker` can start and stop standard
/// updates without tearing this down.
final class SignificantLocationMonitor: NSObject, CLLocationManagerDelegate {
    static let shared = SignificantLocationMonitor()

    var onUpdate: (([String: Any]) -> Void)?
    var onDenied: (() -> Void)?

    private let manager = CLLocationManager()
    private var running = false
    private var startedAt = Date()

    override private init() {
        super.init()
        manager.delegate = self
        manager.desiredAccuracy = kCLLocationAccuracyHundredMeters
        manager.activityType = .other
        // The blue pill is the standard location service. This monitor never starts it.
        manager.showsBackgroundLocationIndicator = false
        manager.allowsBackgroundLocationUpdates = false
        manager.pausesLocationUpdatesAutomatically = true
    }

    func start() {
        if running {
            return
        }

        startedAt = Date()
        running = true
        manager.startMonitoringSignificantLocationChanges()
    }

    func stop() {
        if !running {
            return
        }

        running = false
        manager.stopMonitoringSignificantLocationChanges()
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard running, let location = locations.last, isFresh(location) else { return }
        onUpdate?(payload(location))
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        guard running else { return }
        if let clErr = error as? CLError, clErr.code == .denied {
            onDenied?()
        }
    }

    /// The first callback after `start` can be a cached fix from before Always was on.
    private func isFresh(_ location: CLLocation) -> Bool {
        location.timestamp >= startedAt.addingTimeInterval(-15)
            && location.horizontalAccuracy > 0
    }

    private func payload(_ location: CLLocation) -> [String: Any] {
        var body: [String: Any] = [
            "latitude": location.coordinate.latitude,
            "longitude": location.coordinate.longitude,
            "accuracy": location.horizontalAccuracy,
            "altitude": location.altitude,
            "altitudeAccuracy": location.verticalAccuracy,
            "time": Int(location.timestamp.timeIntervalSince1970 * 1000),
        ]

        if location.speed >= 0 {
            body["speed"] = location.speed
        }

        if location.course >= 0 {
            body["bearing"] = location.course
        }

        return body
    }
}
