package com.companionintelligence.localhub.location

import com.companionintelligence.localhub.EnqueueOutcome
import com.companionintelligence.localhub.OutboxQueue
import org.json.JSONObject

/**
 * What the tracker needs from the OS, behind an interface so the state machine runs under a
 * plain JVM test with a fake. [AndroidLocationPlatform] is the real one.
 */
interface LocationPlatform {
    /**
     * Arm the one-shot stationary-detect trigger (five seconds at rest; no permission). Fires
     * [LocationTracker.onStationaryDetected] once, then must be armed again. Only armed while
     * the location service runs: that service is what keeps the app eligible for sensor
     * events at all (see the class docs), so this is also the only time it can fire.
     */
    fun watchForStillness()
    fun cancelSensorTriggers()
    /**
     * One exit geofence around where the phone came to rest, delivered to [GeofenceReceiver].
     * Re-adding under the same id replaces, so this is idempotent. [onDone] says whether the
     * OS now holds the fence (possibly later, on another thread); the restore path uses it to
     * retry a Play Services call that failed, e.g. at boot before Play Services itself was up.
     */
    fun setExitGeofence(latitude: Double, longitude: Double, radiusMeters: Float, onDone: (Boolean) -> Unit = {})
    fun clearExitGeofence()
    /**
     * Start the foreground location service (GPS on). Returns false when Android refused the
     * start -- a location foreground service may not be started from the background, and
     * "background" includes an app launched behind the lock screen (uid state TOP_SLEEPING)
     * or re-armed while another app is on screen. The tracker must not believe GPS is on
     * when it is not.
     */
    fun startSampling(config: LocationTrackingConfig): Boolean
    /** Stop it (GPS off). */
    fun stopSampling()
    /** Whether that service is alive in this process right now (false in a fresh process). */
    fun isSamplingRunning(): Boolean
    /**
     * The platform's last known fix, if any, delivered once (possibly later, possibly on
     * another thread). Needs no foreground service: with the Always grant the fused provider
     * answers from the background, which is what makes it the fallback fence centre.
     */
    fun lastKnownLocation(onResult: (GateSample?) -> Unit)
    /**
     * Whether `ACCESS_BACKGROUND_LOCATION` ("Allow all the time") is held right now. The
     * plugin arms the tracker only once it is, but the person can lower it later in Settings,
     * and Android itself resets the permissions of an app that goes unused for months.
     * Without it the exit geofence cannot be registered, so nothing could ever restart
     * sampling from the background; see [LocationTracker.restore].
     */
    fun hasBackgroundLocationGrant(): Boolean
    /**
     * Post the one notification that tells the person recording stopped because the
     * background grant lapsed, and that an app open (where the web side re-prompts) is the
     * way back. Tapping it launches the app.
     */
    fun showGrantLapsedNudge(config: LocationTrackingConfig)
    fun clearNudge()
    fun nowMs(): Long
}

