import Capacitor
import Foundation
import LocalAuthentication
import UIKit

/// The iOS half of the app lock. The lock STATE lives here, not in the page: a cold start
/// reads the settings in `load()` and shows the overlay before the web view has loaded
/// anything, and every later decision (grace expiry on return, lock on leaving) is taken
/// here and announced to JS with `lockStateChange`. The web gate mirrors the state.
///
/// Authentication is `LAContext.evaluatePolicy(.deviceOwnerAuthentication, …)` — the
/// policy WITH passcode fallback. `.deviceOwnerAuthenticationWithBiometrics` would lock a
/// user with no enrolled biometric, or one failed Face ID, out of their own memory with
/// no way back; SECURITY_ARCHITECTURE.md § 4.1 calls that the most common way this
/// feature ships broken. `NSFaceIDUsageDescription` must be in the app's Info.plist.
///
/// Two overlays: the lock screen (`LockOverlayView`, while locked) and a blur that covers
/// the app the moment it resigns active, so the task-switcher snapshot shows nothing —
/// iOS has no `FLAG_SECURE`, so this is the whole of the switcher control. Sync keeps
/// running behind both; no database key is tied to the prompt (§ 4.4).
@objc(AppLockPlugin)
public class AppLockPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AppLockPlugin"
    public let jsName = "AppLock"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "configure", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "lock", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "unlock", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setLockScreenNote", returnType: CAPPluginReturnPromise)
    ]

    private var settings = AppLockSettings.load()
    private var locked = false
    /// When the app last left the foreground; nil while active or never backgrounded.
    private var backgroundedAt: Date?
    private var overlay: LockOverlayView?
    private var blur: UIVisualEffectView?
    private var note = ""
    /// A prompt is showing. Resign/activate caused by the prompt itself must not re-decide the lock.
    private var prompting = false
    private var pendingUnlocks: [CAPPluginCall] = []
    private var observers: [NSObjectProtocol] = []

    public override func load() {
        let center = NotificationCenter.default

        observers.append(center.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: .main) { [weak self] _ in
            self?.appWillResignActive()
        })
        observers.append(center.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
            self?.appDidEnterBackground()
        })
        observers.append(center.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in
            self?.appDidBecomeActive()
        })

        if AppLockPolicy.locksOnLaunch(settings) {
            setLocked(true)
        }
    }

    deinit {
        observers.forEach { NotificationCenter.default.removeObserver($0) }
    }

    // MARK: - Lifecycle

    private func appWillResignActive() {
        guard !prompting, settings.enabled else { return }
        // The switcher snapshot is taken after this; cover the page now.
        showBlur()
    }

    private func appDidEnterBackground() {
        guard !prompting else { return }
        backgroundedAt = Date()
        if AppLockPolicy.locksOnPause(settings) {
            setLocked(true)
        }
    }

    private func appDidBecomeActive() {
        guard !prompting else { return }
        if !locked, AppLockPolicy.locksOnResume(settings, backgroundedAt: backgroundedAt, now: Date()) {
            setLocked(true)
        }
        backgroundedAt = nil
        hideBlur()
        if locked {
            // Coming back to a locked app: ask at once rather than making the user tap.
            promptUnlock(nil)
        }
    }

    // MARK: - Methods

    @objc func getStatus(_ call: CAPPluginCall) {
        call.resolve(statusJson())
    }

    @objc func configure(_ call: CAPPluginCall) {
        var next = settings
        if let enabled = call.getBool("enabled") { next.enabled = enabled }
        if let grace = call.getString("grace") { next.grace = Grace.fromWire(grace) }
        if let secureScreen = call.getBool("secureScreen") { next.secureScreen = secureScreen }

        if next.enabled, !settings.enabled {
            // Turning the lock on: prove the user can get back in before it ever engages.
            guard isAvailable() else {
                call.resolve(statusJson(reason: "This device has no passcode or biometric to unlock with."))
                return
            }
            authenticate(reason: "Confirm it is you, so you can always get back in") { [weak self] ok in
                guard let self else { return }
                if ok { self.apply(next) }
                call.resolve(self.statusJson(reason: ok ? nil : "authentication-cancelled"))
            }
            return
        }

        apply(next)
        if !next.enabled, locked {
            setLocked(false)
        }
        call.resolve(statusJson())
    }

    @objc func lock(_ call: CAPPluginCall) {
        if settings.enabled {
            setLocked(true)
        }
        call.resolve(statusJson())
    }

    @objc func unlock(_ call: CAPPluginCall) {
        guard locked else {
            call.resolve(statusJson())
            return
        }
        promptUnlock(call)
    }

    @objc func setLockScreenNote(_ call: CAPPluginCall) {
        note = call.getString("text") ?? ""
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.overlay?.setNote(self.note)
        }
        call.resolve()
    }

    // MARK: - State

    private func apply(_ next: AppLockSettings) {
        settings = next
        next.save()
    }

    private func setLocked(_ value: Bool) {
        guard locked != value else { return }
        locked = value
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            if value { self.showOverlay() } else { self.hideOverlay() }
        }
        notifyListeners("lockStateChange", data: ["locked": value])
    }

    /// The view the overlays sit in: the bridge's view controller's view, above the web view.
    private var hostView: UIView? {
        bridge?.viewController?.view
    }

    private func showOverlay() {
        guard overlay == nil, let host = hostView else { return }
        let view = LockOverlayView { [weak self] in self?.promptUnlock(nil) }
        view.setNote(note)
        view.frame = host.bounds
        view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        host.addSubview(view)
        overlay = view
        // The lock screen is the switcher snapshot now; a blur on top of it hides nothing more.
        hideBlur()
    }

    private func hideOverlay() {
        overlay?.removeFromSuperview()
        overlay = nil
    }

    private func showBlur() {
        guard blur == nil, overlay == nil, let host = hostView else { return }
        let view = UIVisualEffectView(effect: UIBlurEffect(style: .systemThickMaterial))
        view.frame = host.bounds
        view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        host.addSubview(view)
        blur = view
    }

    private func hideBlur() {
        blur?.removeFromSuperview()
        blur = nil
    }

    // MARK: - Prompt

    private func promptUnlock(_ call: CAPPluginCall?) {
        if let call { pendingUnlocks.append(call) }
        guard !prompting else { return }

        authenticate(reason: "Unlock Companion Memory") { [weak self] ok in
            guard let self else { return }
            if ok { self.setLocked(false) }
            let waiting = self.pendingUnlocks
            self.pendingUnlocks.removeAll()
            let status = self.statusJson(reason: ok ? nil : "authentication-cancelled")
            waiting.forEach { $0.resolve(status) }
        }
    }

    /// One OS prompt. `onResult` runs once, on the main thread, with whether the user passed.
    private func authenticate(reason: String, onResult: @escaping (Bool) -> Void) {
        guard !prompting else {
            onResult(false)
            return
        }
        prompting = true

        let context = LAContext()
        var error: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
            prompting = false
            onResult(false)
            return
        }

        context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { [weak self] success, _ in
            DispatchQueue.main.async {
                self?.prompting = false
                onResult(success)
            }
        }
    }

    // MARK: - Status

    private func isAvailable() -> Bool {
        LAContext().canEvaluatePolicy(.deviceOwnerAuthentication, error: nil)
    }

    private func biometry() -> String {
        let context = LAContext()
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: nil) else { return "none" }
        // biometryType is populated by canEvaluatePolicy; Face ID and Touch ID are both Class 3.
        switch context.biometryType {
        case .faceID, .touchID:
            return "strong"
        default:
            if #available(iOS 17.0, *), context.biometryType == .opticID {
                return "strong"
            }
            return "credential-only"
        }
    }

    private func statusJson(reason: String? = nil) -> [String: Any] {
        var json: [String: Any] = [
            "enabled": settings.enabled,
            "grace": settings.grace.rawValue,
            "secureScreen": settings.secureScreen,
            "locked": locked,
            "available": isAvailable(),
            "biometry": biometry(),
        ]
        if let reason {
            json["reason"] = reason
        } else if !isAvailable() {
            json["reason"] = "This device has no passcode or biometric to unlock with."
        }
        return json
    }
}
