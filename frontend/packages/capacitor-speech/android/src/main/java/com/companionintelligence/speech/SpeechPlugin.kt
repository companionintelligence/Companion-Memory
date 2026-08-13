package com.companionintelligence.speech

import android.Manifest
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.PermissionState
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback

/**
 * Permission aliases, declared at file scope because the `@CapacitorPlugin` annotation
 * below needs them as compile-time constants on the very class that would otherwise own
 * them. Mirrors `SpeechPermissionAlias` in `src/definitions.ts`.
 */
private const val MICROPHONE_ALIAS = "microphone"
private const val RECOGNITION_ALIAS = "speechRecognition"

/**
 * Android native half of the offline speech plugin. See `src/definitions.ts` for the
 * JS-facing contract and this package's `README.md` for the design, especially the
 * three-tier recognition strategy and why `guaranteedOnDevice` is threaded through every
 * response and event.
 *
 * This class only translates between [PluginCall] and the two plain-Android controllers
 * ([SpeechRecognitionController], [SpeechSynthesisController]) — all speech logic lives
 * there, which is what lets the instrumented tests exercise it without a Capacitor Bridge.
 *
 * ## Threading
 *
 * Capacitor dispatches `@PluginMethod` calls off the main thread, but every
 * `SpeechRecognizer` method is `@MainThread`, so each method here hops via
 * `bridge.executeOnMainThread`. The synthesis controller does its own main-thread hop
 * internally (its callbacks arrive on a binder thread), so it is safe from either side.
 *
 * ## Permissions
 *
 * `RECORD_AUDIO` is requested through Capacitor's permission flow, not left to the
 * WebView. The WebView grants the microphone lazily for `getUserMedia`, which does nothing
 * for a native `SpeechRecognizer` — it fails with `ERROR_INSUFFICIENT_PERMISSIONS` instead.
 * The `speechRecognition` alias has no Android permission behind it (Capacitor auto-grants
 * aliases declared with no strings) and exists purely so the JS surface is identical on
 * both platforms; on iOS it is a real, separate authorization.
 */
@CapacitorPlugin(
    name = "Speech",
    permissions = [
        Permission(strings = [Manifest.permission.RECORD_AUDIO], alias = MICROPHONE_ALIAS),
        Permission(strings = [], alias = RECOGNITION_ALIAS),
    ],
)
class SpeechPlugin : Plugin() {
    private lateinit var recognition: SpeechRecognitionController
    private lateinit var synthesis: SpeechSynthesisController

    override fun load() {
        super.load()
        recognition = SpeechRecognitionController(context.applicationContext, BridgeRecognitionEvents())
        synthesis = SpeechSynthesisController(context.applicationContext)
        // Binding to a TTS engine takes a moment; start it now so the first speak() is not
        // charged for the bind, and so getSynthesisCapability() has a real answer early.
        synthesis.initialize()
    }

    override fun handleOnDestroy() {
        // Both hold bound remote services. A leaked recognizer wedges later sessions with
        // ERROR_RECOGNIZER_BUSY; a leaked TextToSpeech leaks the engine's native heap.
        bridge.executeOnMainThread { recognition.destroy() }
        synthesis.shutdown()
        super.handleOnDestroy()
    }

    // ------------------------------------------------------------------ recognition

    @PluginMethod
    fun getRecognitionCapability(call: PluginCall) {
        val language = call.getString("language")
        bridge.executeOnMainThread {
            recognition.probeCapability(language) { capability ->
                val ret = JSObject()
                ret.put("available", capability.available)
                ret.put("mode", capability.mode)
                ret.put("guaranteedOnDevice", capability.guaranteedOnDevice)
                ret.put("languagePack", capability.languagePack)
                ret.put("language", capability.language)
                ret.put("tier", capability.tier.wire)
                capability.reason?.let { ret.put("reason", it) }
                call.resolve(ret)
            }
        }
    }

    @PluginMethod
    fun getRecognitionLanguages(call: PluginCall) {
        bridge.executeOnMainThread {
            recognition.probeLanguages { languages ->
                val ret = JSObject()
                val array = JSArray()
                languages?.forEach { language ->
                    val entry = JSObject()
                    entry.put("tag", language.tag)
                    entry.put("installed", language.installed)
                    entry.put("downloadable", language.downloadable)
                    entry.put("pending", language.pending)
                    array.put(entry)
                }
                ret.put("languages", array)
                // Distinguishes "no languages" from "this OS version cannot tell you".
                ret.put("enumerable", languages != null)
                call.resolve(ret)
            }
        }
    }

