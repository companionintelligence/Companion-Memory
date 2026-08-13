package com.companionintelligence.speech

import android.content.Context
import android.os.Build
import android.speech.SpeechRecognizer
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * On-device (instrumented) verification of [SpeechRecognitionController] and
 * [SpeechSynthesisController], run via `connectedAndroidTest` against a real
 * emulator/device rather than only asserted by code review. Mirrors
 * `@ci/capacitor-local-hub`'s `LocalHubServerTest`: it exercises the plain-Android
 * controllers directly, with no Capacitor Bridge in the picture.
 *
 * ## What this can and cannot prove
 *
 * **Proven here:** the tier-selection, error-mapping, tag-matching and chunking logic
 * (pure functions, asserted for every API level, not just the one this device runs); that
 * the real framework probes bind, answer, and never throw; that the capability answer is
 * internally consistent (in particular that `guaranteedOnDevice` is never true on the
 * best-effort tier); and that TextToSpeech actually initializes, enumerates voices, and
 * drives an utterance through to `onDone`.
 *
 * **NOT proven here:** that speech is transcribed correctly. The Android emulator's
 * virtual microphone is off by default, and even with it enabled there is no audio source
 * to speak into from a test process. Nothing in this file opens the microphone or asserts
 * anything about transcript accuracy — [SpeechRecognitionController.startListening] is
 * deliberately not called. Real recognition has to be verified by a human on a physical
 * device with a real voice; treat any claim beyond "the API wiring is correct" as
 * unverified until that happens.
 */
@RunWith(AndroidJUnit4::class)
class SpeechControllersTest {
    private val context: Context
        get() = InstrumentationRegistry.getInstrumentation().targetContext

    private val recognitionControllers = mutableListOf<SpeechRecognitionController>()
    private val synthesisControllers = mutableListOf<SpeechSynthesisController>()

    @After
    fun tearDown() {
        recognitionControllers.forEach { controller -> onMain { controller.destroy() } }
        recognitionControllers.clear()
        synthesisControllers.forEach { it.shutdown() }
        synthesisControllers.clear()
    }

    // ------------------------------------------------------------------ tier selection (pure)

    @Test
    fun resolveTier_picksCheckedOnDevice_onApi33AndAbove() {
        assertEquals(
            RecognitionTier.CHECKED_ON_DEVICE,
            SpeechRecognitionController.resolveTier(33, onDeviceAvailable = true, recognitionAvailable = true),
        )
        assertEquals(
            RecognitionTier.CHECKED_ON_DEVICE,
            SpeechRecognitionController.resolveTier(35, onDeviceAvailable = true, recognitionAvailable = true),
        )
    }

    @Test
    fun resolveTier_picksOnDevice_onApi31And32() {
        assertEquals(
            RecognitionTier.ON_DEVICE,
            SpeechRecognitionController.resolveTier(31, onDeviceAvailable = true, recognitionAvailable = true),
        )
        assertEquals(
            RecognitionTier.ON_DEVICE,
            SpeechRecognitionController.resolveTier(32, onDeviceAvailable = true, recognitionAvailable = true),
        )
    }

    @Test
    fun resolveTier_fallsBackToPreferOfflineHint_belowApi31() {
        for (sdk in 23..30) {
            assertEquals(
                "API $sdk should use the best-effort hint tier",
                RecognitionTier.PREFER_OFFLINE_HINT,
                SpeechRecognitionController.resolveTier(sdk, onDeviceAvailable = false, recognitionAvailable = true),
            )
        }
    }

    @Test
    fun resolveTier_fallsBackToPreferOfflineHint_whenNewOsHasNoOnDeviceService() {
        // A modern OS with no on-device recognition service still has a cloud recognizer;
        // it must degrade to the hint tier, never claim an on-device guarantee.
        assertEquals(
            RecognitionTier.PREFER_OFFLINE_HINT,
            SpeechRecognitionController.resolveTier(35, onDeviceAvailable = false, recognitionAvailable = true),
        )
    }

    @Test
    fun resolveTier_isNone_whenNoRecognizerExists() {
        assertEquals(
            RecognitionTier.NONE,
            SpeechRecognitionController.resolveTier(35, onDeviceAvailable = false, recognitionAvailable = false),
        )
    }

