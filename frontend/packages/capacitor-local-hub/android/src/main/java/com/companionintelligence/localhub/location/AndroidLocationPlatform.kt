package com.companionintelligence.localhub.location

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat

/**
 * [LocationPlatform] on the device: [LocationService] for the GPS itself and one ordinary
 * notification for the resume nudge.
 *
 * Failures here are logged, not thrown: a refused service start or a notification
 * permission the person withdrew must not take the plugin call, or a broadcast receiver,
 * down with it.
 */
class AndroidLocationPlatform(context: Context) : LocationPlatform {
    private val app = context.applicationContext

    override fun startSampling(config: LocationTrackingConfig): Boolean {
        val intent = Intent(app, LocationService::class.java)
            .putExtra(LocationService.EXTRA_TITLE, config.notificationTitle)
            .putExtra(LocationService.EXTRA_TEXT, config.notificationText)
        return try {
            ContextCompat.startForegroundService(app, intent)
            true
        } catch (e: Exception) {
            // ForegroundServiceStartNotAllowedException (API 31+): the start came from
            // somewhere Android does not exempt -- seen on a device when the app was launched
            // behind the lock screen (uid state TOP_SLEEPING). onAppResumed retries later.
            Log.w(TAG, "location service not started: ${e.message}")
            false
        }
    }

    override fun stopSampling() {
        app.stopService(Intent(app, LocationService::class.java))
    }

    override fun isSamplingRunning(): Boolean = LocationService.isRunning

    override fun showResumeNudge(config: LocationTrackingConfig, reason: SamplingLossReason) {
        val manager = NotificationManagerCompat.from(app)
        if (!manager.areNotificationsEnabled()) {
            // POST_NOTIFICATIONS was refused or withdrawn: nothing can be shown. The person
            // turned Always on knowing the OS requires a notification for it, so this is the
            // one case where a reboot silently pauses recording until the next app open.
            Log.w(TAG, "notifications disabled; cannot ask the person to resume location recording")
            return
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            (app.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).createNotificationChannel(
                NotificationChannel(NUDGE_CHANNEL_ID, "Location recording paused", NotificationManager.IMPORTANCE_DEFAULT).apply {
                    setShowBadge(false)
                },
            )
        }
        val launch = app.packageManager.getLaunchIntentForPackage(app.packageName) ?: return
        val tap = PendingIntent.getActivity(
            app,
            REQUEST_NUDGE_TAP,
            launch,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )
        val text = when (reason) {
            SamplingLossReason.REBOOT -> "Your phone restarted. Open Companion to keep recording your location."
            SamplingLossReason.APP_UPDATE -> "Companion was updated. Open it to keep recording your location."
            SamplingLossReason.PROCESS_DEATH -> "Android stopped Companion in the background. Open it to keep recording your location."
        }
        val notification = NotificationCompat.Builder(app, NUDGE_CHANNEL_ID)
            .setContentTitle(config.notificationTitle.ifBlank { LocationTrackingConfig.DEFAULT_NOTIFICATION_TITLE } + " paused")
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setSmallIcon(app.applicationInfo.icon)
            .setContentIntent(tap)
            .setAutoCancel(true)
            .setOnlyAlertOnce(true)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setCategory(NotificationCompat.CATEGORY_STATUS)
            .build()
        try {
            manager.notify(NUDGE_NOTIFICATION_ID, notification)
        } catch (e: SecurityException) {
            Log.w(TAG, "could not post the resume nudge: ${e.message}")
        }
    }

    override fun clearResumeNudge() {
        NotificationManagerCompat.from(app).cancel(NUDGE_NOTIFICATION_ID)
    }

    override fun nowMs(): Long = System.currentTimeMillis()

    private companion object {
        const val TAG = "LocationPlatform"
        const val NUDGE_CHANNEL_ID = "ci_location_resume"
        const val NUDGE_NOTIFICATION_ID = 41_002
        const val REQUEST_NUDGE_TAP = 4103
    }
}
