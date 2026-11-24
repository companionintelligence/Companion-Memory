package com.companionintelligence.localhub.replica

/**
 * Who may sync the replica right now: the app's own client (while the app holds it) or the
 * background job (otherwise). Never both: each drives its own copy of the core's sync state
 * against the one file, and two interleaved iterations would race each other's checkpoints.
 *
 * The app claims the replica before it connects and releases it once it has disconnected
 * (backgrounded) or when its activity goes away. A claim stops a background run in progress --
 * it closes the run's stream, so a run waiting on the network ends at once -- and waits for it
 * to finish. Process-wide and in memory on purpose: a process that died took the WebView and
 * its client with it, so a fresh process correctly starts unclaimed.
 */
object ReplicaSyncGate {
    private val lock = Object()
    private var appHolds = false
    private var running = false
    @Volatile
    private var cancelRequested = false
    private var cancelHook: (() -> Unit)? = null

    /** The app takes the replica. Returns once no background run is in progress, or after [timeoutMs]. */
    fun claimForApp(timeoutMs: Long): Boolean = synchronized(lock) {
        appHolds = true
        if (running) {
            cancelRequested = true
            runCatching { cancelHook?.invoke() }
            val until = System.currentTimeMillis() + timeoutMs
            while (running) {
                val left = until - System.currentTimeMillis()
                if (left <= 0) break
                lock.wait(left)
            }
        }
        !running
    }

    fun releaseFromApp() = synchronized(lock) {
        appHolds = false
    }

    val appHoldsReplica: Boolean
        get() = synchronized(lock) { appHolds }

    /** A background run asks to start; false while the app holds the replica or another run is going. */
    fun tryBeginBackgroundRun(): Boolean = synchronized(lock) {
        if (appHolds || running) return false
        running = true
        cancelRequested = false
        cancelHook = null
        true
    }

    /** How a run is stopped from another thread; set once its stream is open. */
    fun onCancel(hook: () -> Unit) = synchronized(lock) {
        cancelHook = hook
        if (cancelRequested) runCatching { hook() }
    }

    val isCancelled: Boolean
        get() = cancelRequested

    fun endBackgroundRun() = synchronized(lock) {
        running = false
        cancelRequested = false
        cancelHook = null
        lock.notifyAll()
    }
}
