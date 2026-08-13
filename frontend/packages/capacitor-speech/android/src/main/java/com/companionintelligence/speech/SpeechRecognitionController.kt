package com.companionintelligence.speech

import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.speech.ModelDownloadListener
import android.speech.RecognitionListener
import android.speech.RecognitionSupport
import android.speech.RecognitionSupportCallback
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import androidx.annotation.MainThread
import androidx.annotation.RequiresApi
import java.util.Locale
import java.util.concurrent.Executor
import java.util.concurrent.atomic.AtomicBoolean

/**
 * The recognizer implementation actually selected for this device, mirroring
 * `SpeechRecognitionTier` in `src/definitions.ts`. The `wire` value is what crosses the
 * bridge; keep the two in sync.
 */
enum class RecognitionTier(val wire: String) {
    /** API 33+: `checkRecognitionSupport()` pre-flight + `createOnDeviceSpeechRecognizer()`. */
    CHECKED_ON_DEVICE("android-checked-on-device"),

    /** API 31–32: `isOnDeviceRecognitionAvailable()` + `createOnDeviceSpeechRecognizer()`. */
    ON_DEVICE("android-on-device"),

    /** API 23–30: `createSpeechRecognizer()` + the `EXTRA_PREFER_OFFLINE` *hint*. */
    PREFER_OFFLINE_HINT("android-prefer-offline-hint"),

    /** No usable recognizer on this device. */
    NONE("none"),
}

/** Capability answer for one language. Mirrors `SpeechRecognitionCapability`. */
data class RecognitionCapability(
    val available: Boolean,
    val mode: String,
    val guaranteedOnDevice: Boolean,
    val languagePack: String,
    val language: String,
    val tier: RecognitionTier,
    val reason: String? = null,
)

/** One entry of the on-device language listing. Mirrors `SpeechRecognitionLanguage`. */
data class RecognitionLanguage(
    val tag: String,
    val installed: Boolean,
    val downloadable: Boolean,
    val pending: Boolean,
)

/** Outcome of a [SpeechRecognitionController.startListening] attempt. */
sealed class StartOutcome {
    data class Started(
        val mode: String,
        val guaranteedOnDevice: Boolean,
        val tier: RecognitionTier,
        val language: String,
    ) : StartOutcome()

    data class Rejected(val code: String, val message: String) : StartOutcome()
}

/** Callbacks the controller raises during a session; [SpeechPlugin] forwards them to JS. */
interface RecognitionEvents {
    fun onPartial(transcript: String, mode: String, guaranteedOnDevice: Boolean)

    fun onFinal(alternatives: List<String>, mode: String, guaranteedOnDevice: Boolean)

    fun onError(code: String, message: String, recoverable: Boolean)

    fun onEnd(reason: String)
}

/**
 * Everything this plugin knows about `android.speech.SpeechRecognizer`, kept free of any
 * Capacitor type so it can be exercised by an instrumented test without a Bridge (the same
 * split `@ci/capacitor-local-hub` uses between `LocalHubPlugin` and `LocalHubServer`).
 *
 * ## Why three tiers
 *
 * "Offline recognition" is not one API. What the platform can *promise* changes twice
 * between this project's minSdk (23) and its target (35):
 *
 * - **API 33+** — [SpeechRecognizer.checkRecognitionSupport] reports which languages have a
 *   model installed, which are supported but need a download, and which are already
 *   downloading, and [SpeechRecognizer.triggerModelDownload] can fetch a missing one.
 *   Combined with `createOnDeviceSpeechRecognizer`, this is the only tier where both
 *   "recognition is local" and "the model is present" are verified before the mic opens.
 * - **API 31–32** — `createOnDeviceSpeechRecognizer` exists, so recognition *is* local, but
 *   there is no support-check API. A missing language model only surfaces once listening
 *   starts, as `ERROR_LANGUAGE_UNAVAILABLE`. Note also that
 *   [SpeechRecognizer.isOnDeviceRecognitionAvailable] is only a framework-resource lookup:
 *   it says an on-device service exists, never that a model is downloaded. Availability is
 *   not usability, which is why the pack state here is `unknown`, not `installed`.
 * - **API 23–30** — only [RecognizerIntent.EXTRA_PREFER_OFFLINE], which AOSP documents as a
 *   hint that "may have no effect" depending on the recognizer implementation. There is no
 *   callback confirming it was honored. This tier therefore reports
 *   `guaranteedOnDevice = false` and mode `best-effort`, forever, by design — the UI must
 *   be able to tell the user the truth.
 *
 * ## Threading
 *
 * Every `SpeechRecognizer` method is `@MainThread`, so every public method here is
 * [MainThread] and all mutable state is confined to the main thread. [SpeechPlugin] hops
 * onto it via `bridge.executeOnMainThread`. Sessions always end with `destroy()` — the
 * recognizer holds a bound remote service, and leaking it wedges later sessions with
 * `ERROR_RECOGNIZER_BUSY`.
 */
