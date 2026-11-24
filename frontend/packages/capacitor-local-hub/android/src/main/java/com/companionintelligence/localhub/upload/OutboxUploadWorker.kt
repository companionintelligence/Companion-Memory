package com.companionintelligence.localhub.upload

import android.content.Context
import android.content.SharedPreferences
import android.util.Log
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import com.companionintelligence.localhub.CompanionSecureStore
import com.companionintelligence.localhub.OutboxStores
import com.companionintelligence.localhub.location.LocationTracking
import java.util.concurrent.TimeUnit

/**
 * The person's choice in Settings -> Location, kept natively because the job that honours it
 * runs with no WebView. On unless they turned it off.
 */
object BackgroundUploadSettings {
    private const val PREFERENCES = "ci_local_hub_upload"
    private const val KEY_ENABLED = "enabled"
    private const val KEY_FINISH_OWED = "finishOwed"

    internal fun preferences(context: Context): SharedPreferences =
        context.applicationContext.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)

    fun isEnabled(context: Context): Boolean = preferences(context).getBoolean(KEY_ENABLED, true)

    fun setEnabled(context: Context, enabled: Boolean) {
        preferences(context).edit().putBoolean(KEY_ENABLED, enabled).commit()
        if (enabled) {
            OutboxUploadWorker.schedule(context, delayMinutes = 0)
        } else {
            OutboxUploadWorker.cancel(context)
        }
    }

    internal fun finishDebt(context: Context): IngestFinishDebt = object : IngestFinishDebt {
        override fun isOwed(): Boolean = preferences(context).getBoolean(KEY_FINISH_OWED, false)
        override fun setOwed(owed: Boolean) {
            preferences(context).edit().putBoolean(KEY_FINISH_OWED, owed).commit()
        }
    }
}

/**
 * Uploads queued location fixes while the app is closed, so a trip reaches the appliance
 * without the person opening the app first. Scheduled by the location tracker after each
 * queued fix and when the phone comes to rest; runs only with a network; retries with backoff
 * while the appliance is out of reach.
 *
 * Unique work with KEEP: the fixes of a drive schedule one run, not one per fix, and the
 * initial delay batches a couple of minutes of fixes into it. A fix queued while a run is in
 * progress is still picked up, because [OutboxUploader] re-lists until the queue is empty.
 *
 * Where to send comes from the tracker's saved config (the origin the app was using when it
 * last armed Always); the key comes from the encrypted credential store the app signs in
 * with. Without either -- Always off, signed out, or an install whose config predates the
 * origin field -- the run does nothing and the next app open uploads as before.
 */
class OutboxUploadWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
    override fun doWork(): Result {
        val context = applicationContext
        if (!BackgroundUploadSettings.isEnabled(context)) {
            return Result.success()
        }
        val origin = LocationTracking.get(context).snapshot()?.config?.apiBaseUrl
        if (origin.isNullOrBlank()) {
            return Result.success()
        }
        val outcome = try {
            val apiKey = CompanionSecureStore.credentials(context).get(API_KEY)
            if (apiKey.isNullOrEmpty()) {
                return Result.success()
            }
            OutboxUploader(
                outbox = OutboxStores.shared(context),
                transport = HttpUploadTransport(),
                finishDebt = BackgroundUploadSettings.finishDebt(context),
            ).drain(origin, apiKey)
        } catch (e: Exception) {
            // Keystore or database not usable yet (before the first unlock after a reboot).
            OutboxUploader.Outcome.RetryLater(0, e.message ?: e.javaClass.simpleName)
        }
        return when (outcome) {
            is OutboxUploader.Outcome.Done -> {
                if (outcome.sent > 0) Log.i(TAG, "uploaded ${outcome.sent} queued fixes")
                Result.success()
            }
            is OutboxUploader.Outcome.RetryLater -> {
                Log.i(TAG, "uploaded ${outcome.sent}, retrying later: ${outcome.reason}")
                // Gives up after the backoff has covered several hours; the next queued fix
                // or app open starts over.
                if (runAttemptCount < MAX_ATTEMPTS) Result.retry() else Result.success()
            }
        }
    }

    companion object {
        private const val TAG = "OutboxUpload"
        private const val WORK_NAME = "ci-outbox-upload"
        /** `API_KEY_STORAGE` in the web app's `useAuth.ts`. */
        private const val API_KEY = "ci.apiKey"
        private const val MAX_ATTEMPTS = 10
        const val DEFAULT_DELAY_MINUTES = 2L

        fun schedule(context: Context, delayMinutes: Long = DEFAULT_DELAY_MINUTES) {
            if (!BackgroundUploadSettings.isEnabled(context)) {
                return
            }
            val request = OneTimeWorkRequestBuilder<OutboxUploadWorker>()
                .setInitialDelay(delayMinutes, TimeUnit.MINUTES)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 1, TimeUnit.MINUTES)
                .build()
            WorkManager.getInstance(context.applicationContext)
                .enqueueUniqueWork(WORK_NAME, ExistingWorkPolicy.KEEP, request)
        }

        fun cancel(context: Context) {
            WorkManager.getInstance(context.applicationContext).cancelUniqueWork(WORK_NAME)
        }
    }
}