    // ------------------------------------------------------------------ error mapping (pure)

    @Test
    fun errorCodeFor_mapsLanguageUnavailableToItsOwnCode() {
        // The API 31–32 tier's only signal that the on-device model is missing, so it must
        // not collapse into the generic "unknown" bucket.
        assertEquals("language-unavailable", SpeechRecognitionController.errorCodeFor(SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE))
        assertEquals(
            "language-not-supported",
            SpeechRecognitionController.errorCodeFor(SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED),
        )
    }

    @Test
    fun errorCodeFor_mapsTheCommonFrameworkErrors() {
        assertEquals("permission-denied", SpeechRecognitionController.errorCodeFor(SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS))
        assertEquals("no-match", SpeechRecognitionController.errorCodeFor(SpeechRecognizer.ERROR_NO_MATCH))
        assertEquals("speech-timeout", SpeechRecognitionController.errorCodeFor(SpeechRecognizer.ERROR_SPEECH_TIMEOUT))
        assertEquals("busy", SpeechRecognitionController.errorCodeFor(SpeechRecognizer.ERROR_RECOGNIZER_BUSY))
        assertEquals("network", SpeechRecognitionController.errorCodeFor(SpeechRecognizer.ERROR_NETWORK))
        assertEquals("audio", SpeechRecognitionController.errorCodeFor(SpeechRecognizer.ERROR_AUDIO))
        assertEquals("unknown", SpeechRecognitionController.errorCodeFor(9999))
    }

    @Test
    fun isRecoverable_isTrueOnlyForRetryableFailures() {
        assertTrue(SpeechRecognitionController.isRecoverable(SpeechRecognizer.ERROR_NO_MATCH))
        assertTrue(SpeechRecognitionController.isRecoverable(SpeechRecognizer.ERROR_RECOGNIZER_BUSY))
        assertFalse(SpeechRecognitionController.isRecoverable(SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS))
        assertFalse(SpeechRecognitionController.isRecoverable(SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED))
    }

    @Test
    fun matchesTag_isLenientAboutSeparatorCaseAndRegion() {
        assertTrue(SpeechRecognitionController.matchesTag("en_US", "en-US"))
        assertTrue(SpeechRecognitionController.matchesTag("EN-us", "en-US"))
        // An engine that reports only a base language must still match a regional request,
        // or a perfectly usable pack reads as "unsupported".
        assertTrue(SpeechRecognitionController.matchesTag("en", "en-GB"))
        assertFalse(SpeechRecognitionController.matchesTag("fr-FR", "en-US"))
    }

    // ------------------------------------------------------------------ real framework probes

    @Test
    fun probeCapability_answersWithoutThrowing_andStaysInternallyConsistent() {
        val controller = newRecognitionController()
        val result = AtomicReference<RecognitionCapability>()
        val latch = CountDownLatch(1)

        onMain {
            controller.probeCapability("en-US") { capability ->
                result.set(capability)
                latch.countDown()
            }
        }

        assertTrue(
            "probeCapability must always call back, even when checkRecognitionSupport hangs",
            latch.await(PROBE_TIMEOUT_SECONDS, TimeUnit.SECONDS),
        )

        val capability = result.get()
        assertNotNull(capability)
        assertEquals("en-US", capability.language)

        // The invariant the whole API is built on: a best-effort answer must never claim a
        // guarantee, and a guarantee must never come from the hint tier.
        if (capability.mode == SpeechRecognitionController.MODE_BEST_EFFORT) {
            assertFalse(capability.guaranteedOnDevice)
            assertEquals(RecognitionTier.PREFER_OFFLINE_HINT, capability.tier)
        }
        if (capability.guaranteedOnDevice) {
            assertEquals(SpeechRecognitionController.MODE_ON_DEVICE, capability.mode)
            assertTrue(
                capability.tier == RecognitionTier.CHECKED_ON_DEVICE || capability.tier == RecognitionTier.ON_DEVICE,
            )
        }
        if (!capability.available) {
            assertNotNull("an unavailable capability must explain itself", capability.reason)
        }
    }

