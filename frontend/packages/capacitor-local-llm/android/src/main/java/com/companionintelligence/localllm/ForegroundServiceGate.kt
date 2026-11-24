package com.companionintelligence.localllm

import java.util.concurrent.atomic.AtomicBoolean

/**
 * Reference-counts the callers that want a foreground service running, starting it for the first and
 * stopping it after the last — and treats the service as **best effort**.
 *
 * Starting a foreground service can be refused: from the background on API 31+ it throws
 * `ForegroundServiceStartNotAllowedException`, and earlier releases throw `IllegalStateException` for a
 * background app. The service only protects a generation from being killed when the app is briefly
 * backgrounded; a generation that cannot get one still works. So a failed [start] is swallowed here
 * (and retried by the next [acquire] while nothing is running), never allowed to escape into a caller
 * that has already committed to a generation — which is what used to kill the process, leave the JS
 * promise unsettled and leak the count.
 *
 * Each [acquire] returns a [Lease] whose [Lease.release] is idempotent, so a `finally` block can call it
 * unconditionally and the count still balances exactly once per lease on every path.
 */
class ForegroundServiceGate(
    private val start: () -> Unit,
    private val stop: () -> Unit,
    private val onFailure: (Throwable) -> Unit = {},
) {
    private val lock = Any()
    private var leases = 0
    private var running = false

    inner class Lease internal constructor() {
        private val released = AtomicBoolean(false)

        fun release() {
            if (!released.compareAndSet(false, true)) return
            synchronized(lock) {
                leases--
                if (leases == 0 && running) {
                    running = false
                    try {
                        stop()
                    } catch (e: Exception) {
                        onFailure(e)
                    }
                }
            }
        }
    }

    /** Never throws. */
    fun acquire(): Lease {
        synchronized(lock) {
            leases++
            if (!running) {
                try {
                    start()
                    running = true
                } catch (e: Exception) {
                    // Not allowed to start it (backgrounded, throttled…): carry on without one.
                    onFailure(e)
                }
            }
        }
        return Lease()
    }

    /** Leases currently held — for tests and diagnostics. */
    fun activeLeases(): Int = synchronized(lock) { leases }
}
