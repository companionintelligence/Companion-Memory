package com.companionintelligence.localllm

import java.util.concurrent.TimeUnit
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/**
 * Admission control for generations on one engine: at most one runs at a time, and a lifecycle
 * operation (load, reset, unload) can take the engine **exclusively** — cancelling whatever is running
 * and waiting for it to acknowledge.
 *
 * Pure JVM (no Android, no LiteRT-LM), so the interleavings — a late callback, a callback that never
 * comes, a forced unload — are ordinary unit tests.
 *
 * **Why every generation holds a [Ticket].** A generation ends when the runtime's callback says so, and
 * a forced lifecycle operation cannot wait for that forever. Without an identity, the two failure modes
 * both hurt: if the callback never fires the gate stays "in flight" and every later generation is
 * refused until the process dies; and if it fires late it would clear the flag belonging to a *newer*
 * generation and let two run at once. So a forced operation **abandons** the running generation (the
 * gate is free again), and the abandoned generation's late [end] is a no-op because its ticket is no
 * longer the current one.
 */
class GenerationGate {

    /** Identifies one generation. Only [end]ing the *current* ticket changes the gate. */
    class Ticket internal constructor(internal val id: Long)

    private val lock = ReentrantLock()
    private val changed = lock.newCondition()
    private var nextId = 0L
    private var current: Ticket? = null
    private var cancelRequested = false
    private var exclusive = false

    /** True while a generation holds the gate. */
    val inFlight: Boolean get() = lock.withLock { current != null }

    /**
     * Admits a generation. If one is already running this throws — unless a stop was requested for it
     * (or an exclusive operation holds the gate), in which case it waits up to [graceMs] for that to
     * finish, since "Stop" immediately followed by "send" is an ordinary sequence.
     */
    fun begin(graceMs: Long): Ticket =
        lock.withLock {
            var remainingNs = TimeUnit.MILLISECONDS.toNanos(graceMs)
            while (exclusive || current != null) {
                if (!exclusive && !cancelRequested) {
                    throw IllegalStateException("A generation is already in progress; cancel it before starting another")
                }
                if (remainingNs <= 0) {
                    throw IllegalStateException(
                        if (exclusive) {
                            "The model is busy (loading or resetting); try again in a moment"
                        } else {
                            "The previous generation is still stopping; try again in a moment"
                        },
                    )
                }
                remainingNs = changed.awaitNanos(remainingNs)
            }
            val ticket = Ticket(++nextId)
            current = ticket
            cancelRequested = false
            ticket
        }

    /**
     * Releases the gate if [ticket] is still the current generation. Returns false — and changes
     * nothing — for a ticket that was already ended or abandoned, so a late callback is harmless.
     */
    fun end(ticket: Ticket): Boolean =
        lock.withLock {
            if (current !== ticket) return@withLock false
            current = null
            cancelRequested = false
            changed.signalAll()
            true
        }

    /** Marks the running generation as asked to stop. A no-op when nothing is running. */
    fun requestCancel() {
        lock.withLock {
            if (current != null) cancelRequested = true
        }
    }

    /** True if a stop was requested for [ticket]'s generation, or it was abandoned. */
    fun isCancelRequested(ticket: Ticket): Boolean = lock.withLock { current !== ticket || cancelRequested }

    /**
     * Runs [block] with no generation running and none able to start. A generation in flight is asked to
     * stop ([stop] is called with the gate held) and given [timeoutMs] to [end]. If it has not: with
     * [force] the generation is **abandoned** — the gate is cleared, its ticket goes stale — and [block]
     * runs anyway; without it this throws and [block] never runs.
     */
    fun <T> exclusively(timeoutMs: Long, force: Boolean, stop: () -> Unit, block: () -> T): T {
        lock.withLock {
            if (current != null) {
                cancelRequested = true
                stop()
                var remainingNs = TimeUnit.MILLISECONDS.toNanos(timeoutMs)
                while (current != null && remainingNs > 0) {
                    remainingNs = changed.awaitNanos(remainingNs)
                }
                if (current != null) {
                    if (!force) {
                        throw IllegalStateException("The running generation did not stop in time; cancel it and try again")
                    }
                    current = null
                    cancelRequested = false
                }
            }
            exclusive = true
        }
        try {
            return block()
        } finally {
            lock.withLock {
                exclusive = false
                changed.signalAll()
            }
        }
    }
}
