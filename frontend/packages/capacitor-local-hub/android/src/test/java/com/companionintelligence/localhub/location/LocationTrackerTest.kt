package com.companionintelligence.localhub.location

import com.companionintelligence.localhub.EnqueueOutcome
import com.companionintelligence.localhub.FakeOutbox
import com.companionintelligence.localhub.outboxItem
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** Records every platform call, in order, so a test can assert the exact OS footprint of a scenario. */
private class FakePlatform : LocationPlatform {
    val calls = mutableListOf<String>()
    var now = 1_000_000L
    /** False = Android refuses the foreground service (started from the background). */
    var startAllowed = true
    /** Whether the service is alive; set by an allowed start, cleared by stop -- or by a test playing process death. */
    var samplingRunning = false
    override fun startSampling(config: LocationTrackingConfig): Boolean {
        calls += "startSampling"
        if (startAllowed) {
            samplingRunning = true
        }
        return startAllowed
    }
    override fun stopSampling() {
        calls += "stopSampling"
        samplingRunning = false
    }
    override fun isSamplingRunning(): Boolean = samplingRunning
    override fun showResumeNudge(config: LocationTrackingConfig, reason: SamplingLossReason) { calls += "nudge($reason)" }
    override fun clearResumeNudge() { calls += "clearNudge" }
    override fun nowMs(): Long = now
}

