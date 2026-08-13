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

    /// Monotonic session id, bumped when a session starts and again when it ends.
    ///
    /// `SFSpeechRecognitionTask`'s result handler keeps firing after `cancel()` — the
    /// cancellation itself is delivered *as* a late callback — and the closure has no way to
    /// tell which session it belongs to. Without this, a straggler from a cancelled task
    /// calls `finish()` and tears down the session that has since replaced it, so a
    /// stop-then-immediately-start sequence kills its own successor. Every callback captures
    /// the generation it was created for and is dropped unless it still matches.
    private var generation: UInt64 = 0

    /// Audio-disruption observers, live only for the duration of a session.
    private var observers: [NSObjectProtocol] = []

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
        let tag = Self.normalizedLanguageTag(languageTag ?? Locale.current.identifier)
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
    ///
    /// Deduplicated because canonicalizing to BCP-47 can collapse two ICU identifiers onto
    /// one tag.
    func supportedLanguageTags() -> [String] {
        Set(SFSpeechRecognizer.supportedLocales().map { Self.normalizedLanguageTag($0.identifier) }).sorted()
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

        let tag = Self.normalizedLanguageTag(languageTag ?? Locale.current.identifier)
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
            // `.record`, not `.playAndRecord`, because the synthesizer keeps its own session
            // (see SpeechSynthesisController) — and, as measured below, `.record` gets the
            // ducking anyway, so widening the category would buy nothing and cost the
            // separate-session split.
            //
            // Apple documents `.duckOthers` as usable ONLY with `.playAndRecord`,
            // `.playback` and `.multiRoute`, which made pairing it with `.record` look like
            // an illegal argument that would throw on every single `startListening` and take
            // the whole STT feature with it. Measured rather than assumed, on an iPhone 17
            // Pro Max running iOS 27.0:
            //
            //     .record + .duckOthers        -> accepted, activated, categoryOptions == 3
            //     .record (no options)         -> accepted, activated, categoryOptions == 0
            //     .playAndRecord + .duckOthers -> accepted, activated, categoryOptions == 3
            //
            // So the duck attempt does not throw, the fallback never fires on this OS, and
            // the resulting options are `mixWithOthers | duckOthers` (3) — iOS implies the
            // former from the latter. Decision: keep `.record` + `.duckOthers`.
            //
            // The fallback stays anyway. It is insurance for the OS versions this was *not*
            // measured on: the deployment target is iOS 15, only iOS 27 was tested, and the
            // pairing is still undocumented, so a future release is free to start rejecting
            // it. Ducking is a nicety; recognition is the product.
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

        // `installTap` does not fail politely on a degenerate format: a 0-channel or
        // 0 Hz format trips an assertion inside AVAudioEngine and **aborts the process**.
        // The input node reports exactly that when the microphone is not actually ours —
        // another app holding it, or a route change landing between `setActive` above and
        // this line. Validate first and reject, so a hostile audio environment costs the
        // user a legible error instead of a crash.
        guard format.channelCount > 0, format.sampleRate > 0 else {
            deactivateSession()
            return .rejected(
                code: "audio",
                message: "The microphone reported an unusable input format "
                    + "(\(format.channelCount) channels at \(format.sampleRate) Hz). Another app may be using "
                    + "the microphone, or the audio route changed while starting."
            )
        }

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
        generation &+= 1
        let sessionId = generation

        observeAudioDisruptions()

        task = recognizer.recognitionTask(with: audioRequest) { [weak self] result, error in
            // The result handler runs on a private queue, but everything it touches is
            // main-confined — the same rule Android states with `@MainThread`. Hop first,
            // then drop the callback unless it still belongs to the running session.
            DispatchQueue.main.async {
                guard let self = self, self.generation == sessionId else { return }
                self.handle(result: result, error: error)
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

    /// Routes one recognizer callback. Only ever called on the main thread, and only for a
    /// session that is still the current one.
    private func handle(result: SFSpeechRecognitionResult?, error: Error?) {
        if let result {
            let alternatives = result.transcriptions.map { $0.formattedString }
            if result.isFinal {
                finish(reason: closing ? "stopped" : "final-result", emit: {
                    self.sink?.onFinal(
                        alternatives: alternatives.isEmpty ? [result.bestTranscription.formattedString] : alternatives,
                        mode: self.sessionMode,
                        guaranteedOnDevice: self.sessionGuaranteed
                    )
                })
            } else {
                sink?.onPartial(
                    transcript: result.bestTranscription.formattedString,
                    mode: sessionMode,
                    guaranteedOnDevice: sessionGuaranteed
                )
            }
            return
        }

        guard let error else { return }

        // Report the failure even while `closing`. This branch used to drop every error the
        // moment a stop was in flight and end the session as "cancelled" — so a recognizer
        // that failed *after* the caller asked it to stop produced no result, no error, and
        // an end reason that was not true. A real `cancel()` cannot reach here: it finishes
        // the session synchronously, which retires the generation this callback carries.
        // Android reports unconditionally too (`SessionListener.onError`).
        finish(reason: "error", emit: {
            self.sink?.onError(
                code: (error as NSError).domain == NSURLErrorDomain ? "network" : "client",
                message: error.localizedDescription,
                recoverable: true
            )
        })
    }

    /// Ends the session exactly once, tears down audio, then emits (in that order, so a
    /// listener that immediately starts a new session finds this one fully released).
    private func finish(reason: String, emit: (() -> Void)?) {
        guard listening else { return }
        listening = false

        // Retire this session's id before tearing anything down. `task.cancel()` and
        // `endAudio()` below both provoke further callbacks; bumping first is what makes
        // them stale rather than letting them re-enter and end the *next* session.
        generation &+= 1

        removeAudioObservers()
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

    /// Watch the two ways iOS takes the microphone away mid-session without anything
    /// throwing. Without these, a call, a Siri invocation or a route change leaves the
    /// session nominally "listening" against a dead tap: no audio, no result, no error, and
    /// no end event — the caller waits forever.
    ///
    /// There is no Android counterpart to mirror (its `SpeechRecognizer` owns the audio and
    /// reports `ERROR_AUDIO` itself), so the *reporting* follows Android's shape: a
    /// recoverable `audio` error, then `onEnd("error")`.
    ///
    /// Both are registered with `object: nil` rather than filtered on the engine and the
    /// shared session. Apple does not document the sender of either notification, and a
    /// filter that guesses wrong does not fail loudly — it silently never fires, which is
    /// indistinguishable from the bug this code exists to fix. This controller owns exactly
    /// one engine and there is only one shared audio session, so there is nothing else these
    /// could be about.
    private func observeAudioDisruptions() {
        let center = NotificationCenter.default

        // Sample-rate or channel-count changes, a headset arriving or leaving. AVAudioEngine
        // stops itself and the installed tap stops delivering buffers.
        observers.append(
            center.addObserver(
                forName: .AVAudioEngineConfigurationChange,
                object: nil,
                queue: .main
            ) { [weak self] _ in
                self?.endBecauseAudioStopped(
                    message: "The audio route changed and recording stopped. Start listening again to continue."
                )
            }
        )

        // A phone call, Siri, or another app taking the session.
        observers.append(
            center.addObserver(
                forName: AVAudioSession.interruptionNotification,
                object: nil,
                queue: .main
            ) { [weak self] note in
                guard
                    let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                    let type = AVAudioSession.InterruptionType(rawValue: raw),
                    type == .began
                else {
                    // `.ended` is deliberately not auto-resumed: by the time it arrives this
                    // session has been torn down and its recognition task is gone. Starting
                    // a fresh one is the caller's decision — reopening the microphone behind
                    // their back is exactly what this plugin exists not to do.
                    return
                }
                self?.endBecauseAudioStopped(
                    message: "Recording was interrupted (a call, Siri, or another app took the microphone)."
                )
            }
        )
    }

    private func removeAudioObservers() {
        observers.forEach { NotificationCenter.default.removeObserver($0) }
        observers.removeAll()
    }

    /// End a session whose microphone has gone silent, telling the caller why.
    private func endBecauseAudioStopped(message: String) {
        guard listening else { return }
        closing = true
        finish(reason: "error", emit: {
            self.sink?.onError(code: "audio", message: message, recoverable: true)
        })
    }

    /// ICU identifier (`en_US`, sometimes carrying `@keyword=` suffixes) → BCP-47 tag
    /// (`en-US`). Every `language` field in `src/definitions.ts` is documented as BCP-47,
    /// and Android already satisfies that via `Locale.toLanguageTag()`; iOS was reporting
    /// `Locale.identifier` raw, so the same device answered `en_US` on one platform and
    /// `en-US` on the other.
    ///
    /// `canonicalLanguageIdentifier` rather than a `_` → `-` substitution, because it also
    /// drops the keyword suffixes an ICU identifier can carry.
    static func normalizedLanguageTag(_ identifier: String) -> String {
        let canonical = Locale.canonicalLanguageIdentifier(from: identifier)
        return canonical.isEmpty ? identifier.replacingOccurrences(of: "_", with: "-") : canonical
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
