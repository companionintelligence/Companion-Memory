package com.companionintelligence.localllm

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import kotlin.concurrent.thread
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

/**
 * The parts of [LocalLlmEngine] that need no native library: what a finished or stopped generation
 * reports, how resources are released, and that model deletion goes through the engine's own lock.
 */
@RunWith(RobolectricTestRunner::class)
class LocalLlmEngineContractTest {

    private val stats = GenerationStats(timeToFirstTokenMs = 120, totalMs = 900, outputTokens = 40, decodeTokensPerSecond = 51.2, tokensEstimated = false)

    // ---- a stopped generation never carries stats --------------------------------------------------

    @Test
    fun a_cancelled_completion_cannot_be_built_with_stats() {
        try {
            LocalLlmEngine.Completion("partial", "", stats, cancelled = true)
            throw AssertionError("expected the invariant to reject stats on a cancelled completion")
        } catch (expected: IllegalArgumentException) {
            assertTrue(expected.message!!, expected.message!!.contains("no stats"))
        }
    }

    @Test
    fun a_stop_that_lands_as_the_runtime_reports_done_is_still_a_stop() {
        // Thermal cutoff, the stop button, or a lifecycle call, arriving as the last token does: the text may be
        // cut short, and speed figures for it would tell JS the generation ran to completion.
        val stopped = LocalLlmEngine.Completion.finished("cut off", "reasoning", stats, stopRequested = true)

        assertTrue(stopped.cancelled)
        assertNull(stopped.stats)
        assertEquals("cut off", stopped.text)
        assertEquals("reasoning", stopped.thought)

        val complete = LocalLlmEngine.Completion.finished("all of it", "", stats, stopRequested = false)
        assertFalse(complete.cancelled)
        assertSame(stats, complete.stats)
    }

    @Test
    fun the_terminal_stream_event_carries_stats_only_for_a_completed_generation() {
        val completed = LocalLlmEngine.StreamEvent.terminal(LocalLlmEngine.Completion("done", "", stats, cancelled = false))
        assertTrue(completed.done)
        assertEquals("", completed.partial)
        assertNull(completed.thought)
        assertSame(stats, completed.stats)

        val stopped = LocalLlmEngine.StreamEvent.terminal(LocalLlmEngine.Completion.cancelled("half", ""))
        assertTrue("still terminal", stopped.done)
        assertNull("no stats: JS reads their absence as 'cancelled'", stopped.stats)

        // And the thermal / lifecycle route, which arrives as `finished(stopRequested = true)`.
        assertNull(LocalLlmEngine.StreamEvent.terminal(LocalLlmEngine.Completion.finished("x", "", stats, stopRequested = true)).stats)
    }

    // ---- the reuse key ------------------------------------------------------------------------------

    @Test
    fun the_window_a_tools_result_budget_comes_from_is_part_of_what_decides_whether_a_load_is_reused() {
        // loadModel builds the intent tools — and with them each tool's result budget, from maxTokens — only when
        // the resident model cannot be reused, and reuse is decided by LoadSpec equality. So a load with another
        // window must be another spec, or its tools would keep the old window's budget.
        val spec =
            LocalLlmEngine.LoadSpec(
                info = LocalLlmModels.GEMMA_4_E2B_IT,
                modelPath = "/models/qwen3.litertlm",
                maxTokens = 1024,
                topK = 64,
                topP = 0.95,
                temperature = 1.0,
                accelerator = LocalLlmAccelerator.CPU,
                enableSpeculativeDecoding = false,
                toolsGeneration = 0,
            )

        assertEquals("the same load again is reusable", spec, spec.copy())
        assertNotEquals(spec, spec.copy(maxTokens = 4096))
        assertNotEquals(LocalLlmPolicy.toolResultByteBudget(spec.maxTokens), LocalLlmPolicy.toolResultByteBudget(4096))
        assertNotEquals("a reconfigured appliance is another spec too", spec, spec.copy(toolsGeneration = 1))
    }

    // ---- releasing resources ----------------------------------------------------------------------

    private class Resource(private val log: MutableList<String>, private val name: String, private val fail: Boolean = false) : AutoCloseable {
        override fun close() {
            log += name
            if (fail) throw IllegalStateException("$name failed to close")
        }
    }

    @Test
    fun a_conversation_is_closed_before_the_engine_it_belongs_to() {
        val log = mutableListOf<String>()

        closeQuietlyInOrder(Resource(log, "conversation"), Resource(log, "engine"))

        assertEquals(listOf("conversation", "engine"), log)
    }

    @Test
    fun a_resource_that_fails_to_close_does_not_stop_the_ones_after_it() {
        val log = mutableListOf<String>()

        // The GPU-probe failure path: the probed conversation is closed, and the engine must be closed even if
        // closing the conversation throws — and a null (nothing was open) is simply skipped.
        closeQuietlyInOrder(Resource(log, "conversation", fail = true), null, Resource(log, "engine"))

        assertEquals(listOf("conversation", "engine"), log)
    }

    // ---- deleting a model goes through the engine's lock ---------------------------------------------

    @Test
    fun deleting_a_model_runs_its_block_and_returns_its_value_when_nothing_is_loaded() {
        val engine = LocalLlmEngine(RuntimeEnvironment.getApplication())

        assertEquals("deleted", engine.withModelUnloaded("gemma-4-e2b-it") { "deleted" })
    }

    @Test
    fun deleting_a_model_waits_for_a_load_in_progress_because_it_takes_the_engines_own_lock() {
        // load() holds the engine's monitor for its whole duration (Engine.initialize() can take minutes on a
        // GPU) while the resident model is not yet published — so checking loadedModel() sees nothing and the
        // file used to be deleted under the load. Holding the same monitor here stands in for that load.
        val engine = LocalLlmEngine(RuntimeEnvironment.getApplication())
        val loading = CountDownLatch(1)
        val finishLoad = CountDownLatch(1)
        val loader = thread { synchronized(engine) { loading.countDown(); finishLoad.await(10, TimeUnit.SECONDS) } }
        assertTrue(loading.await(5, TimeUnit.SECONDS))

        val deleted = AtomicBoolean(false)
        val deleter = thread { engine.withModelUnloaded("gemma-4-e2b-it") { deleted.set(true) } }
        Thread.sleep(300)
        assertFalse("the delete must wait for the load", deleted.get())

        finishLoad.countDown()
        loader.join(5_000)
        deleter.join(5_000)
        assertTrue(deleted.get())
    }

    @Test
    fun an_exception_from_the_delete_block_propagates() {
        val engine = LocalLlmEngine(RuntimeEnvironment.getApplication())
        try {
            engine.withModelUnloaded("gemma-4-e2b-it") { throw IllegalStateException("disk error") }
            throw AssertionError("expected propagation")
        } catch (e: IllegalStateException) {
            assertEquals("disk error", e.message)
        }
    }
}
