import AVFoundation
import Foundation

/// Capability answer for synthesis. Mirrors `SpeechSynthesisCapability`.
struct SynthesisCapability {
    let available: Bool
    let offlineVoiceAvailable: Bool
    let languageStatus: String
    let language: String
    let engine: String?
    let reason: String?
}

/// One installed voice. Mirrors `SpeechVoice`.
struct SynthesisVoice {
    let id: String
    let name: String
    let language: String
    let offline: Bool
    let quality: String?
}

/// Everything one `speak()` call needs. Mirrors `SpeakOptions`.
struct SpeakRequest {
    let text: String
    let language: String?
    let voiceId: String?
    let rate: Float?
    let pitch: Float?
    let interrupt: Bool
}

/// How one `speak()` call ended. Mirrors `SpeakResult`.
struct SpeakOutcome {
    let completed: Bool
    let interrupted: Bool
    let voiceId: String?
    let offlineVoice: Bool
    let chunkCount: Int
}

/// Everything this plugin knows about `AVSpeechSynthesizer`.
///
/// Two Apple-documented constraints shape this file:
///
/// 1. **The system does not retain the synthesizer.** A synthesizer created as a local
///    inside a `speak` method is deallocated the moment that method returns and the speech
///    cuts out partway through. It is therefore held as a stored property here, and this
///    controller is itself held by the plugin instance.
/// 2. **`usesApplicationAudioSession` decides who owns the audio session.** It defaults to
///    `true`, meaning the synthesizer configures *the app's* session — which this app also
///    uses to record (`SpeechRecognitionController`, plus the in-WebView capture). Leaving
///    it true makes TTS and the microphone fight over category/activation, and a
///    talk-then-listen loop is exactly the case that exposes it. It is set to `false` so
///    the synthesizer manages its own session and leaves ours alone.
///
/// Unlike Android, iOS publishes no per-voice "requires network" flag, so `offline` is
/// always false here and means *unknown*, never *requires network*. See
/// `SpeechVoice.offline` in `src/definitions.ts`.
///
/// > Warning: none of this Swift has been compiled or run — see this package's README.
final class SpeechSynthesisController: NSObject, AVSpeechSynthesizerDelegate {
    /// Held as a property, not created per call — see this type's documentation.
    private let synthesizer = AVSpeechSynthesizer()

    /// Keyed by the `AVSpeechUtterance` that will settle it. iOS has no per-utterance id,
    /// so the object identity is the key.
    private var pending: [ObjectIdentifier: (SpeakOutcome) -> Void] = [:]
    private var pendingVoice: [ObjectIdentifier: String?] = [:]

    override init() {
        super.init()
        synthesizer.delegate = self
        // See this type's documentation: keeps TTS off the recording session.
        synthesizer.usesApplicationAudioSession = false
    }

    func capability(languageTag: String?) -> SynthesisCapability {
        let voices = AVSpeechSynthesisVoice.speechVoices()
        let tag = languageTag ?? AVSpeechSynthesisVoice.currentLanguageCode()

        guard !voices.isEmpty else {
            return SynthesisCapability(
                available: false,
                offlineVoiceAvailable: false,
                languageStatus: "unknown",
                language: tag,
                engine: nil,
                reason: "No speech synthesis voices are installed on this device."
            )
        }

        let matches = voices.contains { Self.matchesTag($0.language, tag) }

        return SynthesisCapability(
            available: true,
            // Deliberately false: Apple documents no per-voice offline guarantee, and this
            // field must not claim one. See this type's documentation.
            offlineVoiceAvailable: false,
            languageStatus: matches ? "available" : "not-supported",
            language: tag,
            engine: "AVSpeechSynthesizer",
            reason: matches ? nil : "No installed voice speaks \(tag)."
        )
    }

    func voices(languageTag: String?) -> [SynthesisVoice] {
        AVSpeechSynthesisVoice.speechVoices()
            .filter { languageTag == nil || Self.matchesTag($0.language, languageTag!) }
            .map { voice in
                SynthesisVoice(
                    id: voice.identifier,
                    name: voice.name,
                    language: voice.language,
                    offline: false,
                    quality: Self.qualityLabel(voice.quality)
                )
            }
    }

    func languages() -> [(tag: String, status: String)] {
        let tags = Set(AVSpeechSynthesisVoice.speechVoices().map { $0.language })
        return tags.sorted().map { (tag: $0, status: "available") }
    }

    var isSpeaking: Bool { synthesizer.isSpeaking }

