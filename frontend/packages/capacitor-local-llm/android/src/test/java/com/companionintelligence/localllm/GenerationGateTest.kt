package com.companionintelligence.localllm

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import kotlin.concurrent.thread
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertTrue
import org.junit.Test

/** The admission gate is pure JVM, so its awkward interleavings are ordinary tests. */
class GenerationGateTest {

    private fun message(block: () -> Unit): String {
        try {
            block()
        } catch (e: IllegalStateException) {
            return e.message ?: ""
        }
        throw AssertionError("expected an IllegalStateException")
    }

    @Test
    fun a_second_generation_is_refused_while_one_runs() {
        val gate = GenerationGate()
        gate.begin(graceMs = 1_000)

        val started = System.nanoTime()
        val error = message { gate.begin(graceMs = 5_000) }

        assertTrue(error, error.contains("already in progress"))
        // Refused at once: nothing was asked to stop, so there is nothing to wait for.
        assertTrue("waited ${(System.nanoTime() - started) / 1_000_000}ms", System.nanoTime() - started < 1_000_000_000L)
        assertTrue(gate.inFlight)
    }

    @Test
    fun a_generation_started_just_after_a_stop_waits_for_the_stopped_one_to_end() {
        val gate = GenerationGate()
        val first = gate.begin(1_000)
        gate.requestCancel()
        thread {
            Thread.sleep(150)
            gate.end(first)
        }

        val second = gate.begin(graceMs = 5_000)

        assertNotSame(first, second)
        assertTrue(gate.inFlight)
    }

    @Test
    fun a_generation_that_never_acknowledges_its_stop_is_waited_for_only_so_long() {
        val gate = GenerationGate()
        gate.begin(1_000)
        gate.requestCancel()

        val error = message { gate.begin(graceMs = 100) }

        assertTrue(error, error.contains("still stopping"))
        assertTrue("the stuck generation still holds the gate until someone forces it", gate.inFlight)
    }

    @Test
    fun ending_is_idempotent_and_a_stale_ticket_never_frees_a_newer_generation() {
        val gate = GenerationGate()
        val first = gate.begin(1_000)
        assertTrue(gate.end(first))
        assertFalse("already ended", gate.end(first))

        val second = gate.begin(1_000)
        assertFalse("the first ticket is stale and must not free the second generation", gate.end(first))
        assertTrue(gate.inFlight)
        assertTrue(gate.end(second))
        assertFalse(gate.inFlight)
    }

    @Test
    fun a_stop_with_nothing_running_does_not_poison_the_next_generation() {
        val gate = GenerationGate()
        gate.requestCancel()

        val ticket = gate.begin(1_000)

        assertFalse("a stop requested before this generation is not for it", gate.isCancelRequested(ticket))
        // ...and so a second concurrent begin is refused immediately, not held for the grace period.
        val started = System.nanoTime()
        message { gate.begin(graceMs = 5_000) }
        assertTrue(System.nanoTime() - started < 1_000_000_000L)
    }

    @Test
    fun a_stop_is_visible_to_the_generation_it_was_for() {
        val gate = GenerationGate()
        val ticket = gate.begin(1_000)
        assertFalse(gate.isCancelRequested(ticket))

        gate.requestCancel()

        assertTrue(gate.isCancelRequested(ticket))
        gate.end(ticket)
        assertTrue("a generation that is no longer current counts as stopped", gate.isCancelRequested(ticket))
    }

    // ---- exclusive operations ---------------------------------------------------------------

    @Test
    fun an_exclusive_operation_stops_a_running_generation_and_runs_once_it_has_ended() {
        val gate = GenerationGate()
        val ticket = gate.begin(1_000)
        val order = mutableListOf<String>()

        val result =
            gate.exclusively(
                timeoutMs = 5_000,
                force = false,
                stop = {
                    order += "stop"
                    // The runtime acknowledges the stop from its own thread, a moment later.
                    thread {
                        Thread.sleep(100)
                        gate.end(ticket)
                    }
                },
                block = {
                    order += "block"
                    42
                },
            )

        assertEquals(42, result)
        assertEquals(listOf("stop", "block"), order)
        assertFalse(gate.inFlight)
    }

    @Test
    fun a_forced_exclusive_operation_abandons_a_generation_that_never_answers() {
        val gate = GenerationGate()
        val stuck = gate.begin(1_000)
        var ran = false

        gate.exclusively(timeoutMs = 100, force = true, stop = {}) { ran = true }

        assertTrue(ran)
        assertFalse("the abandoned generation no longer holds the gate", gate.inFlight)
        assertTrue(gate.isCancelRequested(stuck))

        // The lock-out this used to cause: a callback that never fires left every later generation refused
        // ("previous generation is still stopping") until the process was restarted.
        val next = gate.begin(graceMs = 100)
        assertTrue(gate.inFlight)

        // ...and when the abandoned generation's callback finally does fire, it is a no-op: it must not clear
        // the flag that now belongs to `next`, or two generations would run at once.
        assertFalse(gate.end(stuck))
        assertTrue(gate.inFlight)
        message { gate.begin(graceMs = 50) }
        assertTrue(gate.end(next))
    }

    @Test
    fun an_unforced_exclusive_operation_gives_up_and_changes_nothing() {
        val gate = GenerationGate()
        val ticket = gate.begin(1_000)
        var ran = false

        val error = message { gate.exclusively(timeoutMs = 100, force = false, stop = {}) { ran = true } }

        assertTrue(error, error.contains("did not stop in time"))
        assertFalse("the block must not run while a generation may still be decoding", ran)
        assertTrue(gate.inFlight)
        assertTrue(gate.end(ticket))
    }

    @Test
    fun no_generation_can_start_while_an_exclusive_operation_runs() {
        val gate = GenerationGate()
        val inside = CountDownLatch(1)
        val release = CountDownLatch(1)
        val op = thread { gate.exclusively(5_000, force = false, stop = {}) { inside.countDown(); release.await(10, TimeUnit.SECONDS) } }
        assertTrue(inside.await(5, TimeUnit.SECONDS))

        val error = message { gate.begin(graceMs = 100) }
        assertTrue(error, error.contains("busy"))

        // A begin that arrives with more patience is admitted the moment the operation finishes.
        val admitted = AtomicReference<GenerationGate.Ticket?>(null)
        val waiter = thread { admitted.set(gate.begin(graceMs = 10_000)) }
        Thread.sleep(100)
        assertTrue(admitted.get() == null)
        release.countDown()
        op.join(5_000)
        waiter.join(5_000)
        assertTrue(admitted.get() != null)
    }

    @Test
    fun the_gate_admits_at_most_one_generation_under_contention() {
        val gate = GenerationGate()
        val concurrent = java.util.concurrent.atomic.AtomicInteger(0)
        val maxConcurrent = java.util.concurrent.atomic.AtomicInteger(0)
        val overlapped = AtomicBoolean(false)
        val threads =
            (1..8).map {
                thread {
                    repeat(200) {
                        val ticket =
                            try {
                                gate.begin(graceMs = 0)
                            } catch (e: IllegalStateException) {
                                return@repeat
                            }
                        val now = concurrent.incrementAndGet()
                        maxConcurrent.accumulateAndGet(now) { a, b -> maxOf(a, b) }
                        if (now > 1) overlapped.set(true)
                        concurrent.decrementAndGet()
                        gate.end(ticket)
                    }
                }
            }
        threads.forEach { it.join(20_000) }

        assertFalse("two generations held the gate at once (max ${maxConcurrent.get()})", overlapped.get())
        assertFalse(gate.inFlight)
    }
}
