import AVFoundation
import Foundation
import Speech

/// Capability answer for one locale. Mirrors `SpeechRecognitionCapability` in
/// `src/definitions.ts`.
struct RecognitionCapability {
    let available: Bool
    let mode: String
    let guaranteedOnDevice: Bool
    let languagePack: String
    let language: String
    let tier: String
    let reason: String?
    let maxDurationMs: Int?
}

/// Outcome of a `start()` attempt.
enum StartOutcome {
    case started(mode: String, guaranteedOnDevice: Bool, tier: String, language: String, maxDurationMs: Int?)
    case rejected(code: String, message: String)
}

/// Callbacks raised during a session; `SpeechPlugin` forwards them to JS listeners.
protocol RecognitionEventSink: AnyObject {
    func onPartial(transcript: String, mode: String, guaranteedOnDevice: Bool)
    func onFinal(alternatives: [String], mode: String, guaranteedOnDevice: Bool)
    func onError(code: String, message: String, recoverable: Bool)
    func onEnd(reason: String)
}

/// Everything this plugin knows about `SFSpeechRecognizer`, kept free of any Capacitor type
/// so the plugin class is a thin translation layer (mirroring the Android split between
/// `SpeechPlugin.kt` and `SpeechRecognitionController.kt`).
///
/// Four Apple-documented constraints shape this file:
///
/// 1. **`requiresOnDeviceRecognition` is only honored when `supportsOnDeviceRecognition` is
///    true**, and that property varies by device *and* locale — not merely by OS version.
///    So it is checked at runtime, per recognizer, and the answer is what drives
///    `guaranteedOnDevice`. Setting the flag without checking would produce a silent
///    server round-trip, which is exactly the failure this plugin exists to prevent.
/// 2. **Authorization is two separate grants.** `SFSpeechRecognizer.requestAuthorization`
///    is additional to the `AVAudioSession` record permission; having one says nothing
///    about the other.
/// 3. **A recognition task is capped at roughly one minute.** Rather than let a long
///    dictation truncate silently, the session is stopped deliberately at
///    ``Self.maxSessionDurationMs`` and ends with the `max-duration` reason, and that cap
///    is reported up front in the capability and start results.
/// 4. **The audio session is shared with TTS.** This controller configures `.record` only
///    while listening and deactivates afterwards, and the synthesizer is deliberately kept
///    off the application audio session (see `SpeechSynthesisController`), so a
///    talk-then-listen loop does not have the two fighting over it.
///
/// > Warning: none of this Swift has been compiled or run — see this package's README.
final class SpeechRecognitionController: NSObject {
    /// Apple documents a roughly one-minute limit per `SFSpeechRecognitionTask`. Stop a
    /// little early so the session ends on our terms with a clear reason, rather than
    /// being cut off mid-word by the framework.
    static let maxSessionDurationMs = 55_000

    private weak var sink: RecognitionEventSink?

    private let audioEngine = AVAudioEngine()
    private var recognizer: SFSpeechRecognizer?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var durationTimer: DispatchWorkItem?

    private var sessionMode = "unavailable"
    private var sessionGuaranteed = false
    private var listening = false
    /// True between an explicit stop/cancel and the task actually finishing.
    private var closing = false

    init(sink: RecognitionEventSink) {
        self.sink = sink
        super.init()
    }

    var isListening: Bool { listening }

    // MARK: - Permissions

    /// Speech-recognition authorization as a Capacitor `PermissionState` string.
    static func recognitionPermissionState() -> String {
        switch SFSpeechRecognizer.authorizationStatus() {
        case .authorized: return "granted"
        case .denied, .restricted: return "denied"
        case .notDetermined: return "prompt"
        @unknown default: return "prompt"
        }
    }

    /// Microphone authorization as a Capacitor `PermissionState` string.
    static func microphonePermissionState() -> String {
        switch AVAudioSession.sharedInstance().recordPermission {
        case .granted: return "granted"
        case .denied: return "denied"
        case .undetermined: return "prompt"
        @unknown default: return "prompt"
        }
    }

    /// Requests whichever grants are still undetermined. Both are needed to listen; asking
    /// for only one produces a session that fails at a confusing point later.
    ///
    /// - Important: requesting speech authorization without `NSSpeechRecognitionUsageDescription`
    ///   in the app's `Info.plist` crashes the app, per Apple. The key is added in
    ///   `frontend/apps/mobile/ios/App/App/Info.plist`.
    static func requestAuthorizations(microphone: Bool, recognition: Bool, completion: @escaping () -> Void) {
        let group = DispatchGroup()

        if recognition {
            group.enter()
            SFSpeechRecognizer.requestAuthorization { _ in group.leave() }
        }
        if microphone {
            group.enter()
            // Deprecated in iOS 17 in favour of AVAudioApplication.requestRecordPermission,
            // but this target deploys to iOS 15, where that type does not exist.
            AVAudioSession.sharedInstance().requestRecordPermission { _ in group.leave() }
        }

        group.notify(queue: .main) { completion() }
    }

