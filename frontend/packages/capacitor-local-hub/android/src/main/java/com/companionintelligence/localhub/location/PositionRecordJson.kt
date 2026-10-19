package com.companionintelligence.localhub.location

import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import org.json.JSONArray
import org.json.JSONObject

/** One OS fix, in the shape the web side's `DeviceLocationFix` carries. */
data class LocationFix(
    val latitude: Double,
    val longitude: Double,
    val accuracyMeters: Double?,
    val altitudeMeters: Double?,
    val altitudeAccuracyMeters: Double?,
    val headingDegrees: Double?,
    val speedMetersPerSecond: Double?,
    val capturedAtMs: Long,
)

/**
 * Builds the wire record for a fix, field for field what `buildPositionRecord` in
 * `@ci/common/src/utils/deviceSources/location.ts` builds, so a record this module queues
 * from a WebView-less process is indistinguishable from one the web side queues.
 *
 * The rules copied from there, and the reasons they matter:
 * - `location.x` is **longitude**, `location.y` is **latitude** (GeoJSON order).
 * - Optional fields are **omitted**, never coerced. `accuracy_meters` must be positive (a
 *   zod check and a DB CHECK constraint -- a 0 would 400 the whole batch); a heading outside
 *   0-360 is discarded downstream; a negative speed is junk.
 * - `source_id` is `<deviceKey>:<epochMillis>`, the idempotency handle the appliance dedupes
 *   on and the outbox's own `idempotencyKey`.
 * - `time` is the JS `Date#toISOString()` form, always with three fractional digits.
 *
 * `PositionRecordJsonTest` pins this against the fixture the web side's own test uses.
 */
object PositionRecordJson {
    const val OUTBOX_KIND = "positions"
    const val SOURCE = "gps"
    const val SOURCE_TYPE = "device"
    const val SOURCE_SYSTEM = "companion-device"

    fun sourceId(deviceKey: String, capturedAtMs: Long): String = "$deviceKey:$capturedAtMs"

    fun isoTime(capturedAtMs: Long): String {
        val format = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US)
        format.timeZone = TimeZone.getTimeZone("UTC")
        return format.format(Date(capturedAtMs))
    }

    /** The record itself, or null when the fix is not worth sending (same refusals as the web). */
    fun record(fix: LocationFix, deviceKey: String, provider: String): JSONObject? {
        if (!fix.latitude.isFinite() || !fix.longitude.isFinite()) {
            return null
        }
        if (fix.latitude < -90 || fix.latitude > 90 || fix.longitude < -180 || fix.longitude > 180) {
            return null
        }
        val record = JSONObject()
        record.put("time", isoTime(fix.capturedAtMs))
        record.put("location", JSONObject().put("x", fix.longitude).put("y", fix.latitude))
        fix.accuracyMeters?.takeIf { it.isFinite() && it > 0 }?.let { record.put("accuracy_meters", it) }
        fix.altitudeMeters?.takeIf { it.isFinite() }?.let { record.put("altitude_meters", it) }
        fix.headingDegrees?.takeIf { it.isFinite() && it >= 0 && it <= 360 }?.let { record.put("heading_degrees", it) }
        fix.speedMetersPerSecond?.takeIf { it.isFinite() && it >= 0 }?.let { record.put("speed_meters_per_second", it) }
        record.put("source", SOURCE)
        record.put("provider", provider)
        record.put("source_type", SOURCE_TYPE)
        record.put("source_system", SOURCE_SYSTEM)
        record.put("source_id", sourceId(deviceKey, fix.capturedAtMs))
        return record
    }

    /** The outbox payload: the `/api/v1/positions` envelope, posted onward verbatim. */
    fun payload(record: JSONObject): JSONObject = JSONObject().put("records", JSONArray().put(record))

    /**
     * The `significantLocation` event body: the `BackgroundGeolocationLocation` shape the web
     * side converts with `fixFromBackgroundGeolocationLocation`, so iOS and Android emit one
     * event body and the hook needs no Android-specific adapter.
     */
    fun eventBody(fix: LocationFix): JSONObject = JSONObject()
        .put("latitude", fix.latitude)
        .put("longitude", fix.longitude)
        .put("accuracy", fix.accuracyMeters ?: JSONObject.NULL)
        .put("altitude", fix.altitudeMeters ?: JSONObject.NULL)
        .put("altitudeAccuracy", fix.altitudeAccuracyMeters ?: JSONObject.NULL)
        .put("bearing", fix.headingDegrees ?: JSONObject.NULL)
        .put("speed", fix.speedMetersPerSecond ?: JSONObject.NULL)
        .put("time", fix.capturedAtMs)
}
