package com.companionintelligence.speech

import android.speech.SpeechRecognizer
import java.util.Locale
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * JVM unit tests for the decision logic inside [SpeechRecognitionController] — the parts that
 * are pure functions of their arguments and therefore provable for *every* API level and
 * *every* framework error code, rather than only for whatever the one attached device happens
 * to be.
 *
 * ## Why these run here and not in `androidTest`
 *
 * `src/androidTest/.../SpeechControllersTest.kt` needs a device because it binds real
 * recognition and text-to-speech services. Nothing in this file does: every symbol it touches
 * is either Kotlin (`resolveTier`, `matchesTag`, the [RecognitionTier] enum) or a
 * `static final` constant of the framework (`SpeechRecognizer.ERROR_*`), which the compiler
 * inlines, so no Android runtime is involved and no stubbed framework method is ever called.
 * Running them here means they execute on every `testDebugUnitTest`, not only when somebody
 * remembers to dispatch a `connectedAndroidTest` against an emulator.
 *
 * What is *not* here, deliberately: anything that needs a live `SpeechRecognizer`. Tier
 * dispatch inside `probeCapability`, the `RecognizerIntent` extras, the `onResults`/`onError`
 * end-reason contract and the `startListening` policy gate all sit behind a bound remote
 * service or a private method, and faking them would test the fake. They stay device-only
 * until the controller grows a seam for them.
 */
class SpeechRecognitionLogicTest {

    // ------------------------------------------------------------------ tier selection

    @Test
    fun tier_boundaries_between_the_three_implementations_are_exact() {
        // API 30 is the last release with no `createOnDeviceSpeechRecognizer`. Even if a
        // caller passed onDeviceAvailable = true here (the flag is meaningless below 31), the
        // tier must not claim a guarantee the platform cannot give.
        assertEquals(
            "API 30 has no on-device recognizer API at all",
            RecognitionTier.PREFER_OFFLINE_HINT,
            SpeechRecognitionController.resolveTier(30, onDeviceAvailable = true, recognitionAvailable = true),
        )
        assertEquals(
            "API 31 is the first release that can guarantee on-device recognition",
            RecognitionTier.ON_DEVICE,
            SpeechRecognitionController.resolveTier(31, onDeviceAvailable = true, recognitionAvailable = true),
        )
        assertEquals(
            RecognitionTier.ON_DEVICE,
            SpeechRecognitionController.resolveTier(32, onDeviceAvailable = true, recognitionAvailable = true),
        )
        assertEquals(
            "API 33 is the first release with checkRecognitionSupport()",
            RecognitionTier.CHECKED_ON_DEVICE,
            SpeechRecognitionController.resolveTier(33, onDeviceAvailable = true, recognitionAvailable = true),
        )
    }

    @Test
    fun a_device_with_no_on_device_service_never_reaches_an_on_device_tier() {
        // The case the emulator and most non-Google-app devices are actually in: a modern OS
        // whose only recognizer is the cloud one. It must degrade to the hint tier (so
        // `guaranteedOnDevice` stays false everywhere downstream), never to ON_DEVICE.
        for (sdk in 31..35) {
            assertEquals(
                "API $sdk without an on-device service must be best-effort only",
                RecognitionTier.PREFER_OFFLINE_HINT,
                SpeechRecognitionController.resolveTier(sdk, onDeviceAvailable = false, recognitionAvailable = true),
            )
            assertEquals(
                "API $sdk with no recognizer at all is unusable",
                RecognitionTier.NONE,
                SpeechRecognitionController.resolveTier(sdk, onDeviceAvailable = false, recognitionAvailable = false),
            )
        }
    }

    @Test
    fun an_on_device_service_outranks_the_generic_recognition_flag() {
        // `isRecognitionAvailable()` answers for the *default* recognition service and can be
        // false on a device that still has a usable on-device one. Ordering the `when` the
        // other way round would send those devices to NONE and disable speech entirely.
        assertEquals(
            RecognitionTier.CHECKED_ON_DEVICE,
            SpeechRecognitionController.resolveTier(35, onDeviceAvailable = true, recognitionAvailable = false),
        )
        assertEquals(
            RecognitionTier.ON_DEVICE,
            SpeechRecognitionController.resolveTier(31, onDeviceAvailable = true, recognitionAvailable = false),
        )
    }

