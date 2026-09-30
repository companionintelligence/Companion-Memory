package com.companionintelligence.localllm

/**
 * Decode-speed numbers for one completed generation — the Kotlin form of `GenerationStats` in
 * `src/definitions.ts`.
 */
data class GenerationStats(
    /** Milliseconds from the request until the first token arrived. */
    val timeToFirstTokenMs: Long,
    /** Milliseconds from the request until the last token. */
    val totalMs: Long,
    val outputTokens: Int,
    /** Tokens per second across the decode phase (after the first token); 0 when undefined. */
    val decodeTokensPerSecond: Double,
    /** True when [outputTokens] counts streamed chunks because the runtime gave no usable count. */
    val tokensEstimated: Boolean,
)

/** What LiteRT-LM's own `Conversation.getBenchmarkInfo()` reported for the last decode, if it did. */
data class RuntimeDecodeStats(val decodeTokenCount: Int, val decodeTokensPerSecond: Double)

/**
 * Turns the timestamps and counts an engine collects during one generation into
 * [GenerationStats]. Pure — no clock, no Android — so every branch is a JUnit test rather than
 * something that needs a phone.
 *
 * **Which token count wins.** LiteRT-LM can report its own decode figures, but only for the *last*
 * decode round: a turn that called a tool decodes at least twice and the runtime describes just the
 * final round. Streamed chunks give a count for the whole turn but undercount tokens whenever the
 * runtime buffers a partial token or a markup marker. Each token yields at most one chunk, so
 * `chunks <= tokens` always holds for a turn with one round; when it does not
 * (`chunks > runtimeTokens`) the runtime figure is provably describing only part of the turn and is
 * ignored in favour of the estimate.
 */
object GenerationStatsCalculator {
    private const val NANOS_PER_MILLI = 1_000_000L

    /**
     * @param startNs when the request was made (`System.nanoTime()` domain — only differences matter)
     * @param firstTokenNs when the first non-empty chunk (answer or reasoning) arrived; null if none did
     * @param endNs when the generation finished
     * @param streamedChunks non-empty chunks received, answer and reasoning combined
     * @param runtime the runtime's own figures for the last decode, or null when unavailable
     */
    fun compute(
        startNs: Long,
        firstTokenNs: Long?,
        endNs: Long,
        streamedChunks: Int,
        runtime: RuntimeDecodeStats?,
    ): GenerationStats {
        val totalMs = millisBetween(startNs, endNs)
        // No token ever arrived (an empty completion): the whole wait was "time to first token".
        val ttftMs = if (firstTokenNs == null) totalMs else millisBetween(startNs, firstTokenNs).coerceAtMost(totalMs)

        val usable =
            runtime?.takeIf {
                it.decodeTokenCount > 0 &&
                    it.decodeTokensPerSecond > 0.0 &&
                    it.decodeTokensPerSecond.isFinite() &&
                    streamedChunks <= it.decodeTokenCount
            }
        if (usable != null) {
            return GenerationStats(
                timeToFirstTokenMs = ttftMs,
                totalMs = totalMs,
                outputTokens = usable.decodeTokenCount,
                decodeTokensPerSecond = usable.decodeTokensPerSecond,
                tokensEstimated = false,
            )
        }

        // The first token ends the prefill phase; only the tokens after it were decoded in the
        // interval that follows. One token (or none) leaves nothing to divide, so the rate is 0
        // rather than a made-up figure.
        val decodeMs = totalMs - ttftMs
        val decodeTokens = streamedChunks - 1
        val tokensPerSecond = if (decodeTokens > 0 && decodeMs > 0) decodeTokens * 1000.0 / decodeMs else 0.0
        return GenerationStats(
            timeToFirstTokenMs = ttftMs,
            totalMs = totalMs,
            outputTokens = streamedChunks,
            decodeTokensPerSecond = tokensPerSecond,
            tokensEstimated = true,
        )
    }

    private fun millisBetween(fromNs: Long, toNs: Long): Long = ((toNs - fromNs) / NANOS_PER_MILLI).coerceAtLeast(0L)
}
