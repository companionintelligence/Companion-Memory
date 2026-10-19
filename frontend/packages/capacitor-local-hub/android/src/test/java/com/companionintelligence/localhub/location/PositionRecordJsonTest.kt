package com.companionintelligence.localhub.location

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Pins the native record builder to the SAME fixture the web side's
 * `deviceSourceLocation.test.ts` ("parity fixture shared with the Android native builder")
 * uses for `buildPositionRecord`. The two must build equivalent records: a drift means a
 * background fix and its web-side re-enqueue stop collapsing on `source_id`, or one of them
 * starts failing the server's schema. Change both or neither.
 *
 * Robolectric for the same reason the server tests use it: this speaks org.json, which the
 * mockable android.jar stubs into throwers.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class PositionRecordJsonTest {
    private val deviceKey = "cd12ea3d-b4d5-4ba6-a1e1-b02d18653e93"

    @Test
    fun `builds the fixture record`() {
        val record = PositionRecordJson.record(
            LocationFix(
                latitude = 33.6767,
                longitude = -117.7972,
                accuracyMeters = 4.0,
                altitudeMeters = 61.5,
                altitudeAccuracyMeters = null,
                headingDegrees = 275.25,
                speedMetersPerSecond = 14.5,
                capturedAtMs = 1791520516942L,
            ),
            deviceKey,
            "companion-mobile",
        )!!

        assertEquals("2026-10-09T04:35:16.942Z", record.getString("time"))
        assertEquals(-117.7972, record.getJSONObject("location").getDouble("x"), 0.0)
        assertEquals(33.6767, record.getJSONObject("location").getDouble("y"), 0.0)
        assertEquals(4.0, record.getDouble("accuracy_meters"), 0.0)
        assertEquals(61.5, record.getDouble("altitude_meters"), 0.0)
        assertEquals(275.25, record.getDouble("heading_degrees"), 0.0)
        assertEquals(14.5, record.getDouble("speed_meters_per_second"), 0.0)
        assertEquals("gps", record.getString("source"))
        assertEquals("companion-mobile", record.getString("provider"))
        assertEquals("device", record.getString("source_type"))
        assertEquals("companion-device", record.getString("source_system"))
        assertEquals("$deviceKey:1791520516942", record.getString("source_id"))
        assertEquals(11, record.length())
    }

    @Test
    fun `omits the optional fields the server would reject or discard`() {
        val record = PositionRecordJson.record(
            LocationFix(
                latitude = 33.6767,
                longitude = -117.7972,
                accuracyMeters = 0.0,
                altitudeMeters = null,
                altitudeAccuracyMeters = null,
                headingDegrees = 361.0,
                speedMetersPerSecond = -1.0,
                capturedAtMs = 1791520516000L,
            ),
            deviceKey,
            "companion-mobile",
        )!!

        assertEquals("2026-10-09T04:35:16.000Z", record.getString("time"))
        assertFalse(record.has("accuracy_meters"))
        assertFalse(record.has("altitude_meters"))
        assertFalse(record.has("heading_degrees"))
        assertFalse(record.has("speed_meters_per_second"))
        assertEquals("$deviceKey:1791520516000", record.getString("source_id"))
        assertEquals(7, record.length())
    }

    @Test
    fun `refuses a fix outside the valid range`() {
        val fix = LocationFix(91.0, 0.0, 5.0, null, null, null, null, 0L)
        assertNull(PositionRecordJson.record(fix, deviceKey, "companion-mobile"))
    }

    @Test
    fun `wraps the record in the positions envelope`() {
        val record = PositionRecordJson.record(LocationFix(1.0, 2.0, null, null, null, null, null, 0L), deviceKey, "p")!!
        val payload = PositionRecordJson.payload(record)
        assertEquals(1, payload.getJSONArray("records").length())
        assertEquals(record.toString(), payload.getJSONArray("records").getJSONObject(0).toString())
    }

    @Test
    fun `the event body is the BackgroundGeolocationLocation shape the hook already adapts`() {
        val body = PositionRecordJson.eventBody(LocationFix(1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8L))
        assertEquals(1.0, body.getDouble("latitude"), 0.0)
        assertEquals(2.0, body.getDouble("longitude"), 0.0)
        assertEquals(3.0, body.getDouble("accuracy"), 0.0)
        assertEquals(4.0, body.getDouble("altitude"), 0.0)
        assertEquals(5.0, body.getDouble("altitudeAccuracy"), 0.0)
        assertEquals(6.0, body.getDouble("bearing"), 0.0)
        assertEquals(7.0, body.getDouble("speed"), 0.0)
        assertEquals(8L, body.getLong("time"))
    }
}