    @PluginMethod
    fun downloadRecognitionLanguage(call: PluginCall) {
        val language = call.getString("language")
        if (language == null) {
            call.reject("language is required")
            return
        }

        bridge.executeOnMainThread {
            recognition.downloadLanguageModel(language) { started, reason ->
                val ret = JSObject()
                ret.put("started", started)
                ret.put(
                    "languagePack",
                    if (started) SpeechRecognitionController.PACK_DOWNLOADING else SpeechRecognitionController.PACK_UNKNOWN,
                )
                if (reason != null) {
                    ret.put("reason", reason)
                }
                call.resolve(ret)
            }
        }
    }

    @PluginMethod
    fun startListening(call: PluginCall) {
        if (getPermissionState(MICROPHONE_ALIAS) != PermissionState.GRANTED) {
            // Saved and replayed by handleMicrophonePermission below once the user answers.
            requestPermissionForAlias(MICROPHONE_ALIAS, call, "handleMicrophonePermission")
            return
        }
        beginListening(call)
    }

    @PermissionCallback
    private fun handleMicrophonePermission(call: PluginCall) {
        if (getPermissionState(MICROPHONE_ALIAS) != PermissionState.GRANTED) {
            call.reject("Microphone permission is required for speech recognition.", "permission-denied")
            return
        }
        beginListening(call)
    }

    private fun beginListening(call: PluginCall) {
        val language = call.getString("language")
        val partialResults = call.getBoolean("partialResults", true) ?: true
        val maxAlternatives = call.getInt("maxAlternatives", 1) ?: 1
        val policy = call.getString("onDevicePolicy") ?: SpeechRecognitionController.POLICY_REQUIRE
        val silenceTimeoutMs = call.getInt("silenceTimeoutMs")?.toLong()

        if (policy !in VALID_POLICIES) {
            call.reject("onDevicePolicy must be one of: ${VALID_POLICIES.joinToString(", ")}")
            return
        }

        bridge.executeOnMainThread {
            when (val outcome = recognition.startListening(language, partialResults, maxAlternatives, policy, silenceTimeoutMs)) {
                is StartOutcome.Rejected -> call.reject(outcome.message, outcome.code)
                is StartOutcome.Started -> {
                    val ret = JSObject()
                    ret.put("mode", outcome.mode)
                    ret.put("guaranteedOnDevice", outcome.guaranteedOnDevice)
                    ret.put("tier", outcome.tier.wire)
                    ret.put("language", outcome.language)
                    call.resolve(ret)
                }
            }
        }
    }

    @PluginMethod
    fun stopListening(call: PluginCall) {
        bridge.executeOnMainThread {
            recognition.stopListening()
            call.resolve()
        }
    }

    @PluginMethod
    fun cancelListening(call: PluginCall) {
        bridge.executeOnMainThread {
            recognition.cancelListening()
            call.resolve()
        }
    }

    @PluginMethod
    fun isListening(call: PluginCall) {
        bridge.executeOnMainThread {
            val ret = JSObject()
            ret.put("listening", recognition.isListening())
            call.resolve(ret)
        }
    }

    // ------------------------------------------------------------------ synthesis

    @PluginMethod
    fun getSynthesisCapability(call: PluginCall) {
        val language = call.getString("language")
        synthesis.probeCapability(language) { capability ->
            val ret = JSObject()
            ret.put("available", capability.available)
            ret.put("offlineVoiceAvailable", capability.offlineVoiceAvailable)
            ret.put("languageStatus", capability.languageStatus)
            ret.put("language", capability.language)
            capability.maxInputLength?.let { ret.put("maxInputLength", it) }
            capability.engine?.let { ret.put("engine", it) }
            capability.reason?.let { ret.put("reason", it) }
            call.resolve(ret)
        }
    }

    @PluginMethod
    fun getVoices(call: PluginCall) {
        val language = call.getString("language")
        synthesis.probeVoices(language) { voices ->
            val array = JSArray()
            voices.forEach { voice ->
                val entry = JSObject()
                entry.put("id", voice.id)
                entry.put("name", voice.name)
                entry.put("language", voice.language)
                entry.put("offline", voice.offline)
                voice.quality?.let { entry.put("quality", it) }
                array.put(entry)
            }
            val ret = JSObject()
            ret.put("voices", array)
            call.resolve(ret)
        }
    }

