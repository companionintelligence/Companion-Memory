package com.companionintelligence.speech

import android.speech.tts.Voice
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * JVM unit tests for the pure decision logic inside [SpeechSynthesisController]: the chunker
 * that keeps a long answer inside `TextToSpeech.getMaxSpeechInputLength()`, and the voice
 * quality label.
 *
 * The chunker is worth this much attention because it is the only part of synthesis that runs
 * before the engine sees anything, it is where an LLM-length answer either keeps its prosody
 * or gets sliced mid-word, and — see [an_all_whitespace_input_produces_no_chunks_at_all] — it
 * is one guard away from stranding a JS promise forever.
 *
 * Everything else in that controller (init queueing, utterance settlement, voice selection)
 * needs a bound `TextToSpeech` service and stays in `src/androidTest`.
 */
class SpeechSynthesisLogicTest {

    // ------------------------------------------------------------------ chunking

    @Test
    fun a_sentence_ending_past_the_midpoint_becomes_the_cut_and_keeps_its_terminator() {
        // The '.' sits at index 35 of a 50-character window, comfortably past limit / 2, so it
        // is preferred over the later word boundary — and the cut is placed *after* it, so the
        // period stays with the sentence it terminates instead of opening the next utterance.
        val chunks =
            SpeechSynthesisController.chunkText(
                "Alpha beta gamma delta epsilon zeta. Tail words here to overflow.",
                50,
            )

        assertEquals(2, chunks.size)
        assertEquals("Alpha beta gamma delta epsilon zeta.", chunks[0])
        assertEquals("Tail words here to overflow.", chunks[1])
    }

    @Test
    fun a_sentence_ending_before_the_midpoint_is_ignored_in_favour_of_the_last_space() {
        // "Hi." ends a sentence at index 2. Cutting there would emit a three-character
        // utterance where a forty-eight-character one fits, roughly doubling the number of
        // utterances the engine has to queue for the same text — which is exactly what the
        // `it > limit / 2` guard exists to prevent.
        val chunks = SpeechSynthesisController.chunkText("Hi. " + "word ".repeat(20), 50)

        assertEquals(3, chunks.size)
        assertEquals("Hi. " + "word ".repeat(8) + "word", chunks[0])
        assertTrue("the early terminator must not shrink the first chunk", chunks[0].length > 25)
    }

    @Test
    fun a_newline_counts_as_a_sentence_ending() {
        // Model output is full of hard line breaks and no other punctuation (lists, headings).
        // Without '\n' in the terminator set those all fall back to the last space, which cuts
        // across the line break and runs two list items together in one breath.
        val chunks = SpeechSynthesisController.chunkText("First line of text goes right here\n" + "tail ".repeat(10), 50)

        assertEquals(2, chunks.size)
        assertEquals("First line of text goes right here", chunks[0])
    }

    @Test
    fun chunking_never_drops_a_character_and_never_exceeds_the_limit() {
        // The invariant that matters at every awkward limit: the engine's hard cap is
        // respected, nothing is silently swallowed at a cut point, and no empty utterance is
        // queued. Whitespace is allowed to change — that is what trim()/trimStart() are for.
        val texts =
            listOf(
                "The quick brown fox jumps over the lazy dog. It sat.",
                "one.two.three.four.five.six.seven.eight.nine.ten",
                "x".repeat(137),
                "Line one\nLine two\nLine three\n" + "z".repeat(60),
                "Mixed! Punctuation? Everywhere. ".repeat(6),
            )

        for (text in texts) {
            for (limit in listOf(1, 2, 3, 7, 16, 41, 100)) {
                val chunks = SpeechSynthesisController.chunkText(text, limit)

                assertTrue("non-blank text must always produce something to speak", chunks.isNotEmpty())
                for (chunk in chunks) {
                    assertTrue("an empty utterance would settle nothing", chunk.isNotBlank())
                    assertTrue("chunk of ${chunk.length} exceeded the limit of $limit", chunk.length <= limit)
                }
                assertEquals(
                    "characters were lost at a cut point (limit $limit)",
                    text.filterNot { it.isWhitespace() },
                    chunks.joinToString("").filterNot { it.isWhitespace() },
                )
            }
        }
    }

    @Test
    fun an_all_whitespace_input_produces_no_chunks_at_all() {
        // This is why speak() rejects blank text *before* it gets here. With no chunks,
        // `lastId` would index -1, the pending entry would be keyed to an utterance id no
        // callback can ever produce, and the JS promise would hang forever. Keep the guard in
        // speak(), or make this case impossible here — not neither.
        assertTrue(SpeechSynthesisController.chunkText("   \n  ", 2).isEmpty())
    }

    @Test(timeout = 10_000L)
    fun a_non_positive_engine_limit_falls_back_to_the_default_max_input_length() {
        // Some engines report 0 (or throw and leave the caller with a default int) from
        // getMaxSpeechInputLength(). Treating that as the real limit would divide the text at
        // index 0 forever, so the fallback is load-bearing — hence the timeout on this test.
        assertEquals(1, SpeechSynthesisController.chunkText("word ".repeat(200).trim(), 0).size)

        val chunks = SpeechSynthesisController.chunkText("y".repeat(4001), -1)
        assertEquals(2, chunks.size)
        assertEquals(4000, chunks[0].length)
    }

    // ------------------------------------------------------------------ voice quality

    @Test
    fun voice_quality_labels_use_inclusive_boundaries() {
        // Android's scale is 100 (very low) to 500 (very high) in steps of 100. Asserted
        // through the named constants rather than the literals so the test still means the
        // same thing if AOSP ever renumbers them.
        assertEquals("low", SpeechSynthesisController.qualityLabel(Voice.QUALITY_VERY_LOW))
        assertEquals(
            "a voice reporting exactly QUALITY_LOW is low, not normal",
            "low",
            SpeechSynthesisController.qualityLabel(Voice.QUALITY_LOW),
        )
        assertEquals("normal", SpeechSynthesisController.qualityLabel(Voice.QUALITY_LOW + 1))
        assertEquals("normal", SpeechSynthesisController.qualityLabel(Voice.QUALITY_NORMAL))
        assertEquals("normal", SpeechSynthesisController.qualityLabel(Voice.QUALITY_HIGH - 1))
        assertEquals(
            "a voice reporting exactly QUALITY_HIGH is high, not normal",
            "high",
            SpeechSynthesisController.qualityLabel(Voice.QUALITY_HIGH),
        )
        assertEquals("high", SpeechSynthesisController.qualityLabel(Voice.QUALITY_VERY_HIGH))
    }
}
