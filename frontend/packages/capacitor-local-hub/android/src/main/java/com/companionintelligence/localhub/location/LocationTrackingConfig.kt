package com.companionintelligence.localhub.location

import org.json.JSONObject

/**
 * What the web side hands over when it turns Always on, persisted verbatim so a process that
 * has no WebView, no plugin instance and no JavaScript -- the app swiped out of recents with
 * the location service still running, or a process Android restarted -- can build exactly
 * the records the web side would have.
 *
 * Every field is a value the web side owns: the device key and owner stamp come from its
 * storage, the gate numbers from `@ci/common`'s location.ts, the notification text from its
 * copy. Nothing here is invented natively, so a record queued by this module and one queued
 * by `captureLocationFix` for the same fix carry the same `source_id` and collapse.
 */
data class LocationTrackingConfig(
    /** Stable per-install id that prefixes `source_id`; see `deviceSourceKey()` on the web side. */
    val deviceKey: String,
    val provider: String,
    /** The outbox owner stamp (`outboxOwnerStamp()`), or null when no account is signed in. */
    val owner: String?,
    val minDistanceMeters: Double,
    val minIntervalMs: Long,
    /** Fixes looser than this are dropped, not queued. */
    val maxAccuracyMeters: Double,
    val notificationTitle: String,
    val notificationText: String,
) {
    fun toJson(): JSONObject = JSONObject()
        .put(KEY_DEVICE_KEY, deviceKey)
        .put(KEY_PROVIDER, provider)
        .put(KEY_OWNER, owner ?: JSONObject.NULL)
        .put(KEY_MIN_DISTANCE, minDistanceMeters)
        .put(KEY_MIN_INTERVAL, minIntervalMs)
        .put(KEY_MAX_ACCURACY, maxAccuracyMeters)
        .put(KEY_NOTIFICATION_TITLE, notificationTitle)
        .put(KEY_NOTIFICATION_TEXT, notificationText)

    companion object {
        const val DEFAULT_PROVIDER = "companion-mobile"
        const val DEFAULT_MIN_DISTANCE_METERS = 150.0
        const val DEFAULT_MIN_INTERVAL_MS = 5L * 60L * 1000L
        const val DEFAULT_MAX_ACCURACY_METERS = 200.0
        const val DEFAULT_NOTIFICATION_TITLE = "Recording location"
        const val DEFAULT_NOTIFICATION_TEXT = "Companion is recording your location so it can place memories on the map."

        private const val KEY_DEVICE_KEY = "deviceKey"
        private const val KEY_PROVIDER = "provider"
        private const val KEY_OWNER = "owner"
        private const val KEY_MIN_DISTANCE = "minDistanceMeters"
        private const val KEY_MIN_INTERVAL = "minIntervalMs"
        private const val KEY_MAX_ACCURACY = "maxAccuracyMeters"
        private const val KEY_NOTIFICATION_TITLE = "notificationTitle"
        private const val KEY_NOTIFICATION_TEXT = "notificationText"

        /**
         * Parses the JS options object (or a persisted copy). Returns null when `deviceKey` is
         * missing or blank: without it no `source_id` can be built, and a record with a made-up
         * key would never dedupe against the web side's.
         */
        fun fromJson(json: JSONObject): LocationTrackingConfig? {
            val deviceKey = json.optString(KEY_DEVICE_KEY, "").trim()
            if (deviceKey.isEmpty()) {
                return null
            }
            val owner = if (json.isNull(KEY_OWNER)) null else json.optString(KEY_OWNER, "").ifBlank { null }
            return LocationTrackingConfig(
                deviceKey = deviceKey,
                provider = json.optString(KEY_PROVIDER, "").ifBlank { DEFAULT_PROVIDER },
                owner = owner,
                minDistanceMeters = positiveOr(json.optDouble(KEY_MIN_DISTANCE), DEFAULT_MIN_DISTANCE_METERS),
                minIntervalMs = positiveOr(json.optDouble(KEY_MIN_INTERVAL), DEFAULT_MIN_INTERVAL_MS.toDouble()).toLong(),
                maxAccuracyMeters = positiveOr(json.optDouble(KEY_MAX_ACCURACY), DEFAULT_MAX_ACCURACY_METERS),
                notificationTitle = json.optString(KEY_NOTIFICATION_TITLE, "").ifBlank { DEFAULT_NOTIFICATION_TITLE },
                notificationText = json.optString(KEY_NOTIFICATION_TEXT, "").ifBlank { DEFAULT_NOTIFICATION_TEXT },
            )
        }

        private fun positiveOr(value: Double, fallback: Double): Double =
            if (value.isFinite() && value > 0) value else fallback
    }
}
