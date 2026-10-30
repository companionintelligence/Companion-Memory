package com.companionintelligence.localhub.location

import android.Manifest
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.hardware.Sensor
import android.hardware.SensorManager
import android.hardware.TriggerEvent
import android.hardware.TriggerEventListener
import android.os.Build
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import com.google.android.gms.location.Geofence
import com.google.android.gms.location.GeofencingRequest
import com.google.android.gms.location.LocationServices

/**
 * [LocationPlatform] on the device: Google Play Services for the exit geofence and the last
 * known fix, [LocationService] for the GPS itself, one permission-free one-shot sensor --
 * stationary detect (five seconds at rest), only armed while that service runs -- and one
 * ordinary notification for the lapsed-grant nudge. The sensor is optional hardware; a
 * device without it leans on the fixes-based rule alone.
 *
 * There is deliberately no significant-motion trigger here. It needs the app to be eligible
 * for sensor events, which a backgrounded app with no foreground service is not (Android 9+),
 * so it could only ever fire while the app was on screen. See [LocationTracker]'s class docs
 * for the device evidence.
 *
 * The geofence PendingIntent is an explicit broadcast to this module's own (non-exported)
 * receiver. It is `FLAG_MUTABLE` because Play Services fills the result extras into the
 * intent it sends, which an immutable PendingIntent forbids; from API 31 one of the two
 * flags is mandatory and this is the one that works.
 *
 * Failures here are logged, not thrown: a missing Play Services, a revoked permission or a
 * transient GMS error must not take the plugin call, or a broadcast receiver, down with it.
 */
class AndroidLocationPlatform(context: Context) : LocationPlatform {
    private val app = context.applicationContext

