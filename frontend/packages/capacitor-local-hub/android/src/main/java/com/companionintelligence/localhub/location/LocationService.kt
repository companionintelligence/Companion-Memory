package com.companionintelligence.localhub.location

import android.Manifest
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
 * The foreground location service behind Android's Always mode, alive only while the phone
 * is moving.
 *
 * Android requires a foreground service, with its notification, for any app that wants
 * location after leaving the screen, so the notification is the price of background
 * sampling. The service is *started*, not bound: it outlives the activity, the WebView and
 * the plugin, which is what keeps recording going after the app is swiped out of recents.
 * What makes it cheap is that [LocationTracker] starts it when motion begins and stops it
 * when the phone comes to rest, so the notification -- and the GPS -- are present for the
 * moving minutes of a day rather than all of it.
 *
 * Fixes arrive every [INTERVAL_MS] while moving and go to the tracker, which gates and queues
 * them. No distance filter is set on the request: it would not save any power (the receiver
 * runs regardless) and the tracker needs every fix to centre the geofence and to notice when
 * the phone has stopped.
 *
 * Sticky, so that a process Android kills under memory pressure brings the service back
 * mid-trip; the tracker's persisted config fills in for the missing intent, and a restart
 * after the tracker was disarmed or declared the phone still stops itself.
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
        // A START_STICKY restart carries no intent; the tracker's persisted config fills in.
        val config = tracker.configForService()
        val title = intent?.getStringExtra(EXTRA_TITLE) ?: config?.notificationTitle
        val text = intent?.getStringExtra(EXTRA_TEXT) ?: config?.notificationText

        // FIRST, before any reason to stop: once startForegroundService() has been called,
        // Android (12+) throws ForegroundServiceDidNotStartInTimeException into this process
        // -- fatally -- if the service is stopped before it has called startForeground(). The
        // tracker can legitimately stop sampling within milliseconds of starting it (the web
        // side re-arms on every effect run in development), so entering the foreground must
        // not be conditional on anything that follows.
        try {
            goForeground(
                title ?: LocationTrackingConfig.DEFAULT_NOTIFICATION_TITLE,
                text ?: LocationTrackingConfig.DEFAULT_NOTIFICATION_TEXT,
            )
        } catch (e: Exception) {
            // ForegroundServiceStartNotAllowedException or a missing notification permission.
            Log.w(TAG, "could not enter the foreground: ${e.message}")
            stopSelf()
            return START_NOT_STICKY
        }
        isRunning = true
        if (config == null && intent == null) {
            // Restarted after the tracker was disarmed or told the phone is still.
            stopSelf()
            return START_NOT_STICKY
        }
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

    private fun goForeground(title: String, text: String) {
        val manager = getSystemService(NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            manager.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, "Location while moving", NotificationManager.IMPORTANCE_LOW).apply {
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
            // The status bar tints a stencil: a single-colour mark, not the launcher icon,
            // whose colours Android cannot tint (it showed as a filled blob on Samsung).
            .setSmallIcon(NotificationIcons.small(this))
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
         * [LocationTracker] reads it (through the platform) to tell "the service is running
         * and its notification was swiped" from "the service is missing" -- only the latter
         * may be restarted, or every swipe-away would be undone on the next resume.
         */
        @Volatile
        var isRunning: Boolean = false
            private set

        const val EXTRA_TITLE = "title"
        const val EXTRA_TEXT = "text"
        const val INTERVAL_MS = 5_000L
        const val MIN_INTERVAL_MS = 2_000L
        private const val TAG = "LocationService"
        private const val CHANNEL_ID = "ci_location_recording"
        private const val NOTIFICATION_ID = 41_001
    }
}
