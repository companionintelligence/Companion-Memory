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
///
/// Both services this manager runs -- significant changes and the one resume geofence --
/// relaunch a terminated app in the background when they fire, including after a reboot,
/// as long as the app is started again and asks for them: `LocationTracking` does that from
/// the app delegate. Samples go to `onUpdate` as the raw `CLLocation`; the tracker builds
/// the record and decides whether it is worth queueing.
final class SignificantLocationMonitor: NSObject, CLLocationManagerDelegate {
    static let shared = SignificantLocationMonitor()

    static let geofenceIdentifier = "ci.localhub.location.resume-geofence"

    /// A fix delivered on relaunch can predate the start by the seconds iOS took to launch
    /// the process; a fix from before the person turned Always on is older than that.
    private static let freshWindow: TimeInterval = 60

    /// The most recent fix Core Location holds is reused after a region exit when it is at
    /// most this old; an older one is left to the next significant change.
    private static let reusableFixAge: TimeInterval = 120

    var onUpdate: ((CLLocation) -> Void)?
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
        for region in manager.monitoredRegions where region.identifier == Self.geofenceIdentifier {
            manager.stopMonitoring(for: region)
        }
    }

    /// Replace the resume geofence with one around the fix just queued. Exit is the only
    /// event wanted: it means the phone moved at least the gate distance, which is a fix the
    /// tracker would accept anyway.
    func recenterGeofence(latitude: Double, longitude: Double, radiusMeters: Double) {
        guard running, CLLocationManager.isMonitoringAvailable(for: CLCircularRegion.self) else {
            return
        }
        for region in manager.monitoredRegions where region.identifier == Self.geofenceIdentifier {
            manager.stopMonitoring(for: region)
        }
        let radius = min(max(radiusMeters, 100), manager.maximumRegionMonitoringDistance)
        let region = CLCircularRegion(
            center: CLLocationCoordinate2D(latitude: latitude, longitude: longitude),
            radius: radius,
            identifier: Self.geofenceIdentifier
        )
        region.notifyOnEntry = false
        region.notifyOnExit = true
        manager.startMonitoring(for: region)
    }

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard running, let location = locations.last, isFresh(location) else { return }
        onUpdate?(location)
    }

    /// The phone left the circle around the last queued fix. Without the standard location
    /// service there is no new sample to ask for from the background, but Core Location keeps
    /// the fix that triggered the exit; it is used when recent enough.
    func locationManager(_ manager: CLLocationManager, didExitRegion region: CLRegion) {
        guard running, region.identifier == Self.geofenceIdentifier else { return }
        guard let location = manager.location,
              Date().timeIntervalSince(location.timestamp) <= Self.reusableFixAge,
              location.horizontalAccuracy > 0 else {
            return
        }
        onUpdate?(location)
    }

    func locationManager(_ manager: CLLocationManager, monitoringDidFailFor region: CLRegion?, withError error: Error) {
        // The geofence is insurance on top of significant-change monitoring; losing it is
        // not a reason to stop. A denial surfaces through didFailWithError as well.
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        guard running else { return }
        if let clErr = error as? CLError, clErr.code == .denied {
            onDenied?()
        }
    }

    /// The first callback after `start` can be a cached fix from before Always was on.
    private func isFresh(_ location: CLLocation) -> Bool {
        location.timestamp >= startedAt.addingTimeInterval(-Self.freshWindow)
            && location.horizontalAccuracy > 0
    }
}