class SpeechRecognitionController(private val context: Context, private val events: RecognitionEvents) {
    private val mainHandler = Handler(Looper.getMainLooper())

    /** Runs the API 33+ callbacks on the main thread, as those APIs' `Executor` argument. */
    private val mainExecutor = Executor { command -> mainHandler.post(command) }

    private var recognizer: SpeechRecognizer? = null
    private var listening = false
    private var sessionMode = MODE_UNAVAILABLE
    private var sessionGuaranteed = false

    /** True between `stopListening()`/`cancelListening()` and the recognizer actually finishing. */
    private var closing = false

    @MainThread
    fun isListening(): Boolean = listening

    /**
     * Pure capability probe. Never opens the microphone and never prompts for a permission;
     * [callback] is always invoked exactly once, on the main thread.
     *
     * On the API 33+ tier this issues a real [SpeechRecognizer.checkRecognitionSupport],
     * which is asynchronous and — on some engines — simply never answers, so it is bounded
     * by [SUPPORT_CHECK_TIMEOUT_MS]. A timeout degrades the *language pack* answer to
     * `unknown`; it does not downgrade the on-device guarantee, which comes from using
     * `createOnDeviceSpeechRecognizer` rather than from the check.
     */
    @MainThread
    fun probeCapability(language: String?, callback: (RecognitionCapability) -> Unit) {
        val tag = language ?: defaultLanguageTag()
        val tier = resolveTier(Build.VERSION.SDK_INT, onDeviceRecognitionAvailable(), recognitionAvailable())

        when (tier) {
            RecognitionTier.NONE ->
                callback(
                    RecognitionCapability(
                        available = false,
                        mode = MODE_UNAVAILABLE,
                        guaranteedOnDevice = false,
                        languagePack = PACK_UNKNOWN,
                        language = tag,
                        tier = tier,
                        reason = "No speech recognition service is installed on this device.",
                    ),
                )

            RecognitionTier.PREFER_OFFLINE_HINT ->
                callback(
                    RecognitionCapability(
                        available = true,
                        mode = MODE_BEST_EFFORT,
                        guaranteedOnDevice = false,
                        languagePack = PACK_UNKNOWN,
                        language = tag,
                        tier = tier,
                        reason =
                            "Android ${Build.VERSION.SDK_INT} can only be *asked* to prefer offline recognition " +
                                "(EXTRA_PREFER_OFFLINE); the platform does not confirm whether the request was honored.",
                    ),
                )

            RecognitionTier.ON_DEVICE ->
                callback(
                    RecognitionCapability(
                        available = true,
                        mode = MODE_ON_DEVICE,
                        guaranteedOnDevice = true,
                        // No checkRecognitionSupport before API 33: a missing model only shows
                        // up at runtime as ERROR_LANGUAGE_UNAVAILABLE.
                        languagePack = PACK_UNKNOWN,
                        language = tag,
                        tier = tier,
                        reason = null,
                    ),
                )

            RecognitionTier.CHECKED_ON_DEVICE -> probeWithSupportCheck(tag, callback)
        }
    }

