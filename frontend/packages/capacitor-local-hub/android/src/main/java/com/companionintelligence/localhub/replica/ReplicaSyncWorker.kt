package com.companionintelligence.localhub.replica

import android.content.Context
import android.util.Log
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import com.companionintelligence.localhub.CompanionSecureStore
import java.time.Instant
import java.time.temporal.ChronoUnit
import java.util.concurrent.TimeUnit

/**
 * Brings the phone's PowerSync replica up to date while the app is closed, so the copy is
 * current when it next opens -- offline search included -- instead of catching up then.
 *
 * Every [PERIOD_MINUTES] (Android may stretch that while the phone is idle), with a network and
 * not on low battery. A run does nothing while the app holds the replica ([ReplicaSyncGate]),
 * before the app has handed over a config, once the user signed out (no API key), or when the
 * app has local writes still to upload; otherwise [ReplicaSyncRunner] syncs to the first complete
 * checkpoint, within [RUN_BUDGET_MS]. A failed run is not retried early: the next period is soon
 * enough, and the app catches up on open regardless.
 */
class ReplicaSyncWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
    override fun doWork(): Result {
        val context = applicationContext
        val config = ReplicaSyncConfigStore(context).load() ?: return Result.success()
        if (!ReplicaSyncGate.tryBeginBackgroundRun()) {
            Log.i(TAG, "skipped: the app holds the replica")
            return Result.success()
        }
        val started = System.currentTimeMillis()
        try {
            val apiKey = CompanionSecureStore.credentials(context).get(API_KEY)
            if (apiKey.isNullOrEmpty()) return Result.success()
            val cutoff = Instant.now().minus(config.lookbackDays.toLong(), ChronoUnit.DAYS).toString()
            val outcome = ReplicaSyncRunner(
                transport = HttpReplicaTransport(config.apiBaseUrl, apiKey, cutoff),
                openCore = { AndroidReplicaCore.open(context, config.databaseFile) },
                startOptions = config.startOptions,
            ).run(
                deadlineMs = started + RUN_BUDGET_MS,
                isCancelled = { ReplicaSyncGate.isCancelled || isStopped },
                onStreamOpen = { stream -> ReplicaSyncGate.onCancel { stream.close() } },
            )
            Log.i(TAG, "$outcome in ${System.currentTimeMillis() - started} ms")
        } catch (e: Exception) {
            // Also how a cancelled run usually ends: closing its stream fails the read.
            Log.i(TAG, "run ended: ${e.javaClass.simpleName}: ${e.message}")
        } finally {
            ReplicaSyncGate.endBackgroundRun()
        }
        return Result.success()
    }

    companion object {
        private const val TAG = "ReplicaSync"
        private const val PERIODIC_WORK = "ci-replica-background-sync"
        private const val ONE_OFF_WORK = "ci-replica-background-sync-now"
        /** `API_KEY_STORAGE` in the web app's `useAuth.ts`. */
        private const val API_KEY = "ci.apiKey"
        const val PERIOD_MINUTES = 30L
        /** Well inside WorkManager's ten-minute limit; a catch-up normally takes seconds. */
        const val RUN_BUDGET_MS = 4L * 60L * 1000L

        private fun constraints() = Constraints.Builder()
            .setRequiredNetworkType(NetworkType.CONNECTED)
            .setRequiresBatteryNotLow(true)
            .build()

        fun schedule(context: Context) {
            val request = PeriodicWorkRequestBuilder<ReplicaSyncWorker>(PERIOD_MINUTES, TimeUnit.MINUTES)
                .setConstraints(constraints())
                .build()
            WorkManager.getInstance(context.applicationContext)
                .enqueueUniquePeriodicWork(PERIODIC_WORK, ExistingPeriodicWorkPolicy.KEEP, request)
        }

        /** One run as soon as the constraints allow; for testing on a device. */
        fun runOnce(context: Context) {
            val request = OneTimeWorkRequestBuilder<ReplicaSyncWorker>().setConstraints(constraints()).build()
            WorkManager.getInstance(context.applicationContext)
                .enqueueUniqueWork(ONE_OFF_WORK, ExistingWorkPolicy.REPLACE, request)
        }

        fun cancel(context: Context) {
            val workManager = WorkManager.getInstance(context.applicationContext)
            workManager.cancelUniqueWork(PERIODIC_WORK)
            workManager.cancelUniqueWork(ONE_OFF_WORK)
        }
    }
}
