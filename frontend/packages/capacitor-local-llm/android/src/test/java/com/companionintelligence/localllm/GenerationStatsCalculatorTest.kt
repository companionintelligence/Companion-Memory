package com.companionintelligence.localllm

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** The stats arithmetic is pure, so every branch — including the ones a phone rarely reaches — is testable here. */
class GenerationStatsCalculatorTest {

    private val ms = 1_000_000L

    private fun compute(
        firstAtMs: Long?,
        endAtMs: Long,
        chunks: Int,
        runtime: RuntimeDecodeStats? = null,
        startAtMs: Long = 0,
    ) =
        GenerationStatsCalculator.compute(
            startNs = startAtMs * ms,
            firstTokenNs = firstAtMs?.let { it * ms },
            endNs = endAtMs * ms,
            streamedChunks = chunks,
            runtime = runtime,
        )

    @Test
    fun without_runtime_numbers_the_count_is_the_streamed_chunks_and_is_marked_estimated() {
        // 51 chunks: the first at 200 ms, the last at 1200 ms. Fifty decoded after the first, in 1 s.
        val stats = compute(firstAtMs = 200, endAtMs = 1_200, chunks = 51)

        assertEquals(200L, stats.timeToFirstTokenMs)
        assertEquals(1_200L, stats.totalMs)
        assertEquals(51, stats.outputTokens)
        assertEquals(50.0, stats.decodeTokensPerSecond, 1e-9)
        assertTrue(stats.tokensEstimated)
    }

    @Test
    fun the_request_time_is_the_zero_point_not_the_process_clock() {
        // Same shape as above, but the whole thing happens a long way into the clock's range.
        val stats = compute(startAtMs = 9_000_000, firstAtMs = 9_000_200, endAtMs = 9_001_200, chunks = 51)

        assertEquals(200L, stats.timeToFirstTokenMs)
        assertEquals(1_200L, stats.totalMs)
        assertEquals(50.0, stats.decodeTokensPerSecond, 1e-9)
    }

    @Test
    fun the_runtimes_own_count_and_speed_are_used_verbatim_and_not_marked_estimated() {
        // 60 decode tokens at 42.5 tok/s from the runtime; 55 chunks streamed (a few markup tokens
        // never surface as a chunk). Timings still come from the wall clock.
        val stats = compute(firstAtMs = 300, endAtMs = 2_000, chunks = 55, runtime = RuntimeDecodeStats(60, 42.5))

        assertEquals(60, stats.outputTokens)
        assertEquals(42.5, stats.decodeTokensPerSecond, 0.0)
        assertFalse(stats.tokensEstimated)
        assertEquals(300L, stats.timeToFirstTokenMs)
        assertEquals(2_000L, stats.totalMs)
    }

    @Test
    fun a_runtime_count_below_the_streamed_chunks_describes_only_the_last_decode_and_is_ignored() {
        // A turn that called a tool decodes twice, and getBenchmarkInfo() reports just the last round.
        // Each token yields at most one chunk, so 90 chunks against a reported 30 tokens cannot be one round.
        val stats = compute(firstAtMs = 100, endAtMs = 1_100, chunks = 90, runtime = RuntimeDecodeStats(30, 55.0))

        assertTrue(stats.tokensEstimated)
        assertEquals(90, stats.outputTokens)
        assertEquals(89.0, stats.decodeTokensPerSecond, 1e-9)
    }

    @Test
    fun an_unusable_runtime_report_falls_back_to_the_estimate() {
        for (runtime in
            listOf(
                RuntimeDecodeStats(0, 40.0),
                RuntimeDecodeStats(-1, 40.0),
                RuntimeDecodeStats(50, 0.0),
                RuntimeDecodeStats(50, -3.0),
                RuntimeDecodeStats(50, Double.NaN),
                RuntimeDecodeStats(50, Double.POSITIVE_INFINITY),
            )) {
            val stats = compute(firstAtMs = 100, endAtMs = 1_100, chunks = 41, runtime = runtime)
            assertTrue("$runtime should not have been trusted", stats.tokensEstimated)
            assertEquals(41, stats.outputTokens)
            assertEquals(40.0, stats.decodeTokensPerSecond, 1e-9)
        }
    }

    @Test
    fun a_generation_that_produced_nothing_reports_the_whole_wait_as_time_to_first_token() {
        val stats = compute(firstAtMs = null, endAtMs = 750, chunks = 0)

        assertEquals(750L, stats.timeToFirstTokenMs)
        assertEquals(750L, stats.totalMs)
        assertEquals(0, stats.outputTokens)
        assertEquals(0.0, stats.decodeTokensPerSecond, 0.0)
        assertTrue(stats.tokensEstimated)
    }

    @Test
    fun a_single_token_has_no_decode_phase_so_the_rate_is_zero_rather_than_invented() {
        val stats = compute(firstAtMs = 400, endAtMs = 400, chunks = 1)

        assertEquals(1, stats.outputTokens)
        assertEquals(0.0, stats.decodeTokensPerSecond, 0.0)
    }

    @Test
    fun many_tokens_arriving_in_the_same_instant_do_not_divide_by_zero() {
        // First token and last token in the same millisecond (a buffered burst).
        val stats = compute(firstAtMs = 500, endAtMs = 500, chunks = 12)

        assertEquals(12, stats.outputTokens)
        assertEquals(0.0, stats.decodeTokensPerSecond, 0.0)
        assertFalse(stats.decodeTokensPerSecond.isNaN() || stats.decodeTokensPerSecond.isInfinite())
    }

    @Test
    fun sub_millisecond_differences_truncate_and_time_never_goes_backwards() {
        val tiny = GenerationStatsCalculator.compute(0L, 900_000L, 1_900_000L, 3, null)
        assertEquals(0L, tiny.timeToFirstTokenMs)
        assertEquals(1L, tiny.totalMs)

        // An end before the start (a clock that stepped) is 0 ms, not negative.
        val skewed = GenerationStatsCalculator.compute(5_000L * ms, 5_100L * ms, 4_000L * ms, 2, null)
        assertEquals(0L, skewed.totalMs)
        assertEquals("ttft cannot exceed the total", 0L, skewed.timeToFirstTokenMs)
    }

    @Test
    fun time_to_first_token_is_clamped_to_the_total() {
        val stats = compute(firstAtMs = 2_000, endAtMs = 1_000, chunks = 2)

        assertEquals(1_000L, stats.totalMs)
        assertEquals(1_000L, stats.timeToFirstTokenMs)
    }
}
