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
    /** What the fused provider answers for its last known fix. */
    var lastKnown: GateSample? = null
    /** Whether Play Services accepts the fence; false plays "not up yet" at boot. */
    var geofenceAccepted = true
    /** Whether "Allow all the time" is still held. */
    var backgroundGranted = true
    override fun watchForStillness() { calls += "watchForStillness" }
    override fun cancelSensorTriggers() { calls += "cancelSensorTriggers" }
    override fun setExitGeofence(latitude: Double, longitude: Double, radiusMeters: Float, onDone: (Boolean) -> Unit) {
        calls += "geofence($latitude,$longitude,$radiusMeters)"
        onDone(geofenceAccepted)
    }
    override fun clearExitGeofence() { calls += "clearGeofence" }
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
    override fun lastKnownLocation(onResult: (GateSample?) -> Unit) {
        calls += "lastKnownLocation"
        onResult(lastKnown)
    }
    override fun hasBackgroundLocationGrant(): Boolean = backgroundGranted
    override fun showGrantLapsedNudge(config: LocationTrackingConfig) { calls += "nudge" }
    override fun clearNudge() { calls += "clearNudge" }
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
        geofenceRadiusMeters = 100f,
        notificationTitle = "Recording location",
        notificationText = "moving",
    )
    private val platform = FakePlatform()
    private val store = MemoryStore()
    private val outbox = FakeOutbox()
    private val tracker = LocationTracker(platform, store, { outbox })

    private fun fix(lat: Double, lng: Double, atMs: Long, accuracy: Double = 5.0) =
        LocationFix(lat, lng, accuracy, null, null, null, null, atMs)

    /** Five minutes of fixes within 50 m of the last one: the fixes-based "at rest" rule. */
    private fun becomeStillViaFixes() {
        val last = store.load()!!.lastSeen!!
        platform.now += LocationTracker.STILL_TIMEOUT_MS + 1_000L
        tracker.onFix(fix(last.latitude, last.longitude, platform.now))
        check(!store.load()!!.moving)
    }

    @Test
    fun `arming clears any nudge, starts sampling at once and watches for the phone coming to rest`() {
        tracker.arm(config)

        assertEquals(listOf("clearNudge", "clearGeofence", "startSampling", "watchForStillness"), platform.calls)
        assertTrue(tracker.isArmed)
        assertTrue(store.load()!!.moving)
        assertEquals(config, store.load()!!.config)
    }

    @Test
    fun `re-arming with the service already up leaves it alone`() {
        tracker.arm(config)
        platform.calls.clear()

        tracker.arm(config.copy(notificationText = "new copy"))

        // No restart of a running service: that would re-post a notification the user swiped away.
        assertEquals(listOf("clearNudge", "clearGeofence"), platform.calls)
        assertEquals("new copy", store.load()!!.config.notificationText)
        assertTrue(platform.samplingRunning)
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
    fun `the gate advances only on a queued fix`() {
        tracker.arm(config)

        tracker.onFix(fix(33.6767, -117.7972, 0L))
        // 10 m later, seconds later: throttled, and the gate still points at the first fix.
        val second = tracker.onFix(fix(33.6768, -117.7972, 5_000L))
        assertTrue(second is LocationTracker.FixOutcome.Ignored)
        // ~160 m from the FIRST fix: passes.
        val third = tracker.onFix(fix(33.6767, -117.7955, 10_000L))
        assertTrue(third is LocationTracker.FixOutcome.Queued)
        assertEquals(2, outbox.enqueueCalls.size)
    }

    @Test
    fun `a duplicate enqueue still counts as queued (the web side got there first)`() {
        tracker.arm(config)
        outbox.nextEnqueueOutcome = EnqueueOutcome.Duplicate(outboxItem())
        val events = mutableListOf<JSONObject>()
        tracker.listener = { events += it }

        val outcome = tracker.onFix(fix(33.6767, -117.7972, 1791520516942L))

        assertTrue(outcome is LocationTracker.FixOutcome.Queued)
        assertEquals(1791520516942L, store.load()!!.lastAccepted!!.atMs)
        assertEquals(1, events.size)
    }

    @Test
    fun `a geofence exit restarts sampling and arms the stillness sensor`() {
        tracker.arm(config)
        tracker.onFix(fix(33.6767, -117.7972, 0L))
        becomeStillViaFixes()
        platform.calls.clear()

        tracker.onGeofenceExit()

        assertEquals(listOf("clearGeofence", "startSampling", "watchForStillness"), platform.calls)
        assertTrue(store.load()!!.moving)
    }

    @Test
    fun `a geofence exit whose service start is refused fences where the phone is now`() {
        tracker.arm(config)
        tracker.onFix(fix(33.6767, -117.7972, 0L))
        becomeStillViaFixes()
        platform.startAllowed = false
        platform.lastKnown = GateSample(33.6800, -117.7900, platform.now)
        platform.calls.clear()

        tracker.onGeofenceExit()

        // Not the old resting spot: the phone has left it, and a fence it is outside of never fires.
        assertEquals(
            listOf("clearGeofence", "startSampling", "lastKnownLocation", "geofence(33.68,-117.79,100.0)"),
            platform.calls,
        )
        assertFalse(store.load()!!.moving)
    }

    @Test
    fun `a geofence exit while already moving is a no-op`() {
        tracker.arm(config)
        platform.calls.clear()

        tracker.onGeofenceExit()

        assertTrue(platform.calls.isEmpty())
    }

    @Test
    fun `stationary detect alone never stops sampling, it shortens the clock`() {
        tracker.arm(config)
        tracker.onFix(fix(33.6767, -117.7972, 0L))
        platform.calls.clear()

        // A red light: the sensor fires seconds after the last movement.
        platform.now += 20_000L
        tracker.onStationaryDetected()
        assertEquals(listOf("watchForStillness"), platform.calls)
        assertTrue(store.load()!!.moving)

        // Three minutes with no 50 m of movement is now enough (five without the sensor).
        platform.now += 3 * 60 * 1000L
        tracker.onFix(fix(33.6768, -117.7972, platform.now))
        assertFalse(store.load()!!.moving)
        assertEquals("stopSampling", platform.calls[1])
        assertEquals("geofence(33.6768,-117.7972,100.0)", platform.calls[2])
        assertEquals(3, platform.calls.size)
    }

    @Test
    fun `movement after a stationary report resets the short clock`() {
        tracker.arm(config)
        tracker.onFix(fix(33.6767, -117.7972, 0L))
        platform.now += 20_000L
        tracker.onStationaryDetected()

        // Drove on: 160 m further.
        platform.now += 60_000L
        tracker.onFix(fix(33.6767, -117.7955, platform.now))
        assertNull(store.load()!!.stationaryNotedAtMs)

        // Three more minutes of jitter is NOT enough any more.
        platform.now += 3 * 60 * 1000L
        tracker.onFix(fix(33.6767, -117.7956, platform.now))
        assertTrue(store.load()!!.moving)
    }

    @Test
    fun `a slow walk is movement even though consecutive fixes are metres apart`() {
        // The walk that found the bug: five-second fixes ~7 m apart for twelve minutes. Each
        // fix is close to the previous one, but far from where movement was last confirmed.
        tracker.arm(config)
        var lat = 33.6952
        for (second in 0 until 12 * 60 step 5) {
            platform.now += 5_000L
            lat += 0.000063 // ~7 m north per fix
            tracker.onFix(fix(lat, -117.7481, platform.now))
        }
        assertTrue(store.load()!!.moving)
        assertTrue(platform.calls.none { it == "stopSampling" })
    }

    @Test
    fun `fixes that show no movement for five minutes stop sampling and fence the resting spot`() {
        tracker.arm(config)
        tracker.onFix(fix(33.6767, -117.7972, 0L))
        platform.calls.clear()

        // Jitter inside 50 m for four minutes: still moving as far as the tracker knows.
        platform.now += 4 * 60 * 1000L
        tracker.onFix(fix(33.6768, -117.7972, platform.now))
        assertTrue(platform.calls.isEmpty())

        // Past five minutes: at rest. GPS off, fence around the last fix.
        platform.now += 2 * 60 * 1000L
        val outcome = tracker.onFix(fix(33.6768, -117.7973, platform.now))
        assertTrue(outcome is LocationTracker.FixOutcome.Ignored)
        assertEquals(listOf("stopSampling", "geofence(33.6768,-117.7973,100.0)"), platform.calls)
        assertFalse(store.load()!!.moving)
        assertNull(tracker.configForService())
    }

    @Test
    fun `coming to rest with the background grant lapsed posts the nudge instead of a fence`() {
        tracker.arm(config)
        tracker.onFix(fix(33.6767, -117.7972, 0L))
        // Lowered to "While using" in Settings mid-trip: the service keeps its fixes until the
        // stop, but Play Services will refuse the fence, and nothing could restart sampling.
        platform.backgroundGranted = false
        platform.calls.clear()

        becomeStillViaFixes()

        assertEquals(listOf("stopSampling", "nudge"), platform.calls)
    }

    @Test
    fun `state survives a new process`() {
        tracker.arm(config)
        tracker.onFix(fix(33.6767, -117.7972, 0L))
        becomeStillViaFixes()

        // A broadcast-started process: fresh tracker, same store and outbox.
        val reborn = LocationTracker(FakePlatform(), store, { outbox })
        assertTrue(reborn.isArmed)
        assertFalse(reborn.snapshot()!!.moving)
        assertEquals(config, reborn.snapshot()!!.config)
        // The gate carried over too: the same spot a second later is throttled, not queued.
        reborn.onGeofenceExit()
        val outcome = reborn.onFix(fix(33.6767, -117.7972, 1_000L))
        assertTrue(outcome is LocationTracker.FixOutcome.Ignored)
    }

    @Test
    fun `a state saved by the always-on tracker this one replaces reads as moving`() {
        // Only `config` and `lastAccepted` existed before the motion gate; an install that
        // upgrades with Always on must keep its gate and come up wanting the service.
        store.raw = JSONObject()
            .put("config", config.toJson())
            .put("lastAccepted", JSONObject().put("latitude", 33.6767).put("longitude", -117.7972).put("atMs", 5_000L))
            .toString()

        val upgraded = LocationTracker(platform, store, { outbox })

        assertTrue(upgraded.isArmed)
        assertTrue(upgraded.snapshot()!!.moving)
        assertEquals(5_000L, upgraded.snapshot()!!.lastAccepted!!.atMs)
        assertEquals(config, upgraded.configForService())
    }

    @Test
    fun `coming to the foreground touches nothing but the nudge while the service is running`() {
        tracker.arm(config)
        platform.calls.clear()

        tracker.onAppResumed()

        // No restart of a running service: that would re-post a notification the user swiped away.
        assertEquals(listOf("clearNudge"), platform.calls)
    }

    @Test
    fun `coming to the foreground while still puts the fence back rather than starting a service`() {
        tracker.arm(config)
        tracker.onFix(fix(33.6767, -117.7972, 0L))
        becomeStillViaFixes()
        platform.calls.clear()

        tracker.onAppResumed()

        // Re-adding under the same id replaces, so a fence that was there is unchanged, and
        // one lost to a reboot or an update is back. No service: the phone is still.
        assertEquals(listOf("clearNudge", "geofence(33.6767,-117.7972,100.0)"), platform.calls)
        assertFalse(store.load()!!.moving)
    }

    @Test
    fun `coming to the foreground with the grant lapsed never nudges -- the person is in the app`() {
        tracker.arm(config)
        tracker.onFix(fix(33.6767, -117.7972, 0L))
        becomeStillViaFixes()
        platform.backgroundGranted = false
        platform.calls.clear()

        tracker.onAppResumed()

        // The web side's re-arm runs the permission prompt again; a notification would be noise.
        assertEquals(listOf("clearNudge"), platform.calls)
    }

    @Test
    fun `restore after a reboot puts the fence back around the resting spot`() {
        tracker.arm(config)
        tracker.onFix(fix(33.6767, -117.7972, 0L))
        becomeStillViaFixes()
        // The device case: still at 16:19, the app reinstalled at 17:04, and Play Services
        // holding no fence at all afterwards -- an evening walk went unrecorded.
        val rebooted = LocationTracker(platform, store, { outbox })
        platform.calls.clear()
        var outcome: Boolean? = null

        rebooted.restore { outcome = it }

        assertEquals(listOf("geofence(33.6767,-117.7972,100.0)"), platform.calls)
        assertEquals(true, outcome)
        assertFalse(store.load()!!.moving)
    }

    @Test
    fun `restore reports a fence Play Services refused so the receiver can retry`() {
        tracker.arm(config)
        tracker.onFix(fix(33.6767, -117.7972, 0L))
        becomeStillViaFixes()
        platform.geofenceAccepted = false
        platform.calls.clear()
        var outcome: Boolean? = null

        LocationTracker(platform, store, { outbox }).restore { outcome = it }

        assertEquals(false, outcome)
        // Play Services being slow is not a lapsed grant: no nudge.
        assertTrue(platform.calls.none { it == "nudge" })
    }

    @Test
    fun `restore after a reboot with the grant lapsed nudges and reports failure`() {
        tracker.arm(config)
        tracker.onFix(fix(33.6767, -117.7972, 0L))
        becomeStillViaFixes()
        // Android reset the permissions of an app unused for months, or the person lowered it.
        platform.backgroundGranted = false
        platform.calls.clear()
        var outcome: Boolean? = null

        LocationTracker(platform, store, { outbox }).restore { outcome = it }

        assertEquals(listOf("nudge"), platform.calls)
        assertEquals(false, outcome)
    }

    @Test
    fun `restore while still with no resting spot on record fences the last known fix`() {
        // Refused start with nothing to fence left the state "moving"; a later disarm/arm
        // cycle is the realistic way to a still state with no lastSeen, so build it directly.
        store.save(TrackingState(config = config, moving = false, lastAccepted = null, lastSeen = null, lastMovementAtMs = 0L))
        platform.lastKnown = GateSample(33.6952, -117.7481, 5_000L)
        var outcome: Boolean? = null

        LocationTracker(platform, store, { outbox }).restore { outcome = it }

        assertEquals(listOf("lastKnownLocation", "geofence(33.6952,-117.7481,100.0)"), platform.calls)
        assertEquals(true, outcome)
        assertEquals(33.6952, store.load()!!.lastSeen!!.latitude, 0.0)
    }

    @Test
    fun `restore while still with no fix anywhere reports failure`() {
        store.save(TrackingState(config = config, moving = false, lastAccepted = null, lastSeen = null, lastMovementAtMs = 0L))
        platform.lastKnown = null
        var outcome: Boolean? = null

        LocationTracker(platform, store, { outbox }).restore { outcome = it }

        assertEquals(listOf("lastKnownLocation"), platform.calls)
        assertEquals(false, outcome)
    }

    @Test
    fun `restore after a reboot mid-trip restarts sampling`() {
        tracker.arm(config)
        tracker.onFix(fix(33.6767, -117.7972, 0L))
        platform.samplingRunning = false
        platform.calls.clear()
        var outcome: Boolean? = null

        LocationTracker(platform, store, { outbox }).restore { outcome = it }

        assertEquals(listOf("startSampling", "watchForStillness"), platform.calls)
        assertEquals(true, outcome)
        assertTrue(store.load()!!.moving)
        assertNull(store.load()!!.movementAnchor)
    }

    @Test
    fun `restore mid-trip falls back to a fence when the start is refused`() {
        tracker.arm(config)
        tracker.onFix(fix(33.6767, -117.7972, 0L))
        platform.samplingRunning = false
        platform.startAllowed = false
        platform.lastKnown = GateSample(33.6800, -117.7900, platform.now)
        platform.calls.clear()
        var outcome: Boolean? = null

        LocationTracker(platform, store, { outbox }).restore { outcome = it }

        assertEquals(listOf("startSampling", "lastKnownLocation", "geofence(33.68,-117.79,100.0)"), platform.calls)
        assertEquals(true, outcome)
        assertFalse(store.load()!!.moving)
    }

    @Test
    fun `restore with nothing armed does nothing and owes nothing`() {
        var outcome: Boolean? = null

        tracker.restore { outcome = it }

        assertTrue(platform.calls.isEmpty())
        assertEquals(true, outcome)
        assertFalse(tracker.isArmed)
    }

    @Test
    fun `coming to the foreground restarts a service that died while moving`() {
        tracker.arm(config)
        tracker.onFix(fix(33.6767, -117.7972, 0L))
        // The process was killed and came back with the state saying "moving" but no service.
        platform.samplingRunning = false
        platform.calls.clear()

        tracker.onAppResumed()

        assertEquals(listOf("clearNudge", "startSampling", "watchForStillness"), platform.calls)
        assertTrue(store.load()!!.moving)
        // The still clock starts over: the fixes that would have advanced it never arrived.
        assertNull(store.load()!!.movementAnchor)
    }

    @Test
    fun `a refused service start fences the last known location instead of pretending to move`() {
        // The device case: the app was (re)installed and launched behind the lock screen, so
        // Android refused the location foreground service. Three days of trips were lost
        // because the tracker recorded "moving" with no GPS and no fence.
        platform.startAllowed = false
        platform.lastKnown = GateSample(33.6952, -117.7481, 5_000L)

        tracker.arm(config)

        assertEquals(
            listOf("clearNudge", "clearGeofence", "startSampling", "lastKnownLocation", "geofence(33.6952,-117.7481,100.0)"),
            platform.calls,
        )
        val state = store.load()!!
        assertFalse(state.moving)
        assertEquals(33.6952, state.lastSeen!!.latitude, 0.0)
        assertNull(tracker.configForService())

        // Leaving the fence restarts sampling the exempt way, like any other departure.
        platform.startAllowed = true
        platform.calls.clear()
        tracker.onGeofenceExit()
        assertEquals(listOf("clearGeofence", "startSampling", "watchForStillness"), platform.calls)
        assertTrue(store.load()!!.moving)
    }

    @Test
    fun `a refused start with no location to fence stays wanted and is repaired on resume`() {
        platform.startAllowed = false
        platform.lastKnown = null

        tracker.arm(config)

        assertEquals(listOf("clearNudge", "clearGeofence", "startSampling", "lastKnownLocation"), platform.calls)
        assertTrue(store.load()!!.moving)
        assertFalse(platform.samplingRunning)

        // The user unlocks the phone and opens the app: the start is allowed now.
        platform.startAllowed = true
        platform.calls.clear()
        tracker.onAppResumed()
        assertEquals(listOf("clearNudge", "startSampling", "watchForStillness"), platform.calls)
        assertTrue(platform.samplingRunning)
    }

    @Test
    fun `a refused start falls back to the last fix this tracker saw when the platform knows nothing`() {
        tracker.arm(config)
        tracker.onFix(fix(33.6767, -117.7972, 0L))
        // Re-armed (new options) from the background: refused, and the fused provider has nothing.
        platform.startAllowed = false
        platform.lastKnown = null
        platform.samplingRunning = false
        platform.calls.clear()

        tracker.arm(config.copy(notificationText = "changed"))

        assertEquals(
            listOf("clearNudge", "clearGeofence", "startSampling", "lastKnownLocation", "geofence(33.6767,-117.7972,100.0)"),
            platform.calls,
        )
        assertFalse(store.load()!!.moving)
    }

    @Test
    fun `a late last-known answer is ignored once sampling is running after all`() {
        // The fused provider answers asynchronously; if the service came up in the meantime
        // (the user opened the app), the stale answer must not fence a moving phone.
        var pending: ((GateSample?) -> Unit)? = null
        val deferring = object : LocationPlatform by platform {
            override fun lastKnownLocation(onResult: (GateSample?) -> Unit) { pending = onResult }
        }
        val deferred = LocationTracker(deferring, store, { outbox })
        platform.startAllowed = false
        deferred.arm(config)
        assertTrue(store.load()!!.moving)

        platform.startAllowed = true
        deferred.onAppResumed()
        platform.calls.clear()
        pending!!(GateSample(33.6952, -117.7481, 5_000L))

        assertTrue(platform.calls.isEmpty())
        assertTrue(store.load()!!.moving)
    }

    @Test
    fun `disarming tears everything down and forgets the state`() {
        tracker.arm(config)
        platform.calls.clear()

        tracker.disarm()

        assertEquals(listOf("stopSampling", "clearGeofence", "cancelSensorTriggers", "clearNudge"), platform.calls)
        assertFalse(tracker.isArmed)
        assertNull(store.load())
        assertFalse(platform.samplingRunning)
        assertTrue(tracker.onFix(fix(1.0, 2.0, 0L)) is LocationTracker.FixOutcome.Ignored)
    }

    @Test
    fun `nothing is queued while disarmed`() {
        assertEquals(LocationTracker.FixOutcome.Ignored("not armed"), tracker.onFix(fix(1.0, 2.0, 0L)))
        assertTrue(outbox.enqueueCalls.isEmpty())
    }

    @Test
    fun `an outbox failure leaves the gate where it was`() {
        tracker.arm(config)
        outbox.thrown = RuntimeException("disk full")

        val outcome = tracker.onFix(fix(33.6767, -117.7972, 0L))

        assertTrue(outcome is LocationTracker.FixOutcome.Failed)
        assertNull(store.load()!!.lastAccepted)
    }

    @Test
    fun `a capacity refusal is a failure, not a silent drop, and does not advance the gate`() {
        tracker.arm(config)
        outbox.nextEnqueueOutcome = EnqueueOutcome.AtCapacity

        assertEquals(LocationTracker.FixOutcome.Failed("outbox at capacity"), tracker.onFix(fix(33.6767, -117.7972, 1_000L)))
        assertNull(store.load()!!.lastAccepted)

        outbox.nextEnqueueOutcome = EnqueueOutcome.Created(outboxItem())
        // Same spot a second later: with the gate not advanced this is still the first fix.
        assertTrue(tracker.onFix(fix(33.6767, -117.7972, 2_000L)) is LocationTracker.FixOutcome.Queued)
    }

    @Test
    fun `the service reads its config from the store while moving, and none once still or disarmed`() {
        assertNull(tracker.configForService())
        tracker.arm(config)
        assertEquals(config, tracker.configForService())
        tracker.onFix(fix(33.6767, -117.7972, 0L))
        becomeStillViaFixes()
        assertNull(tracker.configForService())
        tracker.disarm()
        assertNull(tracker.configForService())
    }

    @Test
    fun `config round-trips through JSON with defaults for what JS leaves out`() {
        val parsed = LocationTrackingConfig.fromJson(JSONObject().put("deviceKey", "k"))!!
        assertEquals(LocationTrackingConfig.DEFAULT_MIN_DISTANCE_METERS, parsed.minDistanceMeters, 0.0)
        assertEquals(LocationTrackingConfig.DEFAULT_MIN_INTERVAL_MS, parsed.minIntervalMs)
        assertEquals(LocationTrackingConfig.DEFAULT_GEOFENCE_RADIUS_METERS, parsed.geofenceRadiusMeters)
        assertNull(parsed.owner)
        assertEquals(config, LocationTrackingConfig.fromJson(config.toJson()))
        assertNull(LocationTrackingConfig.fromJson(JSONObject().put("deviceKey", "  ")))
    }
}
