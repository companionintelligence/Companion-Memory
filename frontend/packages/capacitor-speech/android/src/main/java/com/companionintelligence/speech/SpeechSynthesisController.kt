package com.companionintelligence.speech

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.os.Handler
import android.os.Looper
import android.speech.tts.TextToSpeech
import android.speech.tts.UtteranceProgressListener
import android.speech.tts.Voice
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong

/** Capability answer for synthesis. Mirrors `SpeechSynthesisCapability`. */
data class SynthesisCapability(
    val available: Boolean,
    val offlineVoiceAvailable: Boolean,
    val languageStatus: String,
    val language: String,
    val maxInputLength: Int?,
    val engine: String?,
    val reason: String? = null,
)

/** One installed voice. Mirrors `SpeechVoice`. */
data class SynthesisVoice(
    val id: String,
    val name: String,
    val language: String,
    val offline: Boolean,
    val quality: String?,
)

/** One language the engine knows about. Mirrors `SpeechSynthesisLanguage`. */
data class SynthesisLanguage(val tag: String, val status: String)

/** Everything one `speak()` call needs. Mirrors `SpeakOptions`. */
data class SpeakRequest(
    val text: String,
    val language: String?,
    val voiceId: String?,
    val rate: Float?,
    val pitch: Float?,
    val interrupt: Boolean,
    val requireOfflineVoice: Boolean,
)

/** How one `speak()` call ended. Mirrors `SpeakResult`. */
data class SpeakOutcome(
    val completed: Boolean,
    val interrupted: Boolean,
    val voiceId: String?,
    val offlineVoice: Boolean,
    val chunkCount: Int,
)

/**
 * Everything this plugin knows about `android.speech.tts.TextToSpeech`, kept free of any
 * Capacitor type so an instrumented test can drive it without a Bridge.
 *
 * Three things about this API drive the shape of this class:
 *
 * 1. **Initialization is asynchronous.** The constructor returns immediately and
 *    `OnInitListener` fires later; a `speak()` issued in between is silently dropped by the
 *    framework. So calls made before init completes are queued here ([pendingOnReady]) and
 *    replayed — or failed — once the engine answers.
 * 2. **Completion is a callback, not a return value.** `speak()` returns as soon as the
 *    utterance is *queued*. Resolving the JS promise on that would make a talk-then-listen
 *    loop open the microphone while the device is still talking, so every utterance carries
 *    an id and the promise is settled from [UtteranceProgressListener].
 * 3. **There is a hard input length.** `TextToSpeech.getMaxSpeechInputLength()` caps a
 *    single `speak()`; an LLM answer routinely exceeds it, and the framework simply refuses
 *    the call. Long text is chunked here (on sentence boundaries where possible) and the
 *    promise settles on the *last* chunk.
 *
 * Binding also requires the host app to declare the `TTS_SERVICE` intent in a `<queries>`
 * element when targeting Android 11+ — see this package's `android/src/main/AndroidManifest.xml`.
 * Without it `onInit` reports `ERROR` and nothing here can work.
 */
class SpeechSynthesisController(private val context: Context) {
    private val mainHandler = Handler(Looper.getMainLooper())
    private val utteranceSeq = AtomicLong(0)

    /** Keyed by the *final* chunk's utterance id; earlier chunks resolve nothing. */
    private val pending = ConcurrentHashMap<String, PendingSpeak>()

    /** Replayed once the engine reports init success (or failure). Main thread only. */
    private val pendingOnReady = mutableListOf<(Boolean) -> Unit>()

    private var tts: TextToSpeech? = null
    private var initState = InitState.PENDING

    private enum class InitState { PENDING, READY, FAILED }

    private class PendingSpeak(
        val voiceId: String?,
        val offlineVoice: Boolean,
        val chunkCount: Int,
        val callback: (SpeakOutcome) -> Unit,
    )

    /** Begin binding to the engine. Call once, from the plugin's `load()`. */
    fun initialize() {
        if (tts != null) {
            return
        }

        tts = TextToSpeech(context.applicationContext) { status ->
            // OnInitListener is documented to run on the main thread; hop anyway so the
            // queue below is only ever touched from one thread regardless of engine quirks.
            mainHandler.post { onInitComplete(status == TextToSpeech.SUCCESS) }
        }

        tts?.setOnUtteranceProgressListener(
            object : UtteranceProgressListener() {
                override fun onStart(utteranceId: String?) = Unit

                override fun onDone(utteranceId: String?) {
                    settle(utteranceId, completed = true, interrupted = false)
                }

                override fun onStop(utteranceId: String?, interrupted: Boolean) {
                    settle(utteranceId, completed = false, interrupted = interrupted)
                }

                @Deprecated("Required override; the int-taking overload below carries the detail.")
                override fun onError(utteranceId: String?) {
                    settle(utteranceId, completed = false, interrupted = false)
                }

                override fun onError(utteranceId: String?, errorCode: Int) {
                    settle(utteranceId, completed = false, interrupted = false)
                }
            },
        )
    }

