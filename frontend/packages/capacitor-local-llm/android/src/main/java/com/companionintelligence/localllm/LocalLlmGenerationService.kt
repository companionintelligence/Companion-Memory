package com.companionintelligence.localllm

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat

private const val NOTIFICATION_CHANNEL_ID = "local_llm_generation"
private const val NOTIFICATION_ID = 91_002

/**
 * Foreground-service wrapper around an in-flight `generate()`/`generateStream()` call —
 * the generation counterpart to `ModelDownloadWorker`'s foreground download notification.
 *
 * Before this, nothing protected an in-flight generation from being killed if the app was
 * briefly backgrounded mid-answer (only the model *download* had this protection). A plain
 * started (non-WorkManager) `Service` is used rather than another `CoroutineWorker` because
 * `generate()`/`generateStream()` are driven directly from `LocalLlmPlugin`'s Capacitor call
 * handlers — a WorkManager job doesn't fit that direct call/callback/streaming shape.
 *
 * This service does no work of its own: the actual generation lives in `LocalLlmPlugin`'s
 * `pluginScope`. It exists only so the process holds `startForeground()` priority for the
 * duration, via [start]/[stop] called around each generate call.
 */
class LocalLlmGenerationService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        ensureNotificationChannel()

        val notification =
            NotificationCompat.Builder(this, NOTIFICATION_CHANNEL_ID)
                .setContentTitle("Companion is thinking")
                .setContentText("Generating an on-device reply")
                .setSmallIcon(android.R.drawable.ic_menu_info_details)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .build()

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }

        // Not START_STICKY: if the OS kills the process, there is no in-flight generation left
        // to protect — LocalLlmPlugin's coroutine died with it, and there is nothing to resume.
        return START_NOT_STICKY
    }

    private fun ensureNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return

        val manager = getSystemService(NotificationManager::class.java) ?: return
        if (manager.getNotificationChannel(NOTIFICATION_CHANNEL_ID) == null) {
            manager.createNotificationChannel(
                NotificationChannel(NOTIFICATION_CHANNEL_ID, "On-device generation", NotificationManager.IMPORTANCE_LOW),
            )
        }
    }

    companion object {
        /** Starts protecting an in-flight generation. Safe to call even if already running. */
        fun start(context: Context) {
            ContextCompat.startForegroundService(context, Intent(context, LocalLlmGenerationService::class.java))
        }

        /** Ends the protection once generation completes, errors, or is cancelled. */
        fun stop(context: Context) {
            context.stopService(Intent(context, LocalLlmGenerationService::class.java))
        }
    }
}