/** Everything the tracker must remember across process deaths. */
data class TrackingState(
    val config: LocationTrackingConfig,
    /**
     * True while the location service is wanted. It is normally also running; when Android
     * refused to start it and no fence could be set (no known location), it is wanted but
     * absent until [LocationTracker.onAppResumed] repairs it.
     */
    val moving: Boolean,
    /** The last fix actually queued -- what the distance/interval gate compares against. */
    val lastAccepted: GateSample?,
    /** The last fix seen at all, queued or not -- the geofence centre when the phone stops. */
    val lastSeen: GateSample?,
    /** When the phone last moved [LocationTracker.STILL_MOVEMENT_METERS] from [movementAnchor]; the self-detected-still clock. */
    val lastMovementAtMs: Long,
    /**
     * Where the phone was when movement was last confirmed. The still rule measures every fix
     * against THIS, never against the previous fix: at walking pace consecutive five-second
     * fixes are a few metres apart and would never clear 50 m, which once stopped sampling
     * ten minutes into a walk. Null until the first fix.
     */
    val movementAnchor: GateSample? = null,
    /** When the stationary-detect sensor last fired with no movement since; null once the phone moves. */
    val stationaryNotedAtMs: Long? = null,
) {
    fun toJson(): JSONObject = JSONObject()
        .put("config", config.toJson())
        .put("moving", moving)
        .put("lastAccepted", lastAccepted?.let(::sampleJson) ?: JSONObject.NULL)
        .put("lastSeen", lastSeen?.let(::sampleJson) ?: JSONObject.NULL)
        .put("lastMovementAtMs", lastMovementAtMs)
        .put("movementAnchor", movementAnchor?.let(::sampleJson) ?: JSONObject.NULL)
        .put("stationaryNotedAtMs", stationaryNotedAtMs ?: JSONObject.NULL)

    companion object {
        /**
         * A state saved by the always-on tracker this one replaces has only `config` and
         * `lastAccepted`; the missing fields default to "moving, clock not started", which
         * the first fix after the upgrade sets straight.
         */
        fun fromJson(json: JSONObject): TrackingState? {
            val config = json.optJSONObject("config")?.let(LocationTrackingConfig::fromJson) ?: return null
            return TrackingState(
                config = config,
                moving = json.optBoolean("moving", true),
                lastAccepted = json.optJSONObject("lastAccepted")?.let(::sampleFromJson),
                lastSeen = json.optJSONObject("lastSeen")?.let(::sampleFromJson),
                lastMovementAtMs = json.optLong("lastMovementAtMs", 0L),
                movementAnchor = json.optJSONObject("movementAnchor")?.let(::sampleFromJson),
                stationaryNotedAtMs = if (json.isNull("stationaryNotedAtMs")) null else json.optLong("stationaryNotedAtMs"),
            )
        }

        private fun sampleJson(sample: GateSample): JSONObject = JSONObject()
            .put("latitude", sample.latitude)
            .put("longitude", sample.longitude)
            .put("atMs", sample.atMs)

        private fun sampleFromJson(json: JSONObject): GateSample? {
            val latitude = json.optDouble("latitude")
            val longitude = json.optDouble("longitude")
            if (!latitude.isFinite() || !longitude.isFinite()) {
                return null
            }
            return GateSample(latitude, longitude, json.optLong("atMs", 0L))
        }
    }
}

/** Durable home for [TrackingState]; [SharedPreferencesTrackingStateStore] in production. */
interface TrackingStateStore {
    fun load(): TrackingState?
    fun save(state: TrackingState)
    fun clear()
}