    func stop() {
        synthesizer.stopSpeaking(at: .immediate)
        // stopSpeaking fires didCancel for the utterance actually speaking, but anything
        // still queued is dropped silently — sweep so no promise is stranded.
        settleAll(interrupted: true)
    }

    /// Speak `request`, settling `completion` when the utterance finishes or is cut short.
    /// `onFailure` fires only for conditions that never produce audio at all.
    func speak(
        _ request: SpeakRequest,
        completion: @escaping (SpeakOutcome) -> Void,
        onFailure: @escaping (String) -> Void
    ) {
        guard !request.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            onFailure("text is required")
            return
        }

        let voice: AVSpeechSynthesisVoice?
        if let voiceId = request.voiceId {
            guard let match = AVSpeechSynthesisVoice.speechVoices().first(where: { $0.identifier == voiceId }) else {
                onFailure("Unknown voiceId: \(voiceId)")
                return
            }
            voice = match
        } else if let tag = request.language {
            guard let match = AVSpeechSynthesisVoice(language: tag) else {
                onFailure("No installed voice speaks \(tag).")
                return
            }
            voice = match
        } else {
            voice = nil
        }

        if request.interrupt && synthesizer.isSpeaking {
            synthesizer.stopSpeaking(at: .immediate)
            settleAll(interrupted: true)
        }

        let utterance = AVSpeechUtterance(string: request.text)
        utterance.voice = voice
        if let rate = request.rate {
            // The cross-platform contract is "1.0 = normal", but AVSpeechUtterance's scale
            // runs from Min to Max with a Default in the middle, so scale rather than assign.
            utterance.rate = min(
                max(AVSpeechUtteranceDefaultSpeechRate * rate, AVSpeechUtteranceMinimumSpeechRate),
                AVSpeechUtteranceMaximumSpeechRate
            )
        }
        if let pitch = request.pitch {
            // Documented range 0.5–2.0.
            utterance.pitchMultiplier = min(max(pitch, 0.5), 2.0)
        }

        let key = ObjectIdentifier(utterance)
        pending[key] = completion
        pendingVoice[key] = voice?.identifier

        // AVSpeechSynthesizer has no input-length cap comparable to Android's
        // getMaxSpeechInputLength(), so the text is spoken as one utterance and chunkCount
        // is always 1 here. Android chunks; see SpeechSynthesisController.chunkText there.
        synthesizer.speak(utterance)
    }

    /// Release the delegate link and settle anything outstanding.
    func teardown() {
        synthesizer.stopSpeaking(at: .immediate)
        settleAll(interrupted: true)
        synthesizer.delegate = nil
    }

    // MARK: - AVSpeechSynthesizerDelegate

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        settle(utterance, completed: true, interrupted: false)
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        settle(utterance, completed: false, interrupted: true)
    }

    // MARK: - Internals

    private func settle(_ utterance: AVSpeechUtterance, completed: Bool, interrupted: Bool) {
        let key = ObjectIdentifier(utterance)
        guard let completion = pending.removeValue(forKey: key) else { return }
        let voiceId = pendingVoice.removeValue(forKey: key) ?? nil

        completion(
            SpeakOutcome(
                completed: completed,
                interrupted: interrupted,
                voiceId: voiceId,
                offlineVoice: false,
                chunkCount: 1
            )
        )
    }

    private func settleAll(interrupted: Bool) {
        let outstanding = pending
        pending.removeAll()
        let voices = pendingVoice
        pendingVoice.removeAll()

        for (key, completion) in outstanding {
            completion(
                SpeakOutcome(
                    completed: false,
                    interrupted: interrupted,
                    voiceId: voices[key] ?? nil,
                    offlineVoice: false,
                    chunkCount: 1
                )
            )
        }
    }

    /// Loose BCP-47 comparison, matching the Android controller's `matchesTag`: platform
    /// lists mix separators and casing, and a base-language voice must satisfy a regional
    /// request or a perfectly usable voice reads as missing.
    static func matchesTag(_ candidate: String, _ requested: String) -> Bool {
        let lhs = candidate.replacingOccurrences(of: "_", with: "-").lowercased()
        let rhs = requested.replacingOccurrences(of: "_", with: "-").lowercased()
        if lhs == rhs { return true }
        return lhs.split(separator: "-").first == rhs.split(separator: "-").first
    }

    /// `.enhanced` and (iOS 16+) `.premium` both map to "high"; the `default` arm covers
    /// `.premium` without needing an `@available` check on a 15.0 deployment target.
    static func qualityLabel(_ quality: AVSpeechSynthesisVoiceQuality) -> String {
        switch quality {
        case .default: return "normal"
        default: return "high"
        }
    }
}
