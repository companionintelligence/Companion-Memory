package com.companionintelligence.localhub.location

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class LocationSamplingGateTest {
    private val config = LocationTrackingConfig(
        deviceKey = "k",
        provider = "companion-mobile",
        owner = null,
        minDistanceMeters = 150.0,
        minIntervalMs = 5 * 60 * 1000L,
        maxAccuracyMeters = 200.0,
        notificationTitle = "t",
        notificationText = "x",
    )

    @Test
    fun `the first fix always passes`() {
        assertEquals(LocationSamplingGate.Decision.Accept, LocationSamplingGate.decide(config, null, 33.0, -117.0, 5.0, 1_000L))
    }

    @Test
    fun `moving far enough passes before the interval`() {
        val last = GateSample(33.6767, -117.7972, 0L)
        // ~160 m east at this latitude
        val decision = LocationSamplingGate.decide(config, last, 33.6767, -117.7955, 5.0, 9_000L)
        assertEquals(LocationSamplingGate.Decision.Accept, decision)
    }

    @Test
    fun `waiting long enough passes without moving`() {
        val last = GateSample(33.6767, -117.7972, 0L)
        val decision = LocationSamplingGate.decide(config, last, 33.6767, -117.7972, 5.0, 5 * 60 * 1000L)
        assertEquals(LocationSamplingGate.Decision.Accept, decision)
    }

    @Test
    fun `neither far nor long is rejected`() {
        val last = GateSample(33.6767, -117.7972, 0L)
        val decision = LocationSamplingGate.decide(config, last, 33.6768, -117.7972, 5.0, 60_000L)
        assertTrue(decision is LocationSamplingGate.Decision.Reject)
    }

    @Test
    fun `a loose fix is rejected even when far and late`() {
        val last = GateSample(33.6767, -117.7972, 0L)
        val decision = LocationSamplingGate.decide(config, last, 34.0, -117.0, 250.0, 60 * 60 * 1000L)
        assertTrue(decision is LocationSamplingGate.Decision.Reject)
    }

    @Test
    fun `out of range coordinates are rejected`() {
        assertTrue(LocationSamplingGate.decide(config, null, 91.0, 0.0, 5.0, 0L) is LocationSamplingGate.Decision.Reject)
        assertTrue(LocationSamplingGate.decide(config, null, 0.0, 181.0, 5.0, 0L) is LocationSamplingGate.Decision.Reject)
        assertTrue(LocationSamplingGate.decide(config, null, Double.NaN, 0.0, 5.0, 0L) is LocationSamplingGate.Decision.Reject)
    }

    @Test
    fun `haversine agrees with the web side to the metre`() {
        // Irvine to a point ~1 km north: the web test's haversineMeters gives 1111 m per 0.01 deg lat.
        val metres = LocationSamplingGate.haversineMeters(33.6767, -117.7972, 33.6867, -117.7972)
        assertEquals(1111.0, metres, 2.0)
    }
}
