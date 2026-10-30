import CoreLocation
import Foundation
import UIKit
import UserNotifications

/// Everything the tracker must remember across process deaths.
struct TrackingState: Equatable {
    let config: LocationTrackingConfig
    /// The last fix actually queued -- what the distance/interval gate compares against, and
    /// the centre of the resume geofence.
    let lastAccepted: GateSample?

    func toJSON() -> [String: Any] {
        var json: [String: Any] = ["config": config.toJSON()]
        if let last = lastAccepted {
            json["lastAccepted"] = ["latitude": last.latitude, "longitude": last.longitude, "atMs": last.atMs] as [String: Any]
        } else {
            json["lastAccepted"] = NSNull()
        }
        return json
    }

    static func fromJSON(_ json: [String: Any]) -> TrackingState? {
        guard let configJSON = json["config"] as? [String: Any],
              let config = LocationTrackingConfig.fromJSON(configJSON) else {
            return nil
        }
        var last: GateSample?
        if let sample = json["lastAccepted"] as? [String: Any],
           let latitude = (sample["latitude"] as? NSNumber)?.doubleValue,
           let longitude = (sample["longitude"] as? NSNumber)?.doubleValue,
           latitude.isFinite, longitude.isFinite {
            last = GateSample(latitude: latitude, longitude: longitude, atMs: (sample["atMs"] as? NSNumber)?.int64Value ?? 0)
        }
        return TrackingState(config: config, lastAccepted: last)
    }
}

/// Durable home for `TrackingState`: `UserDefaults`, the counterpart of Android's
/// SharedPreferences store. Holds the device key, the owner stamp and one coordinate pair,
/// nothing the encrypted outbox holds; the same values the web side keeps in web storage.
final class TrackingStateStore {
    private static let key = "ci.localhub.locationTracking.state"
    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
    }

    func load() -> TrackingState? {
        guard let data = defaults.data(forKey: Self.key),
              let object = try? JSONSerialization.jsonObject(with: data),
              let json = object as? [String: Any] else {
            return nil
        }
        return TrackingState.fromJSON(json)
    }

    func save(_ state: TrackingState) {
        if let data = try? JSONSerialization.data(withJSONObject: state.toJSON()) {
            defaults.set(data, forKey: Self.key)
        }
    }

    func clear() {
        defaults.removeObject(forKey: Self.key)
    }
}

/// iOS Always: significant-change monitoring plus one resume geofence, armed from the app
/// and kept armed until the person turns Always off -- across the app being swiped away,
/// a process death and a reboot.
///
/// What this replaces: a monitor that only the WebView could start, whose samples only the
/// WebView could queue. iOS relaunches a terminated app in the background for a significant
/// change or a region exit, including after a reboot, but it hands the event to
/// `application(_:didFinishLaunchingWithOptions:)` with no WebView and gives the app seconds
/// to act. So the app delegate calls `handleAppLaunch` on every launch; with Always armed
/// this restarts the monitor, and every fix that clears the distance/interval gate is queued
/// into the encrypted outbox from native code with the record the web side would have built
/// (`PositionRecordJson`). When the plugin *is* alive it is told as well
/// (`significantLocation`), and the web side's own enqueue of the same fix collapses on the
/// shared `source_id`. Fixes recorded while the WebView is gone sit in the outbox until the
/// next app open drains it, as on Android.
///
/// The geofence is the reboot insurance. Significant-change monitoring is documented to
/// relaunch the app, but a region exit is the event iOS is most reliable about after a
/// reboot, so the last queued fix is also wrapped in a `minDistanceMeters` circle whose exit
/// re-centres it on the next fix. One region, well under the twenty iOS allows.
///
/// What it cannot do, and what stands in: if the Always grant has been withdrawn (the
/// periodic "continue to allow?" reminder, or Settings) a relaunch can start nothing, so it
/// posts one plain notification asking the person to open the app, where the web side's
/// re-arm runs the two-step prompt again. An app the person force-quit is not relaunched by
/// iOS at all until its next open; the plugin's resume hook covers that case.
///
/// All state lives in `TrackingStateStore` so a process iOS created just to deliver one
/// event knows whether Always is on. Everything runs on the main thread: Core Location
/// delegates need a run loop, and the app delegate and the plugin both call from there.
public final class LocationTracking: NSObject {
    public static let shared = LocationTracking()

    static let resumeNotificationIdentifier = "ci.localhub.location.resume"

    /// The plugin's event sink while a WebView exists; nil once the plugin is gone.
    var listener: (([String: Any]) -> Void)?

    private let store: TrackingStateStore
    private let monitor: SignificantLocationMonitor
    private let outbox: () throws -> OutboxStore
    private var state: TrackingState?
    private var loaded = false

    override private convenience init() {
        self.init(
            store: TrackingStateStore(),
            monitor: SignificantLocationMonitor.shared,
            outbox: { () throws -> OutboxStore in try OutboxStore.shared() }
        )
    }

    init(store: TrackingStateStore, monitor: SignificantLocationMonitor, outbox: @escaping () throws -> OutboxStore) {
        self.store = store
        self.monitor = monitor
        self.outbox = outbox
        super.init()
        monitor.onUpdate = { [weak self] location in
            _ = self?.onFix(location)
        }
        monitor.onDenied = { [weak self] in
            self?.onAuthorizationLost()
        }
    }