    /**
     * Enumerate on-device languages and their model state (API 33+ only). [callback] gets
     * `null` when the platform cannot enumerate, which is different from "no languages".
     */
    @MainThread
    fun probeLanguages(callback: (List<RecognitionLanguage>?) -> Unit) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || !onDeviceRecognitionAvailable()) {
            callback(null)
            return
        }

        withSupportCheck(defaultLanguageTag()) { support ->
            if (support == null) {
                callback(null)
                return@withSupportCheck
            }

            val installed = support.installedOnDeviceLanguages
            val pending = support.pendingOnDeviceLanguages
            val supported = support.supportedOnDeviceLanguages
            val all = LinkedHashSet<String>().apply {
                addAll(installed)
                addAll(pending)
                addAll(supported)
            }

            callback(
                all.map { tag ->
                    RecognitionLanguage(
                        tag = tag,
                        installed = installed.any { matchesTag(it, tag) },
                        // "Downloadable" means supported-but-not-yet-installed, which is the
                        // actionable state; a language already installed is not downloadable.
                        downloadable = supported.any { matchesTag(it, tag) } && installed.none { matchesTag(it, tag) },
                        pending = pending.any { matchesTag(it, tag) },
                    )
                },
            )
        }
    }

    /**
     * Ask the platform to fetch a missing on-device model (API 33+). [callback] receives
     * `(started, reason)`. The listener overload is API 34+; on 33 the bare
     * `triggerModelDownload(Intent)` is fire-and-forget, so `started` there means only
     * "requested", never "succeeded" — poll [probeCapability] for the real answer.
     */
    @MainThread
    fun downloadLanguageModel(language: String, callback: (Boolean, String?) -> Unit) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            callback(false, "Downloading recognition language models requires Android 13 (API 33) or newer.")
            return
        }
        if (!onDeviceRecognitionAvailable()) {
            callback(false, "This device has no on-device recognition service to download a model into.")
            return
        }

        val onDevice = createOnDeviceRecognizer()
        if (onDevice == null) {
            callback(false, "Could not create an on-device speech recognizer.")
            return
        }

        try {
            val intent = recognizerIntent(language, partialResults = false, maxAlternatives = 1, preferOffline = true)

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
                val settled = AtomicBoolean(false)
                onDevice.triggerModelDownload(
                    intent,
                    mainExecutor,
                    object : ModelDownloadListener {
                        override fun onProgress(completedPercent: Int) {
                            // Progress is not surfaced to JS: the download is owned by the
                            // system recognition service and continues past this listener's
                            // lifetime, so a progress stream here would be misleading.
                        }

                        override fun onSuccess() {
                            if (settled.compareAndSet(false, true)) {
                                destroyRecognizer(onDevice)
                                callback(true, null)
                            }
                        }

                        override fun onScheduled() {
                            if (settled.compareAndSet(false, true)) {
                                destroyRecognizer(onDevice)
                                callback(true, null)
                            }
                        }

                        override fun onError(error: Int) {
                            if (settled.compareAndSet(false, true)) {
                                destroyRecognizer(onDevice)
                                callback(false, "Model download failed: ${describeError(error)}")
                            }
                        }
                    },
                )
            } else {
                @Suppress("DEPRECATION")
                onDevice.triggerModelDownload(intent)
                destroyRecognizer(onDevice)
                callback(true, null)
            }
        } catch (e: Exception) {
            destroyRecognizer(onDevice)
            callback(false, "Model download could not be requested: ${e.message}")
        }
    }

    /**
     * Open the microphone. Returns synchronously with the session's real guarantees, or a
     * [StartOutcome.Rejected] when the requested policy cannot be honored. Transcripts and
     * failures arrive through [events]; the caller must have subscribed already.
     *
     * `onDevicePolicy` is enforced here rather than in JS so a caller cannot get local-only
     * behavior by accident and lose it after an OS upgrade without noticing.
     */
    @MainThread
    fun startListening(
        language: String?,
        partialResults: Boolean,
        maxAlternatives: Int,
        onDevicePolicy: String,
        silenceTimeoutMs: Long?,
    ): StartOutcome {
        if (listening) {
            return StartOutcome.Rejected("busy", "A recognition session is already running.")
        }

        val tag = language ?: defaultLanguageTag()
        val tier = resolveTier(Build.VERSION.SDK_INT, onDeviceRecognitionAvailable(), recognitionAvailable())

        if (tier == RecognitionTier.NONE) {
            return StartOutcome.Rejected("not-supported", "No speech recognition service is installed on this device.")
        }

        val guaranteed = tier == RecognitionTier.CHECKED_ON_DEVICE || tier == RecognitionTier.ON_DEVICE

        if (!guaranteed && onDevicePolicy == POLICY_REQUIRE) {
            return StartOutcome.Rejected(
                "on-device-unavailable",
                "This device cannot guarantee on-device recognition (Android ${Build.VERSION.SDK_INT} only offers " +
                    "the EXTRA_PREFER_OFFLINE hint). Pass onDevicePolicy: 'prefer' to accept best-effort offline.",
            )
        }

        val instance =
            (if (guaranteed) createOnDeviceRecognizer() else SpeechRecognizer.createSpeechRecognizer(context))
                ?: return StartOutcome.Rejected("client", "Could not create a speech recognizer.")

        // 'allow' is the only policy that lets a recognizer reach the network. It never
        // applies to the on-device tiers, whose recognizer is local regardless of the hint.
        val preferOffline = guaranteed || onDevicePolicy != POLICY_ALLOW
        val mode =
            when {
                guaranteed -> MODE_ON_DEVICE
                preferOffline -> MODE_BEST_EFFORT
                else -> MODE_NETWORK
            }

        recognizer = instance
        listening = true
        closing = false
        sessionMode = mode
        sessionGuaranteed = guaranteed

        instance.setRecognitionListener(SessionListener())

        return try {
            instance.startListening(
                recognizerIntent(tag, partialResults, maxAlternatives, preferOffline, silenceTimeoutMs),
            )
            StartOutcome.Started(mode, guaranteed, tier, tag)
        } catch (e: Exception) {
            teardown()
            StartOutcome.Rejected("client", "Failed to start listening: ${e.message}")
        }
    }

    /** Stop capturing but let the recognizer finalize — a final result still follows. */
    @MainThread
    fun stopListening() {
        val instance = recognizer ?: return
        closing = true
        try {
            instance.stopListening()
        } catch (e: Exception) {
            events.onError("client", "Failed to stop listening: ${e.message}", false)
            teardown()
            events.onEnd(END_ERROR)
        }
    }

    /** Abandon the session with no final result. */
    @MainThread
    fun cancelListening() {
        val instance = recognizer ?: return
        closing = true
        try {
            instance.cancel()
        } catch (e: Exception) {
            // Cancelling is best-effort; tearing down below is what actually matters.
        }
        teardown()
        events.onEnd(END_CANCELLED)
    }

    /** Release the bound recognition service. Safe to call when nothing is running. */
    @MainThread
    fun destroy() {
        teardown()
    }

    // ------------------------------------------------------------------ internals

    private inner class SessionListener : RecognitionListener {
        override fun onReadyForSpeech(params: Bundle?) = Unit

        override fun onBeginningOfSpeech() = Unit

        override fun onRmsChanged(rmsdB: Float) = Unit

        override fun onBufferReceived(buffer: ByteArray?) = Unit

        override fun onEndOfSpeech() = Unit

        override fun onPartialResults(partialResults: Bundle?) {
            val transcripts = transcriptsOf(partialResults)
            if (transcripts.isNotEmpty() && transcripts[0].isNotEmpty()) {
                events.onPartial(transcripts[0], sessionMode, sessionGuaranteed)
            }
        }

        override fun onResults(results: Bundle?) {
            val transcripts = transcriptsOf(results)
            teardown()
            if (transcripts.isEmpty()) {
                events.onError("no-match", "No speech was recognized.", true)
                events.onEnd(END_ERROR)
                return
            }
            events.onFinal(transcripts, sessionMode, sessionGuaranteed)
            events.onEnd(if (closing) END_STOPPED else END_FINAL)
        }

        override fun onError(error: Int) {
            val code = errorCodeFor(error)
            teardown()
            events.onError(code, describeError(error), isRecoverable(error))
            events.onEnd(if (code == "speech-timeout") END_SILENCE else END_ERROR)
        }

        override fun onEvent(eventType: Int, params: Bundle?) = Unit
    }

    /** API 33+ probe: on-device recognizer plus a bounded `checkRecognitionSupport`. */
    @RequiresApi(Build.VERSION_CODES.TIRAMISU)
    private fun probeWithSupportCheck(tag: String, callback: (RecognitionCapability) -> Unit) {
        withSupportCheck(tag) { support ->
            val pack =
                when {
                    support == null -> PACK_UNKNOWN
                    support.installedOnDeviceLanguages.any { matchesTag(it, tag) } -> PACK_INSTALLED
                    support.pendingOnDeviceLanguages.any { matchesTag(it, tag) } -> PACK_DOWNLOADING
                    support.supportedOnDeviceLanguages.any { matchesTag(it, tag) } -> PACK_DOWNLOADABLE
                    else -> PACK_UNSUPPORTED
                }

            callback(
                RecognitionCapability(
                    // The recognizer is on-device either way; only the *model* may be missing,
                    // which is what `languagePack` communicates. Reporting available = false
                    // for a downloadable pack would hide the one action that fixes it.
                    available = pack != PACK_UNSUPPORTED,
                    mode = if (pack == PACK_UNSUPPORTED) MODE_UNAVAILABLE else MODE_ON_DEVICE,
                    guaranteedOnDevice = pack != PACK_UNSUPPORTED,
                    languagePack = pack,
                    language = tag,
                    tier = RecognitionTier.CHECKED_ON_DEVICE,
                    reason =
                        when (pack) {
                            PACK_UNSUPPORTED -> "The on-device recognizer does not support $tag."
                            PACK_DOWNLOADABLE -> "The on-device model for $tag is supported but not installed yet."
                            PACK_DOWNLOADING -> "The on-device model for $tag is still downloading."
                            PACK_UNKNOWN -> "The recognizer did not answer checkRecognitionSupport() in time."
                            else -> null
                        },
                )
            )
        }
    }

    /**
     * Run [SpeechRecognizer.checkRecognitionSupport] against a throwaway on-device
     * recognizer, always destroying it afterwards, and always invoking [callback] exactly
     * once — with `null` when the check errors or exceeds [SUPPORT_CHECK_TIMEOUT_MS].
     */
    @RequiresApi(Build.VERSION_CODES.TIRAMISU)
    private fun withSupportCheck(tag: String, callback: (RecognitionSupport?) -> Unit) {
        val onDevice = createOnDeviceRecognizer()
        if (onDevice == null) {
            callback(null)
            return
        }

        val settled = AtomicBoolean(false)
        val finish = { support: RecognitionSupport? ->
            if (settled.compareAndSet(false, true)) {
                destroyRecognizer(onDevice)
                callback(support)
            }
        }
        val timeout = Runnable { finish(null) }
        mainHandler.postDelayed(timeout, SUPPORT_CHECK_TIMEOUT_MS)

        try {
            onDevice.checkRecognitionSupport(
                recognizerIntent(tag, partialResults = false, maxAlternatives = 1, preferOffline = true),
                mainExecutor,
                object : RecognitionSupportCallback {
                    override fun onSupportResult(recognitionSupport: RecognitionSupport) {
                        mainHandler.removeCallbacks(timeout)
                        finish(recognitionSupport)
                    }

                    override fun onError(error: Int) {
                        mainHandler.removeCallbacks(timeout)
                        finish(null)
                    }
                },
            )
        } catch (e: Exception) {
            mainHandler.removeCallbacks(timeout)
            finish(null)
        }
    }

    @MainThread
    private fun teardown() {
        val instance = recognizer
        recognizer = null
        listening = false
        if (instance != null) {
            destroyRecognizer(instance)
        }
    }

    private fun destroyRecognizer(instance: SpeechRecognizer) {
        try {
            instance.destroy()
        } catch (e: Exception) {
            // Already dead — nothing to release.
        }
    }

    private fun createOnDeviceRecognizer(): SpeechRecognizer? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            try {
                SpeechRecognizer.createOnDeviceSpeechRecognizer(context)
            } catch (e: Exception) {
                null
            }
        } else {
            null
        }

    private fun recognitionAvailable(): Boolean =
        try {
            SpeechRecognizer.isRecognitionAvailable(context)
        } catch (e: Exception) {
            false
        }

    private fun onDeviceRecognitionAvailable(): Boolean =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            try {
                SpeechRecognizer.isOnDeviceRecognitionAvailable(context)
            } catch (e: Exception) {
                false
            }
        } else {
            false
        }

    private fun recognizerIntent(
        language: String,
        partialResults: Boolean,
        maxAlternatives: Int,
        preferOffline: Boolean,
        silenceTimeoutMs: Long? = null,
    ): Intent =
        Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
            putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
            putExtra(RecognizerIntent.EXTRA_LANGUAGE, language)
            putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, partialResults)
            putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, maxAlternatives.coerceAtLeast(1))
            // A documented hint only — see this class's KDoc. Set on every tier because it
            // costs nothing on the on-device tiers and is the whole mechanism on 23–30.
            putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, preferOffline)
            // Some engines reject requests from an unidentified caller.
            putExtra(RecognizerIntent.EXTRA_CALLING_PACKAGE, context.packageName)
            if (silenceTimeoutMs != null) {
                putExtra(RecognizerIntent.EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS, silenceTimeoutMs)
            }
        }

    private fun defaultLanguageTag(): String = Locale.getDefault().toLanguageTag()

    private fun transcriptsOf(bundle: Bundle?): List<String> =
        bundle?.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.filterNotNull() ?: emptyList()

    companion object {
        const val MODE_ON_DEVICE = "on-device"
        const val MODE_BEST_EFFORT = "best-effort"
        const val MODE_NETWORK = "network"
        const val MODE_UNAVAILABLE = "unavailable"

        const val PACK_INSTALLED = "installed"
        const val PACK_DOWNLOADABLE = "downloadable"
        const val PACK_DOWNLOADING = "downloading"
        const val PACK_UNSUPPORTED = "unsupported"
        const val PACK_UNKNOWN = "unknown"

        const val POLICY_REQUIRE = "require"
        const val POLICY_PREFER = "prefer"
        const val POLICY_ALLOW = "allow"

        const val END_FINAL = "final-result"
        const val END_STOPPED = "stopped"
        const val END_CANCELLED = "cancelled"
        const val END_SILENCE = "silence"
        const val END_ERROR = "error"

        /**
         * Bound on the asynchronous API 33+ support check. Chosen to be long enough for a
         * cold recognition-service bind (which is the slow part) but short enough that a
         * settings screen probing capability does not appear hung.
         */
        const val SUPPORT_CHECK_TIMEOUT_MS = 4_000L

        /**
         * Error codes 10–15 are API 33/34 additions. They are `static final int` in the
         * framework, so referencing them compiles to plain constants and is safe to evaluate
         * on any runtime — the values simply never arrive from an older recognizer.
         */
        fun errorCodeFor(error: Int): String =
            when (error) {
                SpeechRecognizer.ERROR_NETWORK_TIMEOUT, SpeechRecognizer.ERROR_NETWORK -> "network"
                SpeechRecognizer.ERROR_AUDIO -> "audio"
                SpeechRecognizer.ERROR_SERVER, SpeechRecognizer.ERROR_SERVER_DISCONNECTED -> "server"
                SpeechRecognizer.ERROR_CLIENT -> "client"
                SpeechRecognizer.ERROR_SPEECH_TIMEOUT -> "speech-timeout"
                SpeechRecognizer.ERROR_NO_MATCH -> "no-match"
                SpeechRecognizer.ERROR_RECOGNIZER_BUSY, SpeechRecognizer.ERROR_TOO_MANY_REQUESTS -> "busy"
                SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS -> "permission-denied"
                // The API 31–32 tier's only signal that the on-device model is missing.
                SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE -> "language-unavailable"
                SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED -> "language-not-supported"
                SpeechRecognizer.ERROR_CANNOT_CHECK_SUPPORT -> "not-supported"
                else -> "unknown"
            }

        /** Whether retrying the same request could plausibly succeed. */
        fun isRecoverable(error: Int): Boolean =
            when (error) {
                SpeechRecognizer.ERROR_NO_MATCH,
                SpeechRecognizer.ERROR_SPEECH_TIMEOUT,
                SpeechRecognizer.ERROR_RECOGNIZER_BUSY,
                SpeechRecognizer.ERROR_TOO_MANY_REQUESTS,
                SpeechRecognizer.ERROR_NETWORK_TIMEOUT,
                -> true
                else -> false
            }

        fun describeError(error: Int): String =
            when (errorCodeFor(error)) {
                "network" -> "The recognizer could not reach its network service."
                "audio" -> "Audio could not be recorded."
                "server" -> "The recognition server returned an error."
                "client" -> "The recognizer reported a client-side error."
                "speech-timeout" -> "No speech was detected."
                "no-match" -> "No speech was recognized."
                "busy" -> "The recognizer is busy; try again shortly."
                "permission-denied" -> "Microphone permission has not been granted."
                "language-unavailable" -> "The on-device model for this language is not installed."
                "language-not-supported" -> "This language is not supported by the recognizer."
                "not-supported" -> "The recognizer could not report what it supports."
                else -> "Speech recognition failed (code $error)."
            }

        /**
         * Which tier applies, as a pure function of the three inputs, so it can be asserted
         * for every API level in a test instead of only for whatever the device happens to
         * run. `onDeviceAvailable` is meaningless below API 31 and callers pass false there.
         */
        fun resolveTier(sdkInt: Int, onDeviceAvailable: Boolean, recognitionAvailable: Boolean): RecognitionTier =
            when {
                sdkInt >= Build.VERSION_CODES.TIRAMISU && onDeviceAvailable -> RecognitionTier.CHECKED_ON_DEVICE
                sdkInt >= Build.VERSION_CODES.S && onDeviceAvailable -> RecognitionTier.ON_DEVICE
                recognitionAvailable -> RecognitionTier.PREFER_OFFLINE_HINT
                else -> RecognitionTier.NONE
            }

        /**
         * Loose BCP-47 comparison. Platform lists mix separators and casing (`en_US` vs
         * `en-US`), and an engine may report only a base language for a regional request, so
         * an exact string compare produces false "unsupported" answers.
         */
        fun matchesTag(candidate: String, requested: String): Boolean {
            val a = candidate.replace('_', '-').lowercase(Locale.ROOT)
            val b = requested.replace('_', '-').lowercase(Locale.ROOT)
            if (a == b) {
                return true
            }
            return a.substringBefore('-') == b.substringBefore('-')
        }
    }
}