    /** Release the engine's native resources. */
    fun shutdown() {
        // Anything still queued would otherwise hang its JS promise forever.
        failAllPending()
        try {
            tts?.stop()
            tts?.shutdown()
        } catch (e: Exception) {
            // Engine already gone — nothing to release.
        }
        tts = null
        initState = InitState.FAILED
    }

    /** Capability probe. [callback] runs on the main thread, exactly once. */
    fun probeCapability(language: String?, callback: (SynthesisCapability) -> Unit) {
        whenReady { ready ->
            val engine = tts
            if (!ready || engine == null) {
                callback(
                    SynthesisCapability(
                        available = false,
                        offlineVoiceAvailable = false,
                        languageStatus = LANG_UNKNOWN,
                        language = language ?: Locale.getDefault().toLanguageTag(),
                        maxInputLength = null,
                        engine = null,
                        reason =
                            "No text-to-speech engine could be bound. On Android 11+ this usually means the app " +
                                "is missing the TTS_SERVICE <queries> declaration, or no engine is installed.",
                    ),
                )
                return@whenReady
            }

            val tag = language ?: currentVoiceLanguage(engine) ?: Locale.getDefault().toLanguageTag()
            val voices = voicesOf(engine)

            callback(
                SynthesisCapability(
                    available = true,
                    offlineVoiceAvailable = voices.any { it.offline },
                    languageStatus = languageStatusFor(engine, tag),
                    language = tag,
                    maxInputLength = TextToSpeech.getMaxSpeechInputLength(),
                    engine = engine.defaultEngine,
                ),
            )
        }
    }

    /** Installed voices, optionally filtered to one language. */
    fun probeVoices(language: String?, callback: (List<SynthesisVoice>) -> Unit) {
        whenReady { ready ->
            val engine = tts
            if (!ready || engine == null) {
                callback(emptyList())
                return@whenReady
            }
            val all = voicesOf(engine)
            callback(
                if (language == null) {
                    all
                } else {
                    all.filter { SpeechRecognitionController.matchesTag(it.language, language) }
                },
            )
        }
    }

    /** Languages the engine can speak, with per-language data status. */
    fun probeLanguages(callback: (List<SynthesisLanguage>) -> Unit) {
        whenReady { ready ->
            val engine = tts
            if (!ready || engine == null) {
                callback(emptyList())
                return@whenReady
            }

            val locales =
                try {
                    engine.availableLanguages ?: emptySet()
                } catch (e: Exception) {
                    emptySet<Locale>()
                }

            callback(locales.map { SynthesisLanguage(it.toLanguageTag(), languageStatusFor(engine, it.toLanguageTag())) })
        }
    }

    /**
     * Launch the system voice-data installer so the user can add a missing language.
     * Returns `(started, reason)`. Uses `FLAG_ACTIVITY_NEW_TASK` because the plugin's
     * context is not guaranteed to be an Activity.
     */
    fun installVoiceData(): Pair<Boolean, String?> =
        try {
            context.startActivity(
                Intent(TextToSpeech.Engine.ACTION_INSTALL_TTS_DATA).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            )
            true to null
        } catch (e: ActivityNotFoundException) {
            false to "No installed text-to-speech engine offers a voice-data installer."
        } catch (e: Exception) {
            false to "Could not launch the voice-data installer: ${e.message}"
        }

    fun isSpeaking(): Boolean =
        try {
            tts?.isSpeaking ?: false
        } catch (e: Exception) {
            false
        }

    /** Stop everything; pending promises settle as `interrupted`. */
    fun stop() {
        try {
            tts?.stop()
        } catch (e: Exception) {
            // Nothing speaking.
        }
        // TextToSpeech.stop() does fire onStop for flushed utterances, but only for ones the
        // engine actually accepted; sweep the map so a queued-but-never-started utterance
        // cannot strand its promise.
        interruptAllPending()
    }

