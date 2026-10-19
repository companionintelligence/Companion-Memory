package com.companionintelligence.localhub.location

import android.Manifest
import android.app.ActivityManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.Looper
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.google.android.gms.location.FusedLocationProviderClient
import com.google.android.gms.location.LocationCallback
import com.google.android.gms.location.LocationRequest
import com.google.android.gms.location.LocationResult
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority

/**
 * The foreground location service behind Android's Always mode.
 *
 * Android requires a foreground service, with its notification, for any app that wants
 * location after leaving the screen, so the notification is the price of background
 * sampling. The service is *started*, not bound: it outlives the activity, the WebView and
 * the plugin, which is what keeps recording going after the app is swiped out of recents.
 *
 * The request mirrors the one measured on a device for the plugin this replaces (a fix every
 * 60 s, 15 s once fixes are flowing, high accuracy, delivered only after
 * [LocationTrackingConfig.minDistanceMeters] of movement): the 1 Hz request upstream shipped
 * was about a quarter of a day's battery drain, and the displacement filter lets the receiver
 * idle between fixes. Fixes go to [LocationTracker], which gates and queues them.
 *
 * Sticky, so that a process Android kills under memory pressure brings the service back. A
 * restart with the app off screen cannot resume sampling, though: without the
 * background-location grant a location service started from the background gets no fixes,
 * and from API 31 the start itself is refused. That restart posts the resume nudge instead.
 */
class LocationService : Service() {
    private var client: FusedLocationProviderClient? = null
    private val callback = object : LocationCallback() {
        override fun onLocationResult(result: LocationResult) {
            val tracker = LocationTracking.get(this@LocationService)
            for (location in result.locations) {
                tracker.onFix(
                    LocationFix(
                        latitude = location.latitude,
                        longitude = location.longitude,
                        accuracyMeters = if (location.hasAccuracy()) location.accuracy.toDouble() else null,
                        altitudeMeters = if (location.hasAltitude()) location.altitude else null,
                        altitudeAccuracyMeters = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && location.hasVerticalAccuracy()) {
                            location.verticalAccuracyMeters.toDouble()
                        } else {
                            null
                        },
                        headingDegrees = if (location.hasBearing()) location.bearing.toDouble() else null,
                        speedMetersPerSecond = if (location.hasSpeed()) location.speed.toDouble() else null,
                        capturedAtMs = location.time,
                    ),
                )
            }
        }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val tracker = LocationTracking.get(this)
        val config = tracker.configForService()
        if (config == null) {
            // Always was turned off (or never on) and this is a stale sticky restart.
            stopSelf()
            return START_NOT_STICKY
        }
        if (intent == null && !appOnScreen()) {
            // A sticky restart after a process death, with the app in the background. Even
            // where Android allows the service to start here, it would receive no location
            // (see the class docs), so do not post a "Recording location" notification that
            // would be a lie. Ask for an app open instead; onAppResumed restarts sampling.
            tracker.onSamplingLost(SamplingLossReason.PROCESS_DEATH)
            stopSelf()
            return START_NOT_STICKY
        }
        val title = intent?.getStringExtra(EXTRA_TITLE) ?: config.notificationTitle
        val text = intent?.getStringExtra(EXTRA_TEXT) ?: config.notificationText

        // FIRST, before any reason to stop: once startForegroundService() has been called,
        // Android (12+) throws ForegroundServiceDidNotStartInTimeException into this process
        // -- fatally -- if the service is stopped before it has called startForeground().
        try {
            goForeground(title, text)
        } catch (e: Exception) {
            // ForegroundServiceStartNotAllowedException or a missing notification permission.
            Log.w(TAG, "could not enter the foreground: ${e.message}")
            stopSelf()
            return START_NOT_STICKY
        }
        isRunning = true
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED &&
            ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_COARSE_LOCATION) != PackageManager.PERMISSION_GRANTED
        ) {
            Log.w(TAG, "location not granted; not sampling")
            stopSelf()
            return START_NOT_STICKY
        }
        if (client == null) {
            val fused = LocationServices.getFusedLocationProviderClient(this)
            val request = LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, INTERVAL_MS)
                .setMinUpdateIntervalMillis(MIN_INTERVAL_MS)
                .setMinUpdateDistanceMeters(config.minDistanceMeters.toFloat())
                .setWaitForAccurateLocation(false)
                .build()
            try {
                fused.requestLocationUpdates(request, callback, Looper.getMainLooper())
                client = fused
            } catch (e: SecurityException) {
                Log.w(TAG, "location updates refused: ${e.message}")
                stopSelf()
                return START_NOT_STICKY
            }
        }
        return START_STICKY
    }

    override fun onDestroy() {
        isRunning = false
        client?.removeLocationUpdates(callback)
        client = null
        super.onDestroy()
    }

    /** Whether one of this app's activities is on screen (or visible behind a dialog). */
    private fun appOnScreen(): Boolean {
        val info = ActivityManager.RunningAppProcessInfo()
        ActivityManager.getMyMemoryState(info)
        return info.importance <= ActivityManager.RunningAppProcessInfo.IMPORTANCE_VISIBLE
    }

    private fun goForeground(title: String, text: String) {
        val manager = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, "Recording location", NotificationManager.IMPORTANCE_LOW).apply {
                    setShowBadge(false)
                },
            )
        }
        val launch = packageManager.getLaunchIntentForPackage(packageName)
        val tap = launch?.let {
            PendingIntent.getActivity(
                this,
                0,
                it,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
        }
        val notification: Notification = NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(title)
            .setContentText(text)
            .setSmallIcon(applicationInfo.icon)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .apply { if (tap != null) setContentIntent(tap) }
            .build()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION)
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
    }

    companion object {
        /**
         * True from a successful startForeground() until onDestroy(), in this process only.
         * [LocationTracker] reads it (through the platform) to tell "already sampling" from
         * "the service is missing" -- only the latter is restarted on an app open.
         */
        @Volatile
        var isRunning: Boolean = false
            private set

        const val EXTRA_TITLE = "title"
        const val EXTRA_TEXT = "text"
        const val INTERVAL_MS = 60_000L
        const val MIN_INTERVAL_MS = 15_000L
        private const val TAG = "LocationService"
        private const val CHANNEL_ID = "ci_location_recording"
        private const val NOTIFICATION_ID = 41_001
    }
}
