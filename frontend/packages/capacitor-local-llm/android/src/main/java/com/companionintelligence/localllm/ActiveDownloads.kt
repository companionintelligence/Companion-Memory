package com.companionintelligence.localllm

import java.util.concurrent.TimeUnit
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/**
 * Which model downloads have a [ModelDownloadWorker] *actually running* in this process right now.
 *
 * WorkManager reports a cancelled worker as CANCELLED at once, but the worker's coroutine may still be
 * mid-read; deleting its `.part` on that signal is a guess (the code used to sleep 600 ms and hope). This
 * is the real signal: the worker registers in `doWork` and unregisters in its `finally`, and
 * [awaitIdle] waits for that — bounded, because a stalled socket must not hang a Delete button.
 */
class ActiveDownloads {
    private val lock = ReentrantLock()
    private val changed = lock.newCondition()
    private val counts = HashMap<String, Int>()

    fun begin(modelId: String) {
        lock.withLock { counts[modelId] = (counts[modelId] ?: 0) + 1 }
    }

    fun end(modelId: String) {
        lock.withLock {
            val remaining = (counts[modelId] ?: 0) - 1
            if (remaining > 0) counts[modelId] = remaining else counts.remove(modelId)
            changed.signalAll()
        }
    }

    fun isActive(modelId: String): Boolean = lock.withLock { (counts[modelId] ?: 0) > 0 }

    /** Waits until no worker is running for [modelId]; false if [timeoutMs] passed first. */
    fun awaitIdle(modelId: String, timeoutMs: Long): Boolean =
        lock.withLock {
            var remainingNs = TimeUnit.MILLISECONDS.toNanos(timeoutMs)
            while ((counts[modelId] ?: 0) > 0) {
                if (remainingNs <= 0) return@withLock false
                remainingNs = changed.awaitNanos(remainingNs)
            }
            true
        }
}