    // MARK: - Capability

    /// Pure probe. Creates a recognizer for the locale and reports what it can actually
    /// promise; opens no microphone and prompts for nothing.
    func capability(languageTag: String?) -> RecognitionCapability {
        let tag = languageTag ?? Locale.current.identifier
        let locale = Locale(identifier: tag)

        guard let recognizer = SFSpeechRecognizer(locale: locale) else {
            return RecognitionCapability(
                available: false,
                mode: "unavailable",
                guaranteedOnDevice: false,
                languagePack: "unsupported",
                language: tag,
                tier: "none",
                reason: "Speech recognition is not supported for \(tag) on this device.",
                maxDurationMs: nil
            )
        }

        guard recognizer.isAvailable else {
            return RecognitionCapability(
                available: false,
                mode: "unavailable",
                guaranteedOnDevice: false,
                languagePack: "unknown",
                language: tag,
                tier: "none",
                reason: "The speech recognizer is temporarily unavailable.",
                maxDurationMs: nil
            )
        }

        // The whole on-device story on iOS hangs on this one runtime property. Apple is
        // explicit that a request only honors requiresOnDeviceRecognition when it is true,
        // and that it varies by device and locale.
        let onDevice = recognizer.supportsOnDeviceRecognition

        return RecognitionCapability(
            available: true,
            mode: onDevice ? "on-device" : "network",
            guaranteedOnDevice: onDevice,
            // iOS exposes no language-pack inventory or download API. `installed` here means
            // "on-device recognition works for this locale right now", which is the only
            // thing the platform actually tells us.
            languagePack: onDevice ? "installed" : "unknown",
            language: tag,
            tier: onDevice ? "ios-on-device" : "ios-server",
            reason: onDevice
                ? nil
                : "This device does not support on-device recognition for \(tag); recognition would use Apple's servers.",
            maxDurationMs: Self.maxSessionDurationMs
        )
    }

    /// Locales `SFSpeechRecognizer` supports at all. Says nothing about which are on-device
    /// — iOS has no per-locale inventory — so the caller reports `enumerable: false`.
    func supportedLanguageTags() -> [String] {
        SFSpeechRecognizer.supportedLocales().map { $0.identifier }.sorted()
    }

    // MARK: - Session