/** In-memory state, round-tripped through JSON exactly as SharedPreferences would store it. */
private class MemoryStore : TrackingStateStore {
    var raw: String? = null
    override fun load(): TrackingState? = raw?.let { TrackingState.fromJson(JSONObject(it)) }
    override fun save(state: TrackingState) { raw = state.toJson().toString() }
    override fun clear() { raw = null }
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class LocationTrackerTest {
    private val config = LocationTrackingConfig(
        deviceKey = "cd12ea3d-b4d5-4ba6-a1e1-b02d18653e93",
        provider = "companion-mobile",
        owner = "http://localhost:5173 abc123",
        minDistanceMeters = 150.0,
        minIntervalMs = 5 * 60 * 1000L,
        maxAccuracyMeters = 200.0,
        notificationTitle = "Recording location",
        notificationText = "recording",
    )
    private val platform = FakePlatform()
    private val store = MemoryStore()
    private val outbox = FakeOutbox()
    private val tracker = LocationTracker(platform, store, { outbox })

    private fun fix(lat: Double, lng: Double, atMs: Long, accuracy: Double = 5.0) =
        LocationFix(lat, lng, accuracy, null, null, null, null, atMs)

    @Test
    fun `arming clears any nudge and starts the service`() {
        assertTrue(tracker.arm(config))

        assertEquals(listOf("clearNudge", "startSampling"), platform.calls)
        assertTrue(tracker.isArmed)
        assertEquals(config, store.load()!!.config)
    }

    @Test
    fun `re-arming with the service already up leaves it alone`() {
        tracker.arm(config)
        platform.calls.clear()

        assertTrue(tracker.arm(config.copy(notificationText = "new copy")))

        assertEquals(listOf("clearNudge"), platform.calls)
        assertEquals("new copy", store.load()!!.config.notificationText)
    }

    @Test
    fun `a fix is queued with the web side's record and owner, and the plugin is told`() {
        tracker.arm(config)
        val events = mutableListOf<JSONObject>()
        tracker.listener = { events += it }

        val outcome = tracker.onFix(fix(33.6767, -117.7972, 1791520516942L, accuracy = 4.0))

        assertEquals(LocationTracker.FixOutcome.Queued("${config.deviceKey}:1791520516942"), outcome)
        assertEquals(1, outbox.enqueueCalls.size)
        val (kind, payload, capturedAt, key) = outbox.enqueueCalls[0]
        assertEquals("positions", kind)
        assertEquals("2026-10-09T04:35:16.942Z", capturedAt)
        assertEquals("${config.deviceKey}:1791520516942", key)
        assertEquals(config.owner, outbox.enqueueOwners[0])
        val record = JSONObject(payload).getJSONArray("records").getJSONObject(0)
        assertEquals(-117.7972, record.getJSONObject("location").getDouble("x"), 0.0)
        assertEquals("companion-mobile", record.getString("provider"))
        assertEquals(1, events.size)
        assertEquals(1791520516942L, events[0].getLong("time"))
    }

    @Test
    fun `fixes are queued with no plugin listening -- the swiped-away case`() {
        tracker.arm(config)
        tracker.listener = null

        assertTrue(tracker.onFix(fix(33.6767, -117.7972, 1_000L)) is LocationTracker.FixOutcome.Queued)
        assertEquals(1, outbox.enqueueCalls.size)
    }

    @Test
    fun `the gate holds across a process death because the last accepted fix is persisted`() {
        tracker.arm(config)
        tracker.onFix(fix(33.6767, -117.7972, 1_000L))

        // A new process: a fresh tracker over the same store, the service back up.
        val reborn = LocationTracker(platform, store, { outbox })
        val tooClose = reborn.onFix(fix(33.6768, -117.7972, 61_000L))
        assertTrue(tooClose is LocationTracker.FixOutcome.Ignored)
        assertEquals(1, outbox.enqueueCalls.size)

        val farEnough = reborn.onFix(fix(33.6767, -117.7955, 62_000L))
        assertTrue(farEnough is LocationTracker.FixOutcome.Queued)
        assertEquals(2, outbox.enqueueCalls.size)
    }

    @Test
    fun `a failed enqueue does not advance the gate`() {
        tracker.arm(config)
        outbox.nextEnqueueOutcome = EnqueueOutcome.AtCapacity

        val failed = tracker.onFix(fix(33.6767, -117.7972, 1_000L))
        assertTrue(failed is LocationTracker.FixOutcome.Failed)
        assertNull(store.load()!!.lastAccepted)

        outbox.nextEnqueueOutcome = EnqueueOutcome.Created(outboxItem())
        // Same spot a second later: with the gate not advanced this is still the first fix.
        assertTrue(tracker.onFix(fix(33.6767, -117.7972, 2_000L)) is LocationTracker.FixOutcome.Queued)
    }

    @Test
    fun `a duplicate enqueue still counts as queued (the web side got there first)`() {
        tracker.arm(config)
        outbox.nextEnqueueOutcome = EnqueueOutcome.Duplicate(outboxItem())

        assertTrue(tracker.onFix(fix(33.6767, -117.7972, 1_000L)) is LocationTracker.FixOutcome.Queued)
        assertEquals(1_000L, store.load()!!.lastAccepted!!.atMs)
    }

    @Test
    fun `nothing is queued while disarmed`() {
        assertEquals(LocationTracker.FixOutcome.Ignored("not armed"), tracker.onFix(fix(1.0, 2.0, 0L)))
        assertTrue(outbox.enqueueCalls.isEmpty())
    }

    @Test
    fun `disarming stops the service, clears the nudge and forgets the state`() {
        tracker.arm(config)
        platform.calls.clear()

        tracker.disarm()

        assertEquals(listOf("stopSampling", "clearNudge"), platform.calls)
        assertFalse(tracker.isArmed)
        assertNull(store.load())
        assertFalse(platform.samplingRunning)
    }

    @Test
    fun `a reboot with Always on posts the nudge, and with Always off posts nothing`() {
        tracker.onSamplingLost(SamplingLossReason.REBOOT)
        assertTrue(platform.calls.isEmpty())

        tracker.arm(config)
        platform.calls.clear()
        // The reboot itself: the service is gone and a new process reads the saved state.
        platform.samplingRunning = false
        val reborn = LocationTracker(platform, store, { outbox })

        reborn.onSamplingLost(SamplingLossReason.REBOOT)

        assertEquals(listOf("nudge(REBOOT)"), platform.calls)
    }

    @Test
    fun `an app open after a reboot restarts the service and clears the nudge`() {
        tracker.arm(config)
        platform.samplingRunning = false
        platform.calls.clear()
        val reborn = LocationTracker(platform, store, { outbox })

        reborn.onAppResumed()

        assertEquals(listOf("startSampling", "clearNudge"), platform.calls)
        assertTrue(platform.samplingRunning)
    }

    @Test
    fun `an app open with the service running touches nothing`() {
        tracker.arm(config)
        platform.calls.clear()

        tracker.onAppResumed()

        assertTrue(platform.calls.isEmpty())
    }

    @Test
    fun `an app open with Always off starts nothing`() {
        tracker.onAppResumed()
        assertTrue(platform.calls.isEmpty())
    }

    @Test
    fun `a refused start stays armed for the next app open to repair`() {
        platform.startAllowed = false

        assertFalse(tracker.arm(config))
        assertTrue(tracker.isArmed)
        assertFalse(platform.samplingRunning)

        platform.startAllowed = true
        platform.calls.clear()
        tracker.onAppResumed()

        assertEquals(listOf("startSampling", "clearNudge"), platform.calls)
        assertTrue(platform.samplingRunning)
    }

    @Test
    fun `the service reads its config from the store, and none once disarmed`() {
        assertNull(tracker.configForService())
        tracker.arm(config)
        assertEquals(config, tracker.configForService())
        tracker.disarm()
        assertNull(tracker.configForService())
    }
}