/**
 * Motion-gated background sampling for Android's Always mode.
 *
 * The problem this solves: a location request that stays open for as long as Always is on
 * keeps the GPS receiver on around the clock, including the many hours a phone spends
 * sitting still. `@capacitor-community/background-geolocation`'s once-per-second request was
 * measured at roughly a quarter of the phone's daily drain; the always-on service that
 * replaced it (this class, until the background-location grant was approved) idled better
 * but still held a request all day.
 *
 * The rule here is that GPS runs only while the phone is moving, and every signal used to
 * decide that needs nothing beyond the location grants Always already holds. The
 * activity-recognition API would be the obvious tool and is deliberately NOT used: it is a
 * separate "Physical activity" runtime permission that reads as a different kind of
 * monitoring than location, and iOS's equivalent (significant-change monitoring) asks for
 * nothing of the sort.
 *
 * - **Moving → still** comes from the fixes themselves: no [STILL_MOVEMENT_METERS] of
 *   movement from where movement was last confirmed for [STILL_TIMEOUT_MS], or for the
 *   shorter [STILL_CONFIRMED_TIMEOUT_MS] once the permission-free stationary-detect sensor
 *   has reported the phone physically at rest. The location service stops and an exit
 *   geofence is set around the resting spot.
 * - **Still → moving** comes from the geofence exit, and only from that. Android evaluates
 *   the fence with cheap location, it survives this process being frozen or killed, and it
 *   is on Android's list of events that permit starting a location foreground service from
 *   the background -- which is what makes this work after the WebView is long gone. The
 *   price is that the first stretch of every trip, the fence radius plus Play Services'
 *   evaluation latency, is not sampled; a trip shorter than the radius is not sampled at all.
 *
 * Why no sensor fills that gap: since Android 9 an app in the background with no foreground
 * service receives no sensor events, one-shot triggers included. On a device the
 * significant-motion trigger fired for the system's own listeners while this app's,
 * registered the same way, never heard it -- the app had been frozen a minute after the
 * stop. The activity-recognition API is the OS-sanctioned way around that, by delivering
 * through Play Services as a PendingIntent, and it is exactly the permission this design
 * declines. The stationary sensor is unaffected because it is only needed while the
 * service is running, which keeps the app eligible.
 *
 * The geofence is also what makes `ACCESS_BACKGROUND_LOCATION` necessary: Android will not
 * register one without it. Should that grant lapse later -- lowered in Settings, or reset by
 * Android on an app unused for months -- no fence can be set and nothing could restart
 * sampling from the background, so the tracker posts one plain notification asking for an
 * app open, where the web side's re-arm runs the permission prompt again.
 *
 * Every fix that clears [LocationSamplingGate] is queued straight into the encrypted outbox
 * from native code, with the record the web side would have built ([PositionRecordJson]), so
 * nothing depends on JavaScript being alive. When the plugin *is* alive it is told as well
 * (`significantLocation`), and the web side's own enqueue of the same fix collapses on the
 * shared `source_id`.
 *
 * Fixes are recorded whether or not the app is on screen: this is the only recorder (there
 * is no on-screen trail and no second plugin), so one gate applies everywhere.
 *
 * All state lives in [TrackingStateStore] so a process the OS created just to deliver one
 * broadcast picks up where the previous one left off. Methods are synchronized; they are
 * called from the main thread (receivers, sensors, service) and the plugin's IO scope.
 */