    @PluginMethod
    fun getSynthesisLanguages(call: PluginCall) {
        synthesis.probeLanguages { languages ->
            val array = JSArray()
            languages.forEach { language ->
                val entry = JSObject()
                entry.put("tag", language.tag)
                entry.put("status", language.status)
                array.put(entry)
            }
            val ret = JSObject()
            ret.put("languages", array)
            call.resolve(ret)
        }
    }

    @PluginMethod
    fun installSynthesisLanguage(call: PluginCall) {
        val (started, reason) = synthesis.installVoiceData()
        val ret = JSObject()
        ret.put("started", started)
        if (reason != null) {
            ret.put("reason", reason)
        }
        call.resolve(ret)
    }

    @PluginMethod
    fun speak(call: PluginCall) {
        val text = call.getString("text")
        if (text == null) {
            call.reject("text is required")
            return
        }

        val request =
            SpeakRequest(
                text = text,
                language = call.getString("language"),
                voiceId = call.getString("voiceId"),
                rate = call.getFloat("rate"),
                pitch = call.getFloat("pitch"),
                interrupt = call.getBoolean("interrupt", true) ?: true,
                // Defaults to true: this product's posture is that speaking must not quietly
                // require the network. A caller opts out explicitly.
                requireOfflineVoice = call.getBoolean("requireOfflineVoice", true) ?: true,
            )

        synthesis.speak(
            request,
            { outcome ->
                val ret = JSObject()
                ret.put("completed", outcome.completed)
                ret.put("interrupted", outcome.interrupted)
                outcome.voiceId?.let { ret.put("voiceId", it) }
                ret.put("offlineVoice", outcome.offlineVoice)
                ret.put("chunkCount", outcome.chunkCount)
                call.resolve(ret)
            },
            { message -> call.reject(message) },
        )
    }

    @PluginMethod
    fun stopSpeaking(call: PluginCall) {
        synthesis.stop()
        call.resolve()
    }

    @PluginMethod
    fun isSpeaking(call: PluginCall) {
        val ret = JSObject()
        ret.put("speaking", synthesis.isSpeaking())
        call.resolve(ret)
    }

    // ------------------------------------------------------------------ events

    /** Forwards controller callbacks to JS listeners registered via `addListener`. */
    private inner class BridgeRecognitionEvents : RecognitionEvents {
        override fun onPartial(transcript: String, mode: String, guaranteedOnDevice: Boolean) {
            val event = JSObject()
            event.put("transcript", transcript)
            // Repeated on every event so a long session cannot drift away from the truth
            // about where the audio is being processed.
            event.put("mode", mode)
            event.put("guaranteedOnDevice", guaranteedOnDevice)
            notifyListeners(EVENT_PARTIAL_RESULT, event)
        }

        override fun onFinal(alternatives: List<String>, mode: String, guaranteedOnDevice: Boolean) {
            val event = JSObject()
            event.put("transcript", alternatives.firstOrNull() ?: "")
            val array = JSArray()
            alternatives.forEach { array.put(it) }
            event.put("alternatives", array)
            event.put("mode", mode)
            event.put("guaranteedOnDevice", guaranteedOnDevice)
            notifyListeners(EVENT_RESULT, event)
        }

        override fun onError(code: String, message: String, recoverable: Boolean) {
            val event = JSObject()
            event.put("code", code)
            event.put("message", message)
            event.put("recoverable", recoverable)
            notifyListeners(EVENT_ERROR, event)
        }

        override fun onEnd(reason: String) {
            val event = JSObject()
            event.put("reason", reason)
            notifyListeners(EVENT_END, event)
        }
    }

    companion object {
        const val EVENT_PARTIAL_RESULT = "speechPartialResult"
        const val EVENT_RESULT = "speechResult"
        const val EVENT_ERROR = "speechError"
        const val EVENT_END = "speechEnd"

        private val VALID_POLICIES =
            setOf(
                SpeechRecognitionController.POLICY_REQUIRE,
                SpeechRecognitionController.POLICY_PREFER,
                SpeechRecognitionController.POLICY_ALLOW,
            )
    }
}