    private val sensors: SensorManager? = app.getSystemService(Context.SENSOR_SERVICE) as? SensorManager
    private val stationaryDetect: Sensor? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) sensors?.getDefaultSensor(Sensor.TYPE_STATIONARY_DETECT) else null

    private val stillnessListener = object : TriggerEventListener() {
        override fun onTrigger(event: TriggerEvent?) {
            LocationTracking.get(app).onStationaryDetected()
        }
    }

    override fun watchForStillness() {
        val sensor = stationaryDetect ?: return
        // A trigger sensor is one-shot and cancels itself on firing; cancelling first makes
        // re-arming idempotent.
        sensors?.cancelTriggerSensor(stillnessListener, sensor)
        if (sensors?.requestTriggerSensor(stillnessListener, sensor) != true) {
            Log.w(TAG, "stationary-detect trigger not armed")
        }
    }

    override fun cancelSensorTriggers() {
        stationaryDetect?.let { sensors?.cancelTriggerSensor(stillnessListener, it) }
    }

    override fun setExitGeofence(latitude: Double, longitude: Double, radiusMeters: Float, onDone: (Boolean) -> Unit) {
        val fence = Geofence.Builder()
            .setRequestId(GEOFENCE_ID)
            .setCircularRegion(latitude, longitude, radiusMeters)
            .setExpirationDuration(Geofence.NEVER_EXPIRE)
            .setTransitionTypes(Geofence.GEOFENCE_TRANSITION_EXIT)
            .build()
        val request = GeofencingRequest.Builder()
            // No initial trigger: the phone is inside the fence by construction, and an
            // immediate EXIT from a stale fix would just switch GPS straight back on.
            .setInitialTrigger(0)
            .addGeofence(fence)
            .build()
        try {
            LocationServices.getGeofencingClient(app)
                .addGeofences(request, geofenceIntent())
                .addOnSuccessListener { onDone(true) }
                .addOnFailureListener {
                    Log.w(TAG, "exit geofence not set: ${it.message}")
                    onDone(false)
                }
        } catch (e: SecurityException) {
            Log.w(TAG, "exit geofence needs background location: ${e.message}")
            onDone(false)
        }
    }

    override fun clearExitGeofence() {
        try {
            LocationServices.getGeofencingClient(app).removeGeofences(geofenceIntent())
        } catch (e: Exception) {
            Log.w(TAG, "exit geofence not cleared: ${e.message}")
        }
    }

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
            // behind the lock screen (uid state TOP_SLEEPING). The tracker falls back to a
            // geofence, whose exit IS exempt.
            Log.w(TAG, "location service not started: ${e.message}")
            false
        }
    }

    override fun stopSampling() {
        app.stopService(Intent(app, LocationService::class.java))
    }

    override fun isSamplingRunning(): Boolean = LocationService.isRunning

    override fun lastKnownLocation(onResult: (GateSample?) -> Unit) {
        if (ContextCompat.checkSelfPermission(app, Manifest.permission.ACCESS_FINE_LOCATION) != PackageManager.PERMISSION_GRANTED &&
            ContextCompat.checkSelfPermission(app, Manifest.permission.ACCESS_COARSE_LOCATION) != PackageManager.PERMISSION_GRANTED
        ) {
            onResult(null)
            return
        }
        try {
            LocationServices.getFusedLocationProviderClient(app).lastLocation
                .addOnSuccessListener { location ->
                    onResult(location?.let { GateSample(it.latitude, it.longitude, it.time) })
                }
                .addOnFailureListener {
                    Log.w(TAG, "last known location unavailable: ${it.message}")
                    onResult(null)
                }
        } catch (e: SecurityException) {
            Log.w(TAG, "last known location refused: ${e.message}")
            onResult(null)
        }
    }

    override fun hasBackgroundLocationGrant(): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            // Before Android 10 the foreground grant covers the background too.
            return true
        }
        return ContextCompat.checkSelfPermission(app, Manifest.permission.ACCESS_BACKGROUND_LOCATION) == PackageManager.PERMISSION_GRANTED
    }

    override fun showGrantLapsedNudge(config: LocationTrackingConfig) {
        val manager = NotificationManagerCompat.from(app)
        if (!manager.areNotificationsEnabled()) {
            // POST_NOTIFICATIONS was refused or withdrawn: nothing can be shown. The person
            // turned Always on knowing the OS requires a notification for it, so this is the
            // one case where a lapsed grant silently pauses recording until the next app open.
            Log.w(TAG, "notifications disabled; cannot ask the person to restore background location")
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
        val text = "Companion no longer has \"Allow all the time\" location access, so it cannot record where you go. " +
            "Open Companion to allow it again."
        val notification = NotificationCompat.Builder(app, NUDGE_CHANNEL_ID)
            .setContentTitle(config.notificationTitle.ifBlank { LocationTrackingConfig.DEFAULT_NOTIFICATION_TITLE } + " paused")
            .setContentText(text)
            .setStyle(NotificationCompat.BigTextStyle().bigText(text))
            .setSmallIcon(NotificationIcons.small(app))
            .setContentIntent(tap)
            .setAutoCancel(true)
            .setOnlyAlertOnce(true)
            .setPriority(NotificationCompat.PRIORITY_DEFAULT)
            .setCategory(NotificationCompat.CATEGORY_STATUS)
            .build()
        try {
            manager.notify(NUDGE_NOTIFICATION_ID, notification)
        } catch (e: SecurityException) {
            Log.w(TAG, "could not post the nudge: ${e.message}")
        }
    }

    override fun clearNudge() {
        NotificationManagerCompat.from(app).cancel(NUDGE_NOTIFICATION_ID)
    }

    override fun nowMs(): Long = System.currentTimeMillis()

    private fun geofenceIntent(): PendingIntent = PendingIntent.getBroadcast(
        app,
        REQUEST_GEOFENCE,
        Intent(app, GeofenceReceiver::class.java).setAction(GeofenceReceiver.ACTION),
        pendingFlags(),
    )

    private fun pendingFlags(): Int {
        var flags = PendingIntent.FLAG_UPDATE_CURRENT
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            flags = flags or PendingIntent.FLAG_MUTABLE
        }
        return flags
    }

    private companion object {
        const val TAG = "LocationPlatform"
        const val GEOFENCE_ID = "ci-resting-spot"
        const val REQUEST_GEOFENCE = 4102
        const val NUDGE_CHANNEL_ID = "ci_location_resume"
        const val NUDGE_NOTIFICATION_ID = 41_002
        const val REQUEST_NUDGE_TAP = 4103
    }
}