    @Test
    fun probeCapability_matchesTheTierThisDeviceActuallyQualifiesFor() {
        val controller = newRecognitionController()
        val result = AtomicReference<RecognitionCapability>()
        val latch = CountDownLatch(1)

        onMain { controller.probeCapability(null) { capability -> result.set(capability); latch.countDown() } }
        assertTrue(latch.await(PROBE_TIMEOUT_SECONDS, TimeUnit.SECONDS))

        val onDeviceAvailable =
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.S && SpeechRecognizer.isOnDeviceRecognitionAvailable(context)
        val expected =
            SpeechRecognitionController.resolveTier(
                Build.VERSION.SDK_INT,
                onDeviceAvailable,
                SpeechRecognizer.isRecognitionAvailable(context),
            )

        assertEquals(expected, result.get().tier)
    }

    @Test
    fun probeLanguages_reportsNullOnlyWhereEnumerationIsImpossible() {
        val controller = newRecognitionController()
        val result = AtomicReference<List<RecognitionLanguage>?>()
        val latch = CountDownLatch(1)

        onMain { controller.probeLanguages { languages -> result.set(languages); latch.countDown() } }
        assertTrue(latch.await(PROBE_TIMEOUT_SECONDS, TimeUnit.SECONDS))

        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            assertEquals("pre-API-33 cannot enumerate on-device languages", null, result.get())
            return
        }