    var isArmed: Bool {
        return current() != nil
    }

    /// Every launch of the app, from the app delegate: a tap, a relaunch for a location or
    /// region event (`launchOptions[.location]`), a relaunch after a reboot. With Always
    /// armed the monitor is started again before iOS stops waiting for the app; the pending
    /// fix then arrives through the monitor's delegate like any other.
    public static func handleAppLaunch(launchOptions: [UIApplication.LaunchOptionsKey: Any]?) {
        shared.resumeIfArmed()
    }

    /// Arm, or re-arm with new options, and start monitoring. Called on every app open by the
    /// web side; a running monitor is left running and only the config is refreshed.
    func arm(_ config: LocationTrackingConfig) {
        let previous = current()
        persist(TrackingState(config: config, lastAccepted: previous?.lastAccepted))
        clearResumeNudge()
        startMonitoring()
    }

    func disarm() {
        monitor.stop()
        clearResumeNudge()
        state = nil
        loaded = true
        store.clear()
    }

    /// Puts the monitor back if Always is on and it is not running -- after a relaunch, a
    /// reboot or a process death -- so recording resumes on the launch itself, not on the
    /// web side's later re-arm. A running monitor is never touched.
    func resumeIfArmed() {
        guard current() != nil else {
            return
        }
        startMonitoring()
    }

    /// One Core Location fix, from significant-change monitoring or a region exit.
    @discardableResult
    func onFix(_ location: CLLocation) -> FixOutcome {
        guard let now = current() else {
            return .ignored("not armed")
        }
        let fix = LocationFix(location)
        let decision = LocationSamplingGate.decide(
            config: now.config,
            last: now.lastAccepted,
            latitude: fix.latitude,
            longitude: fix.longitude,
            accuracyMeters: fix.accuracyMeters,
            atMs: fix.capturedAtMs
        )
        if case .reject(let reason) = decision {
            return .ignored(reason)
        }
        guard let record = PositionRecordJson.record(fix, deviceKey: now.config.deviceKey, provider: now.config.provider),
              let time = record["time"] as? String,
              let sourceId = record["source_id"] as? String else {
            return .ignored("unusable fix")
        }

        let outcome: EnqueueOutcome
        do {
            outcome = try outbox().enqueue(
                kind: PositionRecordJson.outboxKind,
                payloadJSON: try PositionRecordJson.jsonText(PositionRecordJson.payload(record)),
                capturedAt: time,
                idempotencyKey: sourceId,
                owner: now.config.owner
            )
        } catch {
            return .failed(error.localizedDescription)
        }

        switch outcome {
        case .created, .duplicate:
            let sample = GateSample(latitude: fix.latitude, longitude: fix.longitude, atMs: fix.capturedAtMs)
            persist(TrackingState(config: now.config, lastAccepted: sample))
            monitor.recenterGeofence(latitude: sample.latitude, longitude: sample.longitude, radiusMeters: now.config.minDistanceMeters)
            listener?(PositionRecordJson.eventBody(fix))
            return .queued(sourceId)
        case .atCapacity:
            return .failed("outbox at capacity")
        }
    }

    enum FixOutcome: Equatable {
        case queued(String)
        case ignored(String)
        case failed(String)
    }

    // MARK: - Private

    private func startMonitoring() {
        guard let now = current() else {
            return
        }
        guard CLLocationManager().authorizationStatus == .authorizedAlways else {
            // Nothing can run without Always: ask for the open that re-runs the prompt.
            onAuthorizationLost()
            return
        }
        monitor.start()
        if let last = now.lastAccepted {
            monitor.recenterGeofence(latitude: last.latitude, longitude: last.longitude, radiusMeters: now.config.minDistanceMeters)
        }
    }

    /// Always was withdrawn, or the monitor hit a denial: with Always on in our state the only
    /// way back is an app open, so ask for one. Nothing to say when Always is off.
    private func onAuthorizationLost() {
        guard current() != nil else {
            return
        }
        monitor.stop()
        showResumeNudge()
    }

    private func showResumeNudge() {
        let center = UNUserNotificationCenter.current()
        center.getNotificationSettings { settings in
            guard settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional else {
                // Notifications were refused: the one case where a lost grant silently pauses
                // recording until the next app open, as on Android.
                return
            }
            let content = UNMutableNotificationContent()
            content.title = "Location recording paused"
            content.body = "Open Companion to keep recording where you go."
            content.sound = nil
            let request = UNNotificationRequest(identifier: LocationTracking.resumeNotificationIdentifier, content: content, trigger: nil)
            center.add(request, withCompletionHandler: nil)
        }
    }

    private func clearResumeNudge() {
        let center = UNUserNotificationCenter.current()
        center.removeDeliveredNotifications(withIdentifiers: [Self.resumeNotificationIdentifier])
        center.removePendingNotificationRequests(withIdentifiers: [Self.resumeNotificationIdentifier])
    }

    private func current() -> TrackingState? {
        if !loaded {
            state = store.load()
            loaded = true
        }
        return state
    }

    private func persist(_ next: TrackingState) {
        state = next
        loaded = true
        store.save(next)
    }
}
