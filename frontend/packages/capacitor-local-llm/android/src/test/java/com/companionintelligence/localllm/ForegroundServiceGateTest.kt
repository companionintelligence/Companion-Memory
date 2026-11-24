package com.companionintelligence.localllm

import java.util.concurrent.atomic.AtomicInteger
import kotlin.concurrent.thread
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ForegroundServiceGateTest {

    private class Recorder(private val failStarts: Int = 0, private val failStop: Boolean = false) {
        val starts = AtomicInteger(0)
        val startAttempts = AtomicInteger(0)
        val stops = AtomicInteger(0)
        val failures = mutableListOf<Throwable>()

        fun gate() =
            ForegroundServiceGate(
                start = {
                    if (startAttempts.incrementAndGet() <= failStarts) {
                        throw IllegalStateException("startForegroundService() not allowed due to mAllowStartForeground false")
                    }
                    starts.incrementAndGet()
                },
                stop = {
                    stops.incrementAndGet()
                    if (failStop) throw RuntimeException("stopService failed")
                },
                onFailure = { synchronized(failures) { failures += it } },
            )
    }

    @Test
    fun the_service_starts_for_the_first_lease_and_stops_after_the_last() {
        val r = Recorder()
        val gate = r.gate()

        val a = gate.acquire()
        val b = gate.acquire()
        assertEquals("one service for two overlapping generations", 1, r.starts.get())
        assertEquals(2, gate.activeLeases())

        a.release()
        assertEquals("still running for the second", 0, r.stops.get())
        b.release()
        assertEquals(1, r.stops.get())
        assertEquals(0, gate.activeLeases())
    }

    @Test
    fun a_refused_start_never_escapes_and_never_leaks_the_count() {
        // The bug: the start ran outside the try, its exception escaped the coroutine (killing the process) with
        // the counter already incremented and no release to follow.
        val r = Recorder(failStarts = 1)
        val gate = r.gate()

        val lease = gate.acquire() // must not throw

        assertEquals(1, gate.activeLeases())
        assertEquals(1, r.failures.size)
        lease.release()
        assertEquals("balanced", 0, gate.activeLeases())
        assertEquals("nothing was running, so there is nothing to stop", 0, r.stops.get())
    }

    @Test
    fun a_start_that_was_refused_is_retried_by_the_next_lease_while_nothing_runs() {
        val r = Recorder(failStarts = 1)
        val gate = r.gate()

        gate.acquire().release() // refused
        val second = gate.acquire() // the app is foregrounded now

        assertEquals(1, r.starts.get())
        second.release()
        assertEquals(1, r.stops.get())
    }

    @Test
    fun releasing_twice_releases_once() {
        val r = Recorder()
        val gate = r.gate()
        val a = gate.acquire()
        val b = gate.acquire()

        a.release()
        a.release()
        a.release()

        assertEquals("b still holds the service", 1, gate.activeLeases())
        assertEquals(0, r.stops.get())
        b.release()
        assertEquals(1, r.stops.get())
    }

    @Test
    fun a_failing_stop_is_swallowed_and_reported() {
        val r = Recorder(failStop = true)
        val gate = r.gate()

        gate.acquire().release() // must not throw

        assertEquals(1, r.stops.get())
        assertEquals(1, r.failures.size)
        assertEquals(0, gate.activeLeases())
    }

    @Test
    fun concurrent_leases_balance_and_start_and_stop_pair_up() {
        val r = Recorder()
        val gate = r.gate()

        (1..8).map { thread { repeat(500) { gate.acquire().release() } } }.forEach { it.join(30_000) }

        assertEquals(0, gate.activeLeases())
        assertEquals("every start is matched by a stop", r.starts.get(), r.stops.get())
        assertTrue(r.starts.get() >= 1)
        assertFalse(r.failures.isNotEmpty())
    }
}