    /**
     * Speak [request], settling [callback] when the last chunk finishes (or is cut short).
     * [onFailure] fires for conditions that never produce audio at all — no engine, an
     * unusable language, or an offline-voice requirement that cannot be met.
     */
    fun speak(request: SpeakRequest, callback: (SpeakOutcome) -> Unit, onFailure: (String) -> Unit) {
        if (request.text.isBlank()) {
            onFailure("text is required")
            return
        }

        whenReady { ready ->
            val engine = tts
            if (!ready || engine == null) {
                onFailure("No text-to-speech engine is available on this device.")
                return@whenReady
            }

            val selected = selectVoice(engine, request)
            if (selected is VoiceSelection.Failed) {
                onFailure(selected.reason)
                return@whenReady
            }
            val chosen = (selected as VoiceSelection.Chosen).voice

            try {
                engine.setSpeechRate((request.rate ?: 1.0f).coerceIn(MIN_RATE, MAX_RATE))
                engine.setPitch((request.pitch ?: 1.0f).coerceIn(MIN_PITCH, MAX_PITCH))
            } catch (e: Exception) {
                // Rate/pitch are advisory; a rejecting engine still speaks at its default.
            }

            val chunks = chunkText(request.text, TextToSpeech.getMaxSpeechInputLength())
            val seq = utteranceSeq.incrementAndGet()
            val lastId = "ci-speech-$seq-${chunks.size - 1}"

            pending[lastId] =
                PendingSpeak(
                    voiceId = chosen?.name,
                    offlineVoice = chosen?.let { !it.isNetworkConnectionRequired } ?: false,
                    chunkCount = chunks.size,
                    callback = callback,
                )

            chunks.forEachIndexed { index, chunk ->
                // Only the first chunk may flush; the rest must queue behind it or the text
                // would speak only its final fragment.
                val queueMode =
                    if (index == 0 && request.interrupt) TextToSpeech.QUEUE_FLUSH else TextToSpeech.QUEUE_ADD
                val result = engine.speak(chunk, queueMode, null, "ci-speech-$seq-$index")

                if (result == TextToSpeech.ERROR) {
                    pending.remove(lastId)
                    onFailure("The text-to-speech engine rejected the utterance.")
                    return@whenReady
                }
            }
        }
    }

    // ------------------------------------------------------------------ internals

    private sealed class VoiceSelection {
        data class Chosen(val voice: Voice?) : VoiceSelection()

        data class Failed(val reason: String) : VoiceSelection()
    }

    /**
     * Resolve `voiceId` / `language` / `requireOfflineVoice` into an actual [Voice], applying
     * it to the engine. Returns `Chosen(null)` when the engine's current voice is used as-is
     * and the platform reports no [Voice] object for it.
     */
    private fun selectVoice(engine: TextToSpeech, request: SpeakRequest): VoiceSelection {
        val available =
            try {
                engine.voices ?: emptySet()
            } catch (e: Exception) {
                emptySet<Voice>()
            }

        if (request.voiceId != null) {
            val match = available.firstOrNull { it.name == request.voiceId }
                ?: return VoiceSelection.Failed("Unknown voiceId: ${request.voiceId}")
            if (request.requireOfflineVoice && match.isNetworkConnectionRequired) {
                return VoiceSelection.Failed(
                    "Voice ${match.name} requires a network connection. Pass requireOfflineVoice: false to allow it.",
                )
            }
            return if (engine.setVoice(match) == TextToSpeech.ERROR) {
                VoiceSelection.Failed("The engine refused voice ${match.name}.")
            } else {
                VoiceSelection.Chosen(match)
            }
        }

        val tag = request.language
        if (tag != null) {
            val locale = Locale.forLanguageTag(tag)
            val status = engine.isLanguageAvailable(locale)
            if (status == TextToSpeech.LANG_MISSING_DATA) {
                return VoiceSelection.Failed(
                    "Voice data for $tag is not installed. Call installSynthesisLanguage() to let the user add it.",
                )
            }
            if (status == TextToSpeech.LANG_NOT_SUPPORTED) {
                return VoiceSelection.Failed("The text-to-speech engine does not support $tag.")
            }
            if (engine.setLanguage(locale) == TextToSpeech.LANG_NOT_SUPPORTED) {
                return VoiceSelection.Failed("The text-to-speech engine does not support $tag.")
            }
        }

        // No explicit voice: honor requireOfflineVoice by swapping to an offline voice for the
        // same language when the engine's current pick needs the network.
        val current =
            try {
                engine.voice
            } catch (e: Exception) {
                null
            }

        if (request.requireOfflineVoice && current != null && current.isNetworkConnectionRequired) {
            val offline =
                available.firstOrNull {
                    !it.isNetworkConnectionRequired &&
                        SpeechRecognitionController.matchesTag(it.locale.toLanguageTag(), current.locale.toLanguageTag())
                }
                    ?: return VoiceSelection.Failed(
                        "The only voice available for this language requires a network connection. " +
                            "Pass requireOfflineVoice: false to allow it.",
                    )
            return if (engine.setVoice(offline) == TextToSpeech.ERROR) {
                VoiceSelection.Failed("The engine refused offline voice ${offline.name}.")
            } else {
                VoiceSelection.Chosen(offline)
            }
        }

        return VoiceSelection.Chosen(current)
    }