    @Test
    fun tier_wire_values_are_the_strings_the_typescript_union_declares() {
        // These cross the bridge verbatim into `SpeechRecognitionTier` in src/definitions.ts.
        // Renaming one on either side does not break the build — it makes the JS `switch` fall
        // into its default branch at runtime, on a user's device.
        //
        // So the comparison is against the union as it is actually written, read off disk.
        // Restating the same four literals the enum declares would only catch an edit to the
        // Kotlin half, and the fix for that failure is to edit the test; the drift that
        // actually hurts — a rename in TypeScript alone — would sail past.
        val declared = speechRecognitionTierUnion(RepoFiles.read(SPEECH_DEFINITIONS))
        val wires = RecognitionTier.values().map { it.wire }

        for (wire in wires) {
            assertTrue(
                "RecognitionTier emits '$wire', which is not a member of SpeechRecognitionTier in " +
                    "$SPEECH_DEFINITIONS (declared: $declared). The JS switch on it falls through to its " +
                    "default branch.",
                declared.contains(wire),
            )
        }

        // And the reverse, for the members this platform owns: a tier added to the union but
        // never emitted here is a JS branch that can never be reached, which reads as dead code
        // rather than as a missing Kotlin arm.
        assertEquals(
            "the android-* members of SpeechRecognitionTier and RecognitionTier's wire values have drifted",
            declared.filter { it.startsWith("android-") }.toSet(),
            wires.filter { it.startsWith("android-") }.toSet(),
        )

        assertEquals("two tiers must never share a wire value", wires.size, wires.toSet().size)
    }

    // ------------------------------------------------------------------ error mapping

    @Test
    fun every_framework_error_the_mapper_knows_keeps_a_message_of_its_own() {
        // errorCodeFor() and describeError() are two `when` blocks coupled only by string
        // equality, so deleting an arm from one of them degrades silently: the code still
        // compiles and the user just gets "Speech recognition failed (code 13)." forever.
        //
        // ERROR_CANNOT_LISTEN_TO_DOWNLOAD_EVENTS (15, API 33) is deliberately absent from this
        // list: it is genuinely unmapped today and does fall through to the generic bucket.
        val mapped =
            listOf(
                SpeechRecognizer.ERROR_NETWORK_TIMEOUT,
                SpeechRecognizer.ERROR_NETWORK,
                SpeechRecognizer.ERROR_AUDIO,
                SpeechRecognizer.ERROR_SERVER,
                SpeechRecognizer.ERROR_CLIENT,
                SpeechRecognizer.ERROR_SPEECH_TIMEOUT,
                SpeechRecognizer.ERROR_NO_MATCH,
                SpeechRecognizer.ERROR_RECOGNIZER_BUSY,
                SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS,
                SpeechRecognizer.ERROR_TOO_MANY_REQUESTS,
                SpeechRecognizer.ERROR_SERVER_DISCONNECTED,
                SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED,
                SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE,
                SpeechRecognizer.ERROR_CANNOT_CHECK_SUPPORT,
            )

        for (error in mapped) {
            assertNotEquals(
                "framework error $error must map to a code of its own",
                "unknown",
                SpeechRecognitionController.errorCodeFor(error),
            )
            assertNotEquals(
                "framework error $error must not fall into the generic message bucket",
                "Speech recognition failed (code $error).",
                SpeechRecognitionController.describeError(error),
            )
        }

        // Fourteen framework codes collapse onto eleven user-facing ones (network/timeout,
        // server/disconnected and busy/too-many-requests each share a message). If that count
        // drops, two distinct failures started reading identically to the user.
        assertEquals(11, mapped.map { SpeechRecognitionController.describeError(it) }.toSet().size)

        // The pair that matters most on the API 31–32 tier: "the model is missing" is fixable
        // by a download, "the language is not supported" is not, and the UI branches on the
        // difference. They must never share wording.
        assertNotEquals(
            SpeechRecognitionController.describeError(SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE),
            SpeechRecognitionController.describeError(SpeechRecognizer.ERROR_LANGUAGE_NOT_SUPPORTED),
        )
    }