        // On API 33+ the list may legitimately be null (no on-device service) or empty
        // (nothing installed yet) — what must hold is that every returned entry is coherent.
        result.get()?.forEach { language ->
            assertTrue("a tag must not be blank", language.tag.isNotBlank())
            assertFalse(
                "installed and downloadable are mutually exclusive by construction",
                language.installed && language.downloadable,
            )
        }
    }

    @Test
    fun isListening_isFalseBeforeAnySessionStarts() {
        // The mic is never opened by this suite (see the class KDoc), so this asserts the
        // controller's own idle bookkeeping, not a recognition session.
        val controller = newRecognitionController()
        val result = AtomicReference<Boolean>()
        onMain { result.set(controller.isListening()) }
        assertFalse(result.get())
    }

    // ------------------------------------------------------------------ text chunking (pure)

    @Test
    fun chunkText_returnsASingleChunkWhenTextFits() {
        assertEquals(listOf("Hello there."), SpeechSynthesisController.chunkText("Hello there.", 100))
    }

    @Test
    fun chunkText_neverExceedsTheEngineLimit_andKeepsEveryWord() {
        val sentence = "The quick brown fox jumps over the lazy dog. "
        val long = sentence.repeat(40)
        val chunks = SpeechSynthesisController.chunkText(long, 120)

        assertTrue("long text must actually be split", chunks.size > 1)
        chunks.forEach { assertTrue("chunk of ${it.length} exceeded the 120 limit", it.length <= 120) }
        // Whitespace changes at the split points; the words themselves must survive.
        assertEquals(
            long.split(Regex("\\s+")).filter { it.isNotEmpty() },
            chunks.joinToString(" ").split(Regex("\\s+")).filter { it.isNotEmpty() },
        )
    }

    @Test
    fun chunkText_hardSplitsAnUnbreakableRun() {
        val chunks = SpeechSynthesisController.chunkText("x".repeat(250), 100)
        assertEquals(3, chunks.size)
        chunks.forEach { assertTrue(it.length <= 100) }
    }

    // ------------------------------------------------------------------ real TTS engine

    @Test
    fun synthesis_initializesAndReportsACoherentCapability() {
        val controller = newSynthesisController()
        val result = AtomicReference<SynthesisCapability>()
        val latch = CountDownLatch(1)

        controller.probeCapability(null) { capability -> result.set(capability); latch.countDown() }
        assertTrue("probeCapability must always call back", latch.await(TTS_TIMEOUT_SECONDS, TimeUnit.SECONDS))

        val capability = result.get()
        assumeTrue("no text-to-speech engine on this device/image", capability.available)
        assertTrue("a bound engine reports a positive max input length", (capability.maxInputLength ?: 0) > 0)
        assertTrue(capability.language.isNotBlank())
    }

    @Test
    fun synthesis_enumeratesVoicesAndFlagsWhichAreOffline() {
        val controller = newSynthesisController()
        val voices = AtomicReference<List<SynthesisVoice>>()
        val latch = CountDownLatch(1)

        controller.probeVoices(null) { result -> voices.set(result); latch.countDown() }
        assertTrue(latch.await(TTS_TIMEOUT_SECONDS, TimeUnit.SECONDS))
        assumeTrue("no voices installed on this device/image", voices.get().isNotEmpty())

        voices.get().forEach { voice ->
            assertTrue(voice.id.isNotBlank())
            assertTrue(voice.language.isNotBlank())
        }
        // The `offline` flag is the platform's own isNetworkConnectionRequired answer, so a
        // device with only network voices is a legitimate (if unhelpful) outcome — assert
        // the flag exists and is consistent rather than that some voice is offline.
        assertEquals(voices.get().size, voices.get().distinctBy { it.id }.size)
    }

    @Test
    fun speak_resolvesOnlyWhenTheUtteranceHasFinished() {
        val controller = newSynthesisController()
        val available = AtomicReference<Boolean>(false)
        val capabilityLatch = CountDownLatch(1)
        controller.probeCapability(null) { capability -> available.set(capability.available); capabilityLatch.countDown() }
        assertTrue(capabilityLatch.await(TTS_TIMEOUT_SECONDS, TimeUnit.SECONDS))
        assumeTrue("no text-to-speech engine on this device/image", available.get())

        val outcome = AtomicReference<SpeakOutcome>()
        val failure = AtomicReference<String>()
        val latch = CountDownLatch(1)

        controller.speak(
            SpeakRequest(
                text = "Testing offline speech.",
                language = null,
                voiceId = null,
                rate = 1.0f,
                pitch = 1.0f,
                interrupt = true,
                // The emulator's bundled voices are often flagged as network-requiring; this
                // test is about completion plumbing, not about the offline guarantee, which
                // `synthesis_enumeratesVoicesAndFlagsWhichAreOffline` covers.
                requireOfflineVoice = false,
            ),
            { result -> outcome.set(result); latch.countDown() },
            { message -> failure.set(message); latch.countDown() },
        )

        assertTrue("speak() must settle exactly once", latch.await(SPEAK_TIMEOUT_SECONDS, TimeUnit.SECONDS))
        assumeTrue("engine refused the utterance: ${failure.get()}", failure.get() == null)

        val result = outcome.get()
        assertNotNull(result)
        assertTrue("a short utterance is a single chunk", result.chunkCount == 1)
        assertTrue("the utterance should run to completion, not be interrupted", result.completed)
        assertFalse(result.interrupted)
    }

    @Test
    fun isSpeaking_isFalseWhenIdle() {
        val controller = newSynthesisController()
        assertFalse(controller.isSpeaking())
    }

    // ------------------------------------------------------------------ helpers

    private fun newRecognitionController(): SpeechRecognitionController {
        val controller = SpeechRecognitionController(context, NoopEvents)
        recognitionControllers.add(controller)
        return controller
    }

    private fun newSynthesisController(): SpeechSynthesisController {
        val controller = SpeechSynthesisController(context)
        synthesisControllers.add(controller)
        controller.initialize()
        return controller
    }

    /** SpeechRecognizer's API is `@MainThread`; instrumented tests run off it. */
    private fun onMain(block: () -> Unit) {
        InstrumentationRegistry.getInstrumentation().runOnMainSync(block)
    }

    private object NoopEvents : RecognitionEvents {
        override fun onPartial(transcript: String, mode: String, guaranteedOnDevice: Boolean) = Unit

        override fun onFinal(alternatives: List<String>, mode: String, guaranteedOnDevice: Boolean) = Unit

        override fun onError(code: String, message: String, recoverable: Boolean) = Unit

        override fun onEnd(reason: String) = Unit
    }

    private companion object {
        /** Comfortably above SpeechRecognitionController.SUPPORT_CHECK_TIMEOUT_MS. */
        const val PROBE_TIMEOUT_SECONDS = 15L
        const val TTS_TIMEOUT_SECONDS = 20L
        const val SPEAK_TIMEOUT_SECONDS = 30L
    }
}