    // swiftlint:disable:next function_body_length
    func start(languageTag: String?, partialResults: Bool, onDevicePolicy: String) -> StartOutcome {
        if listening {
            return .rejected(code: "busy", message: "A recognition session is already running.")
        }
        guard SFSpeechRecognizer.authorizationStatus() == .authorized else {
            return .rejected(code: "permission-denied", message: "Speech recognition permission has not been granted.")
        }
        guard AVAudioSession.sharedInstance().recordPermission == .granted else {
            return .rejected(code: "permission-denied", message: "Microphone permission has not been granted.")
        }

        let tag = languageTag ?? Locale.current.identifier
        guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: tag)), recognizer.isAvailable else {
            return .rejected(code: "not-supported", message: "Speech recognition is not available for \(tag).")
        }

        let onDevice = recognizer.supportsOnDeviceRecognition
        if !onDevice && onDevicePolicy != "allow" {
            // Unlike Android there is no middle "best-effort" rung here: iOS either honors
            // requiresOnDeviceRecognition or sends the audio to Apple. 'prefer' therefore
            // behaves exactly like 'require' rather than quietly degrading to the network.
            return .rejected(
                code: "on-device-unavailable",
                message: "This device cannot recognize \(tag) on-device. Pass onDevicePolicy: 'allow' to use Apple's servers."
            )
        }

        let audioRequest = SFSpeechAudioBufferRecognitionRequest()
        audioRequest.shouldReportPartialResults = partialResults
        audioRequest.requiresOnDeviceRecognition = onDevice

        do {
            let session = AVAudioSession.sharedInstance()
            // .record (not .playAndRecord) because the synthesizer keeps its own session —
            // see SpeechSynthesisController. `.duckOthers` is the *preference*: it avoids a
            // full interruption so a talk-then-listen loop does not tear down other audio.
            //
            // It is only a preference because Apple documents `.duckOthers` as usable ONLY
            // with `.playAndRecord`, `.playback`, and `.multiRoute` — pairing it with
            // `.record` may be rejected as an illegal argument, and `setCategory` throwing
            // here would make `startListening` fail *every single time*, taking the whole
            // STT feature with it. The iOS 27 Simulator accepts the combination (measured),
            // but the Simulator's AVAudioSession is a partial stub and its permissiveness is
            // not evidence about real hardware. So: ask for ducking, and if the system
            // refuses, listen without it rather than not listening at all. Ducking is a
            // nicety; recognition is the product.
            //
            // TODO(speech): on a real device, check whether the duck attempt throws. If it
            // does, decide deliberately between plain `.record` (what the fallback gives you)
            // and `.playAndRecord` + `.duckOthers` (ducking back, at the cost of the
            // separate-session split this file relies on).
            do {
                try session.setCategory(.record, mode: .measurement, options: [.duckOthers])
            } catch {
                try session.setCategory(.record, mode: .measurement, options: [])
            }
            try session.setActive(true, options: .notifyOthersOnDeactivation)
        } catch {
            return .rejected(code: "audio", message: "Could not configure the audio session: \(error.localizedDescription)")
        }

        let input = audioEngine.inputNode
        let format = input.outputFormat(forBus: 0)
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
            audioRequest.append(buffer)
        }

        audioEngine.prepare()
        do {
            try audioEngine.start()
        } catch {
            input.removeTap(onBus: 0)
            deactivateSession()
            return .rejected(code: "audio", message: "Could not start audio capture: \(error.localizedDescription)")
        }

        self.recognizer = recognizer
        self.request = audioRequest
        sessionMode = onDevice ? "on-device" : "network"
        sessionGuaranteed = onDevice
        listening = true
        closing = false

        task = recognizer.recognitionTask(with: audioRequest) { [weak self] result, error in
            guard let self = self else { return }

            if let result {
                let alternatives = result.transcriptions.map { $0.formattedString }
                if result.isFinal {
                    self.finish(reason: self.closing ? "stopped" : "final-result", emit: {
                        self.sink?.onFinal(
                            alternatives: alternatives.isEmpty ? [result.bestTranscription.formattedString] : alternatives,
                            mode: self.sessionMode,
                            guaranteedOnDevice: self.sessionGuaranteed
                        )
                    })
                } else {
                    self.sink?.onPartial(
                        transcript: result.bestTranscription.formattedString,
                        mode: self.sessionMode,
                        guaranteedOnDevice: self.sessionGuaranteed
                    )
                }
                return
            }

            if let error {
                // A cancel() we asked for surfaces here as an error too; do not report it
                // as a failure the user should see.
                if self.closing {
                    self.finish(reason: "cancelled", emit: nil)
                    return
                }
                self.finish(reason: "error", emit: {
                    self.sink?.onError(
                        code: "client",
                        message: error.localizedDescription,
                        recoverable: true
                    )
                })
            }
        }

        scheduleDurationCap()

        return .started(
            mode: sessionMode,
            guaranteedOnDevice: sessionGuaranteed,
            tier: onDevice ? "ios-on-device" : "ios-server",
            language: tag,
            maxDurationMs: Self.maxSessionDurationMs
        )
    }

    /// Stop capturing but let the recognizer finalize — a final result still follows.
    func stop() {
        guard listening else { return }
        closing = true
        audioEngine.inputNode.removeTap(onBus: 0)
        audioEngine.stop()
        request?.endAudio()
    }

    /// Abandon the session with no final result.
    func cancel() {
        guard listening else { return }
        closing = true
        task?.cancel()
        finish(reason: "cancelled", emit: nil)
    }

    /// Release audio resources on plugin teardown. Safe when nothing is running.
    func teardown() {
        cancel()
    }

    // MARK: - Internals

    /// Ends the session exactly once, tears down audio, then emits (in that order, so a
    /// listener that immediately starts a new session finds this one fully released).
    private func finish(reason: String, emit: (() -> Void)?) {
        guard listening else { return }
        listening = false

        durationTimer?.cancel()
        durationTimer = nil

        audioEngine.inputNode.removeTap(onBus: 0)
        if audioEngine.isRunning {
            audioEngine.stop()
        }
        request?.endAudio()
        request = nil
        task = nil
        recognizer = nil
        deactivateSession()

        emit?()
        sink?.onEnd(reason: reason)
    }

    private func deactivateSession() {
        do {
            try AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        } catch {
            // Best effort: another audio client may still hold the session.
        }
    }

    /// Ends the session at the documented one-minute ceiling with an explicit reason,
    /// instead of letting a long dictation be truncated without the caller knowing.
    private func scheduleDurationCap() {
        let work = DispatchWorkItem { [weak self] in
            guard let self = self, self.listening else { return }
            self.closing = true
            self.audioEngine.inputNode.removeTap(onBus: 0)
            self.audioEngine.stop()
            self.request?.endAudio()
            self.finish(reason: "max-duration", emit: {
                self.sink?.onError(
                    code: "max-duration",
                    message: "iOS limits a single recognition task to about one minute; the session was ended. Start another to continue.",
                    recoverable: true
                )
            })
        }
        durationTimer = work
        DispatchQueue.main.asyncAfter(
            deadline: .now() + .milliseconds(Self.maxSessionDurationMs),
            execute: work
        )
    }
}