    @Test
    fun an_unmapped_error_falls_through_to_a_message_carrying_the_raw_code() {
        // The generic arm exists so a code from a newer platform than this build knows about
        // still reaches a bug report as something actionable, rather than as "unknown".
        assertEquals("unknown", SpeechRecognitionController.errorCodeFor(4242))
        assertEquals("Speech recognition failed (code 4242).", SpeechRecognitionController.describeError(4242))
    }

    @Test
    fun only_transient_failures_are_marked_recoverable() {
        // A network *timeout* may well pass on the next attempt; a hard network error will
        // not, and retrying it just burns battery behind a spinner.
        assertTrue(SpeechRecognitionController.isRecoverable(SpeechRecognizer.ERROR_NETWORK_TIMEOUT))
        assertFalse(SpeechRecognitionController.isRecoverable(SpeechRecognizer.ERROR_NETWORK))

        // A rate limit clears by itself.
        assertTrue(SpeechRecognitionController.isRecoverable(SpeechRecognizer.ERROR_TOO_MANY_REQUESTS))

        // These two need a *user action* (grant the permission, download the model). Marking
        // either recoverable turns the retry path into an infinite loop.
        assertFalse(SpeechRecognitionController.isRecoverable(SpeechRecognizer.ERROR_INSUFFICIENT_PERMISSIONS))
        assertFalse(SpeechRecognitionController.isRecoverable(SpeechRecognizer.ERROR_LANGUAGE_UNAVAILABLE))
    }

    // ------------------------------------------------------------------ tag matching

    @Test
    fun tag_matching_case_folds_independently_of_the_device_locale() {
        // This is why both sides are lowercased with Locale.ROOT rather than the device
        // locale: Turkish maps 'I' to the dotless 'ı', so a locale-sensitive fold would make
        // matchesTag("IT-IT", "it-IT") false and every installed Italian pack read as
        // unsupported — but only for users whose phone is set to Turkish.
        //
        // (Kotlin's no-argument String.lowercase() is already ROOT-based; the mutation this
        // guards against is someone "simplifying" it to lowercase(Locale.getDefault()).)
        val original = Locale.getDefault()
        try {
            Locale.setDefault(Locale.forLanguageTag("tr"))
            assertTrue(SpeechRecognitionController.matchesTag("IT-IT", "it-IT"))
            assertTrue(SpeechRecognitionController.matchesTag("TR_tr", "tr-TR"))
        } finally {
            Locale.setDefault(original)
        }
    }

    @Test
    fun tag_matching_is_lenient_about_region_but_never_about_the_base_language() {
        // An engine may report only a base language for a regional request, in either
        // direction, and both must match or a perfectly usable pack reads as unsupported.
        assertTrue(SpeechRecognitionController.matchesTag("en", "en-GB"))
        assertTrue(SpeechRecognitionController.matchesTag("en-GB", "en"))
        assertTrue(SpeechRecognitionController.matchesTag("en-US", "en-GB"))

        // Leniency stops at the base language. A shared *region* is not a match — comparing
        // the wrong half of the tag would hand a German request an English model.
        assertFalse(SpeechRecognitionController.matchesTag("de-US", "en-US"))
        assertFalse(SpeechRecognitionController.matchesTag("es", "en-US"))
    }

    private companion object {
        const val SPEECH_DEFINITIONS = "frontend/packages/capacitor-speech/src/definitions.ts"

        /**
         * The quoted members of `export type SpeechRecognitionTier = 'a' | 'b' | ...;`.
         *
         * Read with a regex rather than a TypeScript parser on purpose — the alternative is
         * running `tsc` from a Gradle unit test — and the extraction fails loudly rather than
         * returning an empty set, so a reformat of the union cannot quietly turn the tests
         * above into no-ops.
         */
        fun speechRecognitionTierUnion(definitions: String): Set<String> {
            val start = definitions.indexOf("export type SpeechRecognitionTier")
            check(start >= 0) { "SpeechRecognitionTier is gone from $SPEECH_DEFINITIONS" }
            val end = definitions.indexOf(';', start)
            check(end >= 0) { "the SpeechRecognitionTier declaration in $SPEECH_DEFINITIONS is unterminated" }

            val members = Regex("""'([^']+)'""")
                .findAll(definitions.substring(start, end))
                .map { it.groupValues[1] }
                .toSet()
            check(members.isNotEmpty()) { "read no members out of SpeechRecognitionTier in $SPEECH_DEFINITIONS" }
            return members
        }
    }
}