    private fun onInitComplete(success: Boolean) {
        initState = if (success) InitState.READY else InitState.FAILED
        val queued = pendingOnReady.toList()
        pendingOnReady.clear()
        queued.forEach { it(success) }
    }

    /** Run [block] once the engine has answered, immediately if it already has. */
    private fun whenReady(block: (Boolean) -> Unit) {
        mainHandler.post {
            when (initState) {
                InitState.READY -> block(true)
                InitState.FAILED -> block(false)
                InitState.PENDING -> pendingOnReady.add(block)
            }
        }
    }

    private fun settle(utteranceId: String?, completed: Boolean, interrupted: Boolean) {
        val entry = pending.remove(utteranceId ?: return) ?: return
        mainHandler.post {
            entry.callback(
                SpeakOutcome(
                    completed = completed,
                    interrupted = interrupted,
                    voiceId = entry.voiceId,
                    offlineVoice = entry.offlineVoice,
                    chunkCount = entry.chunkCount,
                ),
            )
        }
    }

    private fun interruptAllPending() {
        pending.keys.toList().forEach { settle(it, completed = false, interrupted = true) }
    }

    private fun failAllPending() {
        pending.keys.toList().forEach { settle(it, completed = false, interrupted = true) }
        val queued = pendingOnReady.toList()
        pendingOnReady.clear()
        queued.forEach { it(false) }
    }

    private fun voicesOf(engine: TextToSpeech): List<SynthesisVoice> =
        try {
            (engine.voices ?: emptySet()).map { voice ->
                SynthesisVoice(
                    id = voice.name,
                    name = voice.name,
                    language = voice.locale.toLanguageTag(),
                    // The platform's own answer, not an inference of ours.
                    offline = !voice.isNetworkConnectionRequired,
                    quality = qualityLabel(voice.quality),
                )
            }
        } catch (e: Exception) {
            emptyList()
        }

    private fun currentVoiceLanguage(engine: TextToSpeech): String? =
        try {
            engine.voice?.locale?.toLanguageTag()
        } catch (e: Exception) {
            null
        }

    private fun languageStatusFor(engine: TextToSpeech, tag: String): String =
        try {
            when (engine.isLanguageAvailable(Locale.forLanguageTag(tag))) {
                TextToSpeech.LANG_MISSING_DATA -> LANG_MISSING_DATA
                TextToSpeech.LANG_NOT_SUPPORTED -> LANG_NOT_SUPPORTED
                else -> LANG_AVAILABLE
            }
        } catch (e: Exception) {
            LANG_UNKNOWN
        }

    companion object {
        const val LANG_AVAILABLE = "available"
        const val LANG_MISSING_DATA = "missing-data"
        const val LANG_NOT_SUPPORTED = "not-supported"
        const val LANG_UNKNOWN = "unknown"

        // Android ignores a non-positive rate outright; these bounds keep a caller's bad
        // value from silently producing an unusable voice.
        const val MIN_RATE = 0.1f
        const val MAX_RATE = 4.0f
        const val MIN_PITCH = 0.1f
        const val MAX_PITCH = 2.0f

        /** Android's `Voice` quality scale is 100 (very low) to 500 (very high). */
        fun qualityLabel(quality: Int): String =
            when {
                quality <= Voice.QUALITY_LOW -> "low"
                quality >= Voice.QUALITY_HIGH -> "high"
                else -> "normal"
            }

        /**
         * Split [text] into pieces no longer than [maxLength], preferring sentence and then
         * word boundaries so the engine's prosody does not break mid-word. A single
         * unbreakable run longer than the limit is hard-split rather than dropped.
         */
        fun chunkText(text: String, maxLength: Int): List<String> {
            val limit = if (maxLength > 0) maxLength else DEFAULT_MAX_INPUT_LENGTH
            if (text.length <= limit) {
                return listOf(text)
            }

            val chunks = mutableListOf<String>()
            var remaining = text

            while (remaining.length > limit) {
                val window = remaining.substring(0, limit)
                val cut =
                    window.lastIndexOfAny(SENTENCE_ENDINGS).let { if (it > limit / 2) it + 1 else -1 }
                        .takeIf { it > 0 }
                        ?: window.lastIndexOf(' ').takeIf { it > 0 }
                        ?: limit

                chunks.add(remaining.substring(0, cut).trim())
                remaining = remaining.substring(cut).trimStart()
            }

            if (remaining.isNotEmpty()) {
                chunks.add(remaining)
            }

            return chunks.filter { it.isNotEmpty() }
        }

        private val SENTENCE_ENDINGS = charArrayOf('.', '!', '?', '\n')

        /** Only used if the engine reports a non-positive max, which would otherwise divide by zero. */
        private const val DEFAULT_MAX_INPUT_LENGTH = 4000
    }
}
