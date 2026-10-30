package com.companionintelligence.localllm

/**
 * Orders the start and stop of [LocalLlmGenerationService] so a stop can never land between
 * `startForegroundService()` and the service's own `startForeground()`.
 *
 * Android holds the app to a promise the moment `startForegroundService()` is called: the service
 * WILL call `startForeground()`. A `stopService()` that arrives first -- a generation that answered or
 * failed within milliseconds, which a back-to-back test run does routinely -- tears the service down
 * "while still waiting for start foreground", and the framework then throws
 * `ForegroundServiceDidNotStartInTimeException` into the process. Fatal, and on a device it took the
 * whole app down mid-batch.
 *
 * So a stop is a request, not an act: it is carried out by whichever side runs second. If the service
 * has already entered the foreground, the stop is immediate; if not, it is remembered and the service
 * stops itself right after `startForeground()`, having kept the promise. Pure, so a JVM test can drive
 * every interleaving.
 */
class GenerationServiceState {
    private val lock = Any()
    private var foreground = false
    private var stopRequested = false

    /** A new generation wants the service: clears any stop that was pending for an earlier one. */
    fun starting() = synchronized(lock) { stopRequested = false }

    /**
     * The last generation finished. Returns true when the caller must `stopService()` now; false when the
     * service has not entered the foreground yet and will stop itself once it has.
     */
    fun stopRequested(): Boolean =
        synchronized(lock) {
            stopRequested = true
            if (foreground) {
                foreground = false
                true
            } else {
                false
            }
        }

    /**
     * The service has called `startForeground()`. Returns true when a stop arrived in the meantime and the
     * service must `stopSelf()` now; false when it should keep running.
     */
    fun enteredForeground(): Boolean =
        synchronized(lock) {
            if (stopRequested) {
                foreground = false
                true
            } else {
                foreground = true
                false
            }
        }

    /** The service is gone (destroyed, or refused the foreground): nothing to stop any more. */
    fun ended() = synchronized(lock) { foreground = false }
}
