import CoreLocation
import Foundation

/// One-shot high-accuracy location fetcher for "use my current location" (e.g. adding a
/// Place). Does not enqueue a tracking outbox record and does not run in the background.
///
/// Continuous background tracking (the old `Mode`/significant-change/home-geofence design
/// this class used to also own) is now handled entirely by
/// `@capacitor-community/background-geolocation` on both platforms — see
/// `useLocationTracking.ts`. Splitting them keeps this class's `CLLocationManager` instance
/// free of state a continuous watcher would otherwise fight over.
final class LocationTracker: NSObject, CLLocationManagerDelegate {
    static let shared = LocationTracker()

    private static let oneShotTimeout: TimeInterval = 15
    private static let recentFixMaxAge: TimeInterval = 15
    private static let recentFixMaxAccuracy: CLLocationAccuracy = 40
    private static let oneShotAcceptAccuracy: CLLocationAccuracy = 65

    private let manager = CLLocationManager()
    private let lock = NSLock()

    private var lastKnown: CLLocation?
    private var oneShotCompletions: [(Result<[String: Any], Error>) -> Void] = []
    private var authCompletions: [(String) -> Void] = []
    private var oneShotTimeoutWork: DispatchWorkItem?
    private var oneShotInFlight = false
    private var oneShotStartedUpdates = false
    private var oneShotPreviousAccuracy: CLLocationAccuracy?

    override private init() {
        super.init()
        manager.delegate = self
        manager.pausesLocationUpdatesAutomatically = true
        manager.activityType = .other
    }

    /// One-shot high-accuracy fix for "use my location" on add-place.
    /// Does not enqueue a tracking outbox record.
    func requestCurrentFix(resolve: @escaping ([String: Any]) -> Void, reject: @escaping (String) -> Void) {
        let completion: (Result<[String: Any], Error>) -> Void = { result in
            switch result {
            case .success(let payload):
                resolve(payload)
            case .failure(let error):
                reject(error.localizedDescription)
            }
        }

        switch manager.authorizationStatus {
        case .denied, .restricted:
            reject("Location permission was denied")
            return
        case .notDetermined:
            lock.lock()
            oneShotCompletions.append(completion)
            lock.unlock()
            manager.requestWhenInUseAuthorization()
            return
        default:
            break
        }

        if let cached = freshCachedFix() {
            resolve(fixDictionary(cached))
            return
        }

        enqueueOneShot(completion)
        startOneShotSampling()
    }

    // MARK: - Authorization

    /// `notDetermined` / `denied` / `restricted` / `whenInUse` / `always`.
    func authorizationStatusName() -> String {
        switch manager.authorizationStatus {
        case .authorizedAlways:
            return "always"
        case .authorizedWhenInUse:
            return "whenInUse"
        case .denied:
            return "denied"
        case .restricted:
            return "restricted"
        case .notDetermined:
            return "notDetermined"
        @unknown default:
            return "notDetermined"
        }
    }

    /// Prompts When In Use, or Always when that is already granted / requested.
    /// Resolves with `authorizationStatusName` after the OS answers.
    /// iOS 13+ shows When In Use first when status is still `notDetermined`;
    /// callers that want Always must call again after that first grant.
    func requestAuthorization(always: Bool, resolve: @escaping (String) -> Void) {
        let current = manager.authorizationStatus
        if always {
            if current == .authorizedAlways || current == .denied || current == .restricted {
                resolve(authorizationStatusName())
                return
            }
        } else if current != .notDetermined {
            resolve(authorizationStatusName())
            return
        }

        lock.lock()
        authCompletions.append(resolve)
        lock.unlock()

        if always {
            manager.requestAlwaysAuthorization()
            // Escalating from When In Use often shows no second dialog (the
            // user already picked While Using). The delegate then never
            // fires and the JS Always path would hang. Resolve with the
            // current status shortly; a real Always prompt still wins if
            // the delegate fires first.
            if current == .authorizedWhenInUse {
                DispatchQueue.main.asyncAfter(deadline: .now() + 2) { [weak self] in
                    self?.finishPendingAuthorizationIfWaiting()
                }
            }
        } else {
            manager.requestWhenInUseAuthorization()
        }
    }

