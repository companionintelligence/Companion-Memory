package com.companionintelligence.localhub.location

import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.sin
import kotlin.math.sqrt

/** A fix the gate compares against: the last one actually queued. */
data class GateSample(val latitude: Double, val longitude: Double, val atMs: Long)

/**
 * The persist gate, the same rule as `createLocationSampler` on the web side: record a fix
 * when the phone has **moved far enough OR waited long enough** since the last one it queued,
 * and never when the fix is looser than [LocationTrackingConfig.maxAccuracyMeters].
 *
 * Pure. The caller advances the gate (keeps the new [GateSample]) only after the record is
 * durably queued, so a failed enqueue does not swallow the fix and restart the clock.
 */
object LocationSamplingGate {
    private const val EARTH_RADIUS_METERS = 6_371_000.0

    sealed class Decision {
        data object Accept : Decision()
        data class Reject(val reason: String) : Decision()
    }

    fun decide(
        config: LocationTrackingConfig,
        last: GateSample?,
        latitude: Double,
        longitude: Double,
        accuracyMeters: Double?,
        atMs: Long,
    ): Decision {
        if (!latitude.isFinite() || !longitude.isFinite()) {
            return Decision.Reject("non-finite coordinates")
        }
        if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
            return Decision.Reject("coordinates out of range")
        }
        if (accuracyMeters != null && accuracyMeters.isFinite() && accuracyMeters > config.maxAccuracyMeters) {
            return Decision.Reject("accuracy ${accuracyMeters}m looser than ${config.maxAccuracyMeters}m")
        }
        if (last == null) {
            return Decision.Accept
        }
        val moved = haversineMeters(last.latitude, last.longitude, latitude, longitude)
        if (moved >= config.minDistanceMeters) {
            return Decision.Accept
        }
        if (atMs - last.atMs >= config.minIntervalMs) {
            return Decision.Accept
        }
        return Decision.Reject("moved ${moved.toInt()}m < ${config.minDistanceMeters.toInt()}m and ${atMs - last.atMs}ms < ${config.minIntervalMs}ms")
    }

    /** Great-circle distance in metres; spherical is ample for a movement gate. */
    fun haversineMeters(aLat: Double, aLng: Double, bLat: Double, bLng: Double): Double {
        val dLat = Math.toRadians(bLat - aLat)
        val dLng = Math.toRadians(bLng - aLng)
        val s = sin(dLat / 2) * sin(dLat / 2) +
            cos(Math.toRadians(aLat)) * cos(Math.toRadians(bLat)) * sin(dLng / 2) * sin(dLng / 2)
        return EARTH_RADIUS_METERS * 2 * atan2(sqrt(s), sqrt(1 - s))
    }
}