class LocationTracker(
    private val platform: LocationPlatform,
    private val store: TrackingStateStore,
    private val outbox: () -> OutboxQueue,
) {
    /** The plugin's event sink while a WebView exists; null in a broadcast-only process. */
    @Volatile
    var listener: ((JSONObject) -> Unit)? = null

    private var state: TrackingState? = null
    private var loaded = false

    val isArmed: Boolean
        get() = synchronized(this) { current() != null }

    /** Snapshot for diagnostics (`getStatus`-style reads); never mutated through. */
    fun snapshot(): TrackingState? = synchronized(this) { current()?.copy() }

    /**
     * Arm, or re-arm with new options. Starts sampling at once: a phone being configured is
     * usually in hand. Usually -- not always. An app launched behind the lock screen, or
     * re-armed while backgrounded, is refused a location foreground service, and an earlier
     * revision recorded "moving" regardless: no GPS, no fence, and nothing that could ever
     * wake it again (three days of trips went unrecorded that way). A refused start now
     * falls back to a fence around the last known location, exactly as if the phone had
     * just come to rest, so the next departure restarts it the exempt way.
     *
     * Re-armed with the service already up (the web side re-arms on every app open): the
     * running service picks up the new config from the store on its next fix, and nothing
     * is restarted -- a restart would re-post a notification the person may have swiped away.
     */
    fun arm(config: LocationTrackingConfig) = synchronized(this) {
        val previous = current()
        val next = TrackingState(
            config = config,
            moving = true,
            lastAccepted = previous?.lastAccepted,
            lastSeen = previous?.lastSeen,
            lastMovementAtMs = platform.nowMs(),
        )
        persist(next)
        platform.clearNudge()
        platform.clearExitGeofence()
        if (platform.isSamplingRunning()) {
            return@synchronized
        }
        if (platform.startSampling(config)) {
            platform.watchForStillness()
        } else {
            fenceInsteadOfSampling()
        }
    }

    fun disarm() = synchronized(this) {
        platform.stopSampling()
        platform.clearExitGeofence()
        platform.cancelSensorTriggers()
        platform.clearNudge()
        state = null
        loaded = true
        store.clear()
    }

    /**
     * The app is on screen: a repair pass ([restore]) at the one moment Android is sure to
     * allow the location service to start. An earlier revision re-started the service here
     * unconditionally so a notification dropped while notifications were denied would
     * reappear after the grant, but that re-post also undid every swipe-away for the rest
     * of a trip. A dismissed indicator stays dismissed: a swiped notification leaves the
     * service running, and a running service is never touched here.
     *
     * No nudge from here: the person is already in the app, and the web side's re-arm
     * (which runs the permission prompt again) is what repairs a lapsed grant.
     */
    fun onAppResumed() {
        platform.clearNudge()
        restore(nudge = false)
    }

    /**
     * Put back whatever the OS should be holding for the saved state, after an event that
     * wiped it. Play Services drops every geofence on reboot; on an update the system
     * force-stops the package, which cancels its PendingIntents, and the fence goes with
     * them (seen on a device: a phone that had come to rest at 16:19, an install at 17:04,
     * no fence anywhere afterwards and an evening walk unrecorded). The web side re-arms on
     * the next app open, so what this closes is the window before that open.
     *
     * - Never armed, or disarmed: nothing to do.
     * - Still: the exit fence goes back around the resting spot (idempotent). With no
     *   resting spot on record, around the platform's last known fix.
     * - Moving (the process died mid-trip): the location service, if Android allows the
     *   start; the boot and package-replaced broadcasts are exempt from the background-start
     *   rule, so it usually does. Refused, it falls back to a fence like any other refused
     *   start.
     *
     * [onDone] reports whether the OS now holds what the state needs. [TrackingRestoreReceiver]
     * finishes its async broadcast on it and schedules a retry on `false`. With [nudge], a
     * fence that cannot be set because the background grant lapsed also posts the
     * notification asking for an app open; a retry will not help there, the person has to.
     */
    fun restore(nudge: Boolean = true, onDone: (Boolean) -> Unit = {}) = synchronized(this) {
        val now = current()
        if (now == null) {
            onDone(true)
            return@synchronized
        }
        if (now.moving) {
            if (platform.isSamplingRunning()) {
                onDone(true)
                return@synchronized
            }
            if (platform.startSampling(now.config)) {
                // The still clock starts over: the fixes that would have advanced it never arrived.
                persist(now.copy(lastMovementAtMs = platform.nowMs(), movementAnchor = null, stationaryNotedAtMs = null))
                platform.watchForStillness()
                onDone(true)
            } else {
                fenceInsteadOfSampling(nudge, onDone)
            }
            return@synchronized
        }
        if (!backgroundGrantHeld(now.config, nudge)) {
            onDone(false)
            return@synchronized
        }
        val centre = now.lastSeen
        if (centre != null) {
            fence(centre, now.config, nudge, onDone)
            return@synchronized
        }
        platform.lastKnownLocation { known ->
            synchronized(this) {
                val latest = current()
                if (latest == null || latest.moving || latest.lastSeen != null) {
                    // Armed, disarmed or fenced in the meantime; that path owns the outcome now.
                    onDone(true)
                    return@synchronized
                }
                if (known == null) {
                    onDone(false)
                    return@synchronized
                }
                persist(latest.copy(lastSeen = known))
                fence(known, latest.config, nudge, onDone)
            }
        }
    }

    /** The exit geofence fired: the phone left its resting spot. */
    fun onGeofenceExit() = synchronized(this) {
        val now = current() ?: return
        if (now.moving) {
            return
        }
        becomeMoving(now)
    }

    /**
     * The stationary-detect trigger fired: five seconds physically at rest. A red light does
     * that too, so this never stops sampling by itself -- it only shortens the clock the fixes
     * are judged against, and stops now if that shorter clock has already run out.
     */
    fun onStationaryDetected() = synchronized(this) {
        val now = current() ?: return
        if (!now.moving) {
            return
        }
        val noted = now.copy(stationaryNotedAtMs = now.stationaryNotedAtMs ?: platform.nowMs())
        if (platform.nowMs() - noted.lastMovementAtMs >= STILL_CONFIRMED_TIMEOUT_MS) {
            becomeStill(noted)
            return
        }
        persist(noted)
        // One-shot sensor: arm it again so the next rest is noticed too.
        platform.watchForStillness()
    }

    /** The service's config while it is wanted, or null when Always is off or the phone is still (the service then stops itself). */
    fun configForService(): LocationTrackingConfig? = synchronized(this) { current()?.takeIf { it.moving }?.config }

    /** One OS fix from the foreground location service. */
    fun onFix(fix: LocationFix): FixOutcome = synchronized(this) {
        val now = current() ?: return FixOutcome.Ignored("not armed")
        val seen = GateSample(fix.latitude, fix.longitude, fix.capturedAtMs)
        var next = now.copy(lastSeen = seen)

        // Self-detected still: no activity recognition needed. Measured against the anchor
        // where movement was last confirmed -- not the previous fix (see TrackingState) and not
        // the last queued fix (which the 150 m gate keeps far behind a slow walker).
        val movedFromAnchor = now.movementAnchor?.let {
            LocationSamplingGate.haversineMeters(it.latitude, it.longitude, fix.latitude, fix.longitude)
        }
        if (movedFromAnchor == null || movedFromAnchor >= STILL_MOVEMENT_METERS) {
            next = next.copy(lastMovementAtMs = platform.nowMs(), movementAnchor = seen, stationaryNotedAtMs = null)
        } else {
            val timeout = if (now.stationaryNotedAtMs != null) STILL_CONFIRMED_TIMEOUT_MS else STILL_TIMEOUT_MS
            if (platform.nowMs() - now.lastMovementAtMs >= timeout) {
                persist(next)
                becomeStill(next)
                return FixOutcome.Ignored("still for ${timeout}ms; sampling stopped")
            }
        }

        val decision = LocationSamplingGate.decide(
            now.config,
            now.lastAccepted,
            fix.latitude,
            fix.longitude,
            fix.accuracyMeters,
            fix.capturedAtMs,
        )
        if (decision is LocationSamplingGate.Decision.Reject) {
            persist(next)
            return FixOutcome.Ignored(decision.reason)
        }

        val record = PositionRecordJson.record(fix, now.config.deviceKey, now.config.provider)
        if (record == null) {
            persist(next)
            return FixOutcome.Ignored("unusable fix")
        }
        val outcome = try {
            outbox().enqueue(
                kind = PositionRecordJson.OUTBOX_KIND,
                payloadJson = PositionRecordJson.payload(record).toString(),
                capturedAt = record.getString("time"),
                idempotencyKey = record.getString("source_id"),
                owner = now.config.owner,
            )
        } catch (e: Exception) {
            persist(next)
            return FixOutcome.Failed(e.message ?: e.javaClass.simpleName)
        }
        return when (outcome) {
            is EnqueueOutcome.Created, is EnqueueOutcome.Duplicate -> {
                persist(next.copy(lastAccepted = seen))
                listener?.invoke(PositionRecordJson.eventBody(fix))
                FixOutcome.Queued(record.getString("source_id"))
            }
            EnqueueOutcome.AtCapacity -> {
                persist(next)
                FixOutcome.Failed("outbox at capacity")
            }
        }
    }

    sealed class FixOutcome {
        data class Queued(val sourceId: String) : FixOutcome()
        data class Ignored(val reason: String) : FixOutcome()
        data class Failed(val message: String) : FixOutcome()
    }

    private fun becomeStill(now: TrackingState) {
        platform.stopSampling()
        persist(now.copy(moving = false, stationaryNotedAtMs = null))
        val centre = now.lastSeen
        if (centre != null) {
            fence(centre, now.config, nudge = true)
        }
    }

    private fun becomeMoving(now: TrackingState) {
        platform.clearExitGeofence()
        // A fresh anchor comes with the first fix of the new session.
        persist(now.copy(moving = true, lastMovementAtMs = platform.nowMs(), movementAnchor = null, stationaryNotedAtMs = null))
        if (platform.startSampling(now.config)) {
            platform.watchForStillness()
        } else {
            // A geofence exit is exempt, so this should not happen; if it does, the phone has
            // left the old fence, so a new one goes around where it is now.
            fenceInsteadOfSampling()
        }
    }

    /**
     * Android refused the location service: behave as if the phone had just come to rest, so
     * the exit geofence -- the one restart Android always allows -- takes over. The centre is
     * the platform's last known fix (fresh, and the fence must enclose the phone for an exit
     * to ever fire), falling back to the last fix this tracker saw. With neither, the state
     * stays "moving" with no service, and [onAppResumed] repairs it.
     */
    private fun fenceInsteadOfSampling(nudge: Boolean = true, onDone: (Boolean) -> Unit = {}) {
        platform.lastKnownLocation { known ->
            synchronized(this) {
                val now = current()
                if (now == null || !now.moving || platform.isSamplingRunning()) {
                    // Disarmed, fenced by another path, or sampling after all: nothing owed.
                    onDone(true)
                    return@synchronized
                }
                val centre = known ?: now.lastSeen
                if (centre == null) {
                    // Wanted but absent; onAppResumed repairs it. Nothing the OS could hold.
                    onDone(false)
                    return@synchronized
                }
                persist(now.copy(moving = false, lastSeen = centre, stationaryNotedAtMs = null))
                fence(centre, now.config, nudge, onDone)
            }
        }
    }

    /**
     * The one place a fence is registered. Without the background grant Play Services
     * refuses it, and the phone would sit "still" with nothing to wake it; that is the case
     * the nudge exists for.
     */
    private fun fence(centre: GateSample, config: LocationTrackingConfig, nudge: Boolean, onDone: (Boolean) -> Unit = {}) {
        if (!backgroundGrantHeld(config, nudge)) {
            onDone(false)
            return
        }
        platform.setExitGeofence(centre.latitude, centre.longitude, config.geofenceRadiusMeters, onDone)
    }

    private fun backgroundGrantHeld(config: LocationTrackingConfig, nudge: Boolean): Boolean {
        if (platform.hasBackgroundLocationGrant()) {
            return true
        }
        if (nudge) {
            platform.showGrantLapsedNudge(config)
        }
        return false
    }

    private fun current(): TrackingState? {
        if (!loaded) {
            state = store.load()
            loaded = true
        }
        return state
    }

    private fun persist(next: TrackingState) {
        state = next
        loaded = true
        store.save(next)
    }

    companion object {
        /** Fixes closer together than this, for the timeout in force, count as "not moving". */
        const val STILL_MOVEMENT_METERS = 50.0
        /**
         * The clock when nothing but the fixes says the phone is at rest. Five minutes (was ten until
         * 2026-10-13): a stop is declared sooner at the cost of a slightly longer unsampled restart
         * after a pause that outlasts it -- the fence radius plus Play Services' evaluation delay.
         */
        const val STILL_TIMEOUT_MS = 5L * 60L * 1000L
        /** The clock once the stationary-detect sensor has confirmed the phone is physically at rest. */
        const val STILL_CONFIRMED_TIMEOUT_MS = 3L * 60L * 1000L
    }
}
