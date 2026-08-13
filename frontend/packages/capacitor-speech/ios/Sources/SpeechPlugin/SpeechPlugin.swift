import AVFoundation
import Capacitor
import Foundation
import Speech

/// iOS native half of the offline speech plugin. See `src/definitions.ts` for the JS-facing
/// contract and this package's `README.md` for the design — in particular why every
/// response carries `guaranteedOnDevice`.
///
/// Registered with `jsName = "Speech"` — this MUST match the string passed to
/// `registerPlugin<SpeechPlugin>('Speech', …)` in `src/index.ts` and the Android side's
/// `@CapacitorPlugin(name = "Speech")`, or the JS bridge will not find this implementation.
/// `identifier` is this class's own name, following `@capacitor/app`'s convention.
///
/// This class only translates between `CAPPluginCall` and the two controllers; all speech
/// logic lives in `SpeechRecognitionController` / `SpeechSynthesisController`, mirroring
/// the Android split.
///
/// > Warning: none of this Swift has been compiled or run. See this package's README for
/// > the full unverified list.
@objc(SpeechPlugin)
public class SpeechPlugin: CAPPlugin, CAPBridgedPlugin, RecognitionEventSink {
    public let identifier = "SpeechPlugin"
    public let jsName = "Speech"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "checkPermissions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestPermissions", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getRecognitionCapability", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getRecognitionLanguages", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "downloadRecognitionLanguage", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startListening", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopListening", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancelListening", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "isListening", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getSynthesisCapability", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getVoices", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getSynthesisLanguages", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "installSynthesisLanguage", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "speak", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopSpeaking", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "isSpeaking", returnType: CAPPluginReturnPromise)
    ]

    /// Both are stored properties on purpose: `AVSpeechSynthesizer` is not retained by the
    /// system (speech cuts out if it is a local), and the recognition controller owns a
    /// live `AVAudioEngine` tap.
    private lazy var recognition = SpeechRecognitionController(sink: self)
    private lazy var synthesis = SpeechSynthesisController()

    public override func load() {
        // Touch both so the lazy properties are created on the main thread at load time
        // rather than on whichever queue the first call arrives on.
        _ = recognition
        _ = synthesis
    }

    deinit {
        recognition.teardown()
        synthesis.teardown()
    }

    // MARK: - Permissions

    /// `override public`, not a bare `@objc func`: `CAPPlugin` is an Objective-C class that
    /// already declares `-checkPermissions:` / `-requestPermissions:` (CAPPlugin.h), so these
    /// are overrides — and because the base declarations import as `open` on a `public`
    /// class, an override has to be `public` too. Same shape as
    /// `@capacitor/local-notifications`' plugin.
    @objc override public func checkPermissions(_ call: CAPPluginCall) {
        call.resolve([
            "microphone": SpeechRecognitionController.microphonePermissionState(),
            "speechRecognition": SpeechRecognitionController.recognitionPermissionState()
        ])
    }

    /// Requests both grants unless a subset is named. Speech recognition on iOS needs the
    /// `SFSpeechRecognizer` authorization *in addition to* the microphone one, so asking
    /// for only one leaves the caller with a session that fails later for a reason the user
    /// was never shown a prompt about.
    @objc override public func requestPermissions(_ call: CAPPluginCall) {
        let requested = call.getArray("permissions", String.self) ?? ["microphone", "speechRecognition"]

        SpeechRecognitionController.requestAuthorizations(
            microphone: requested.contains("microphone"),
            recognition: requested.contains("speechRecognition")
        ) {
            call.resolve([
                "microphone": SpeechRecognitionController.microphonePermissionState(),
                "speechRecognition": SpeechRecognitionController.recognitionPermissionState()
            ])
        }
    }

    // MARK: - Recognition

    @objc func getRecognitionCapability(_ call: CAPPluginCall) {
        let capability = recognition.capability(languageTag: call.getString("language"))
        var result: [String: Any] = [
            "available": capability.available,
            "mode": capability.mode,
            "guaranteedOnDevice": capability.guaranteedOnDevice,
            "languagePack": capability.languagePack,
            "language": capability.language,
            "tier": capability.tier
        ]
        if let reason = capability.reason { result["reason"] = reason }
        if let maxDurationMs = capability.maxDurationMs { result["maxDurationMs"] = maxDurationMs }
        call.resolve(result)
    }

    /// iOS exposes supported *locales* but no on-device model inventory, so this reports
    /// `enumerable: false` and an empty list rather than implying the entries it could
    /// return say anything about offline availability.
    @objc func getRecognitionLanguages(_ call: CAPPluginCall) {
        call.resolve([
            "languages": [],
            "enumerable": false
        ])
    }

    @objc func downloadRecognitionLanguage(_ call: CAPPluginCall) {
        call.resolve([
            "started": false,
            "languagePack": "unknown",
            "reason": "iOS provides no API to download speech recognition language models; they follow the system language settings."
        ])
    }

    @objc func startListening(_ call: CAPPluginCall) {
        let language = call.getString("language")
        let partialResults = call.getBool("partialResults") ?? true
        let policy = call.getString("onDevicePolicy") ?? "require"

        guard ["require", "prefer", "allow"].contains(policy) else {
            call.reject("onDevicePolicy must be one of: require, prefer, allow")
            return
        }

        // AVAudioEngine and SFSpeechRecognizer both expect to be driven from the main queue.
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            switch self.recognition.start(languageTag: language, partialResults: partialResults, onDevicePolicy: policy) {
            case let .rejected(code, message):
                call.reject(message, code)
            case let .started(mode, guaranteedOnDevice, tier, language, maxDurationMs):
                var result: [String: Any] = [
                    "mode": mode,
                    "guaranteedOnDevice": guaranteedOnDevice,
                    "tier": tier,
                    "language": language
                ]
                if let maxDurationMs = maxDurationMs { result["maxDurationMs"] = maxDurationMs }
                call.resolve(result)
            }
        }
    }

    @objc func stopListening(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            self?.recognition.stop()
            call.resolve()
        }
    }

    @objc func cancelListening(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            self?.recognition.cancel()
            call.resolve()
        }
    }

    @objc func isListening(_ call: CAPPluginCall) {
        call.resolve(["listening": recognition.isListening])
    }

    // MARK: - Synthesis

    @objc func getSynthesisCapability(_ call: CAPPluginCall) {
        let capability = synthesis.capability(languageTag: call.getString("language"))
        var result: [String: Any] = [
            "available": capability.available,
            "offlineVoiceAvailable": capability.offlineVoiceAvailable,
            "languageStatus": capability.languageStatus,
            "language": capability.language
        ]
        if let engine = capability.engine { result["engine"] = engine }
        if let reason = capability.reason { result["reason"] = reason }
        call.resolve(result)
    }

    @objc func getVoices(_ call: CAPPluginCall) {
        let voices = synthesis.voices(languageTag: call.getString("language")).map { voice -> [String: Any] in
            var entry: [String: Any] = [
                "id": voice.id,
                "name": voice.name,
                "language": voice.language,
                "offline": voice.offline
            ]
            if let quality = voice.quality { entry["quality"] = quality }
            return entry
        }
        call.resolve(["voices": voices])
    }

    @objc func getSynthesisLanguages(_ call: CAPPluginCall) {
        call.resolve([
            "languages": synthesis.languages().map { ["tag": $0.tag, "status": $0.status] }
        ])
    }

    @objc func installSynthesisLanguage(_ call: CAPPluginCall) {
        call.resolve([
            "started": false,
            "reason": "iOS installs voices through Settings > Accessibility > Spoken Content; apps cannot launch an installer."
        ])
    }

    @objc func speak(_ call: CAPPluginCall) {
        guard let text = call.getString("text") else {
            call.reject("text is required")
            return
        }

        let request = SpeakRequest(
            text: text,
            language: call.getString("language"),
            voiceId: call.getString("voiceId"),
            rate: call.getFloat("rate"),
            pitch: call.getFloat("pitch"),
            interrupt: call.getBool("interrupt") ?? true
            // `requireOfflineVoice` is deliberately not read: iOS publishes no per-voice
            // network flag, so honoring it would mean inventing a guarantee. See
            // SpeakOptions.requireOfflineVoice in src/definitions.ts.
        )

        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            self.synthesis.speak(
                request,
                completion: { outcome in
                    var result: [String: Any] = [
                        "completed": outcome.completed,
                        "interrupted": outcome.interrupted,
                        "offlineVoice": outcome.offlineVoice,
                        "chunkCount": outcome.chunkCount
                    ]
                    if let voiceId = outcome.voiceId { result["voiceId"] = voiceId }
                    call.resolve(result)
                },
                onFailure: { message in call.reject(message) }
            )
        }
    }

    @objc func stopSpeaking(_ call: CAPPluginCall) {
        DispatchQueue.main.async { [weak self] in
            self?.synthesis.stop()
            call.resolve()
        }
    }

    @objc func isSpeaking(_ call: CAPPluginCall) {
        call.resolve(["speaking": synthesis.isSpeaking])
    }

    // MARK: - RecognitionEventSink

    public func onPartial(transcript: String, mode: String, guaranteedOnDevice: Bool) {
        notifyListeners("speechPartialResult", data: [
            "transcript": transcript,
            // Repeated on every event so a long session cannot drift away from the truth
            // about where the audio is being processed.
            "mode": mode,
            "guaranteedOnDevice": guaranteedOnDevice
        ])
    }

    public func onFinal(alternatives: [String], mode: String, guaranteedOnDevice: Bool) {
        notifyListeners("speechResult", data: [
            "transcript": alternatives.first ?? "",
            "alternatives": alternatives,
            "mode": mode,
            "guaranteedOnDevice": guaranteedOnDevice
        ])
    }

    public func onError(code: String, message: String, recoverable: Bool) {
        notifyListeners("speechError", data: [
            "code": code,
            "message": message,
            "recoverable": recoverable
        ])
    }

    public func onEnd(reason: String) {
        notifyListeners("speechEnd", data: ["reason": reason])
    }
}
