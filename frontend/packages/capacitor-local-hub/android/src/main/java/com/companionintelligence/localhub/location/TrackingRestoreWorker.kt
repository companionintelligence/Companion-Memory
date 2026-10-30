package com.companionintelligence.localhub.location

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * The retry behind [TrackingRestoreReceiver]: a restore that failed (typically Play Services
 * not yet up at boot) is tried again a minute later, backing off, a few times. Unique work,
 * so a boot and a package-replaced broadcast close together schedule one retry, not two.
 * A restore that fails because the background grant lapsed fails every attempt too; the
 * tracker has already posted its nudge by then, and the attempts are cheap.
 */
class TrackingRestoreWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
    override fun doWork(): Result {
        val done = CountDownLatch(1)
        var restored = false
        LocationTracking.get(applicationContext).restore { outcome ->
            restored = outcome
            done.countDown()
        }
        done.await(RESTORE_TIMEOUT_SECONDS, TimeUnit.SECONDS)
        return when {
            restored -> Result.success()
            runAttemptCount < MAX_ATTEMPTS -> Result.retry()
            else -> Result.failure()
        }
    }

    companion object {
        private const val WORK_NAME = "ci-location-restore"
        private const val RESTORE_TIMEOUT_SECONDS = 30L
        private const val MAX_ATTEMPTS = 5

        fun schedule(context: Context) {
            val request = OneTimeWorkRequestBuilder<TrackingRestoreWorker>()
                .setInitialDelay(1, TimeUnit.MINUTES)
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 1, TimeUnit.MINUTES)
                .build()
            WorkManager.getInstance(context.applicationContext)
                .enqueueUniqueWork(WORK_NAME, ExistingWorkPolicy.KEEP, request)
        }
    }
}