    func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        finishPendingAuthorization()
        continueOneShotAfterAuthorization()
    }

    private func finishPendingAuthorizationIfWaiting() {
        lock.lock()
        let waiting = !authCompletions.isEmpty
        lock.unlock()
        guard waiting else { return }
        finishPendingAuthorization()
    }

    private func finishPendingAuthorization() {
        // iOS 14+ fires this with `.notDetermined` when the dialog is still up.
        if manager.authorizationStatus == .notDetermined {
            return
        }

        lock.lock()
        let completions = authCompletions
        authCompletions.removeAll()
        lock.unlock()
        guard !completions.isEmpty else { return }
        let status = authorizationStatusName()
        completions.forEach { $0(status) }
    }

    // MARK: - Fixes

    func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        guard let latest = locations.last else { return }
        lastKnown = latest
        if oneShotInFlight, isAcceptableOneShot(latest) {
            finishOneShot(with: latest)
        }
    }

    func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        guard oneShotInFlight || hasPendingOneShot() else { return }
        if let lastKnown, lastKnown.horizontalAccuracy > 0 {
            finishOneShot(with: lastKnown)
        } else {
            failOneShot(error)
        }
    }

    private func freshCachedFix() -> CLLocation? {
        [manager.location, lastKnown].compactMap { $0 }.first { isFreshEnough($0) }
    }

    private func isFreshEnough(_ location: CLLocation) -> Bool {
        let age = -location.timestamp.timeIntervalSinceNow
        return age >= 0
            && age <= Self.recentFixMaxAge
            && location.horizontalAccuracy > 0
            && location.horizontalAccuracy <= Self.recentFixMaxAccuracy
    }

    private func isAcceptableOneShot(_ location: CLLocation) -> Bool {
        location.horizontalAccuracy > 0 && location.horizontalAccuracy <= Self.oneShotAcceptAccuracy
    }

    private func enqueueOneShot(_ completion: @escaping (Result<[String: Any], Error>) -> Void) {
        lock.lock()
        oneShotCompletions.append(completion)
        lock.unlock()
    }

    private func hasPendingOneShot() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return !oneShotCompletions.isEmpty
    }

    private func continueOneShotAfterAuthorization() {
        guard hasPendingOneShot(), !oneShotInFlight else { return }
        switch manager.authorizationStatus {
        case .denied, .restricted:
            failOneShot(NSError(domain: "LocationTracker", code: 5, userInfo: [
                NSLocalizedDescriptionKey: "Location permission was denied"
            ]))
        case .authorizedWhenInUse, .authorizedAlways:
            if let cached = freshCachedFix() {
                finishOneShot(with: cached)
            } else {
                startOneShotSampling()
            }
        default:
            break
        }
    }

    private func startOneShotSampling() {
        guard !oneShotInFlight else { return }
        oneShotInFlight = true
        oneShotPreviousAccuracy = manager.desiredAccuracy
        manager.desiredAccuracy = kCLLocationAccuracyBest
        manager.startUpdatingLocation()
        oneShotStartedUpdates = true
        manager.requestLocation()

        let work = DispatchWorkItem { [weak self] in
            self?.timeoutOneShot()
        }
        oneShotTimeoutWork = work
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.oneShotTimeout, execute: work)
    }

    private func timeoutOneShot() {
        if let lastKnown, lastKnown.horizontalAccuracy > 0 {
            finishOneShot(with: lastKnown)
            return
        }
        failOneShot(NSError(domain: "LocationTracker", code: 4, userInfo: [
            NSLocalizedDescriptionKey: "Timed out waiting for a location fix"
        ]))
    }

    private func finishOneShot(with location: CLLocation) {
        guard oneShotInFlight || hasPendingOneShot() else { return }
        oneShotTimeoutWork?.cancel()
        oneShotTimeoutWork = nil
        restoreOneShotSampling()
        oneShotInFlight = false

        let payload = fixDictionary(location)
        lock.lock()
        let completions = oneShotCompletions
        oneShotCompletions.removeAll()
        lock.unlock()
        completions.forEach { $0(.success(payload)) }
    }

    private func failOneShot(_ error: Error) {
        guard oneShotInFlight || hasPendingOneShot() else { return }
        oneShotTimeoutWork?.cancel()
        oneShotTimeoutWork = nil
        restoreOneShotSampling()
        oneShotInFlight = false

        lock.lock()
        let completions = oneShotCompletions
        oneShotCompletions.removeAll()
        lock.unlock()
        completions.forEach { $0(.failure(error)) }
    }

    private func restoreOneShotSampling() {
        if oneShotStartedUpdates {
            oneShotStartedUpdates = false
            manager.stopUpdatingLocation()
        }
        if let previous = oneShotPreviousAccuracy {
            manager.desiredAccuracy = previous
        }
        oneShotPreviousAccuracy = nil
    }

    private func fixDictionary(_ location: CLLocation) -> [String: Any] {
        [
            "latitude": location.coordinate.latitude,
            "longitude": location.coordinate.longitude,
            "accuracy": location.horizontalAccuracy
        ]
    }
}
