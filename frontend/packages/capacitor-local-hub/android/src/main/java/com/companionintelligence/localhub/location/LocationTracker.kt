package com.companionintelligence.localhub.location

import com.companionintelligence.localhub.EnqueueOutcome
import com.companionintelligence.localhub.OutboxQueue
import org.json.JSONObject

/** Why sampling stopped without the person asking it to; picks the wording of the resume nudge. */
enum class SamplingLossReason { REBOOT, APP_UPDATE, PROCESS_DEATH }

/**
 * What the tracker needs from the OS, behind an interface so the state machine runs under a
 * plain JVM test with a fake. [AndroidLocationPlatform] is the real one.
 */
interface LocationPlatform {
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
     * Post the one notification that asks the person to open the app: sampling stopped for
     * [reason] and, without the background-location grant, nothing but an app open may start
     * a location foreground service again. Tapping it launches the app.
     */
    fun showResumeNudge(config: LocationTrackingConfig, reason: SamplingLossReason)
    fun clearResumeNudge()
    fun nowMs(): Long
}

/** Everything the tracker must remember across process deaths. */
data class TrackingState(
    val config: LocationTrackingConfig,
    /** The last fix actually queued -- what the distance/interval gate compares against. */
    val lastAccepted: GateSample?,
) {
    fun toJson(): JSONObject = JSONObject()
        .put("config", config.toJson())
        .put("lastAccepted", lastAccepted?.let(::sampleJson) ?: JSONObject.NULL)

    companion object {
        fun fromJson(json: JSONObject): TrackingState? {
            val config = json.optJSONObject("config")?.let(LocationTrackingConfig::fromJson) ?: return null
            return TrackingState(
                config = config,
                lastAccepted = json.optJSONObject("lastAccepted")?.let(::sampleFromJson),
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
 * Android's Always mode: one location foreground service, started from inside the app and
 * kept running until the person turns Always off.
 *
 * What this replaces: `@capacitor-community/background-geolocation`'s watcher, which lived
 * and died with the WebView. Its service was *bound* from the plugin, and the plugin's
 * destroy hook stopped it, so swiping the app out of recents ended recording, and a reboot
 * left nothing to start it again until the app was next opened. This service is *started*
 * instead: the activity and the WebView can go, the process stays alive for the service,
 * and every fix is queued into the encrypted outbox from native code with the record the
 * web side would have built ([PositionRecordJson]). When the plugin *is* alive it is told as
 * well (`significantLocation`), and the web side's own enqueue of the same fix collapses on
 * the shared `source_id`.
 *
 * What it cannot do, and the nudge that stands in: Android lets a location foreground
 * service take location after the app leaves the screen only when the service was started
 * while the app was on screen. Without `ACCESS_BACKGROUND_LOCATION` -- which this build
 * deliberately does not declare -- a service started from a boot broadcast or a sticky
 * restart would show its notification and receive nothing. So after a reboot, an app
 * update or a process death the tracker posts one plain notification asking the person to
 * open the app; the open is what restarts sampling, through [onAppResumed] before the web
 * side even re-arms. The `background-location-tracking` branch replaces this nudge with a
 * geofence restart once that grant is approved; everything else here stays.
 *
 * All state lives in [TrackingStateStore] so a process the OS created just to deliver one
 * broadcast knows whether Always is on. Methods are synchronized; they are called from the
 * main thread (receivers, the service) and the plugin's IO scope.
 */
class LocationTracker(
    private val platform: LocationPlatform,
    private val store: TrackingStateStore,
    private val outbox: () -> OutboxQueue,
) {
    /** The plugin's event sink while a WebView exists; null once the activity is gone. */
    @Volatile
    var listener: ((JSONObject) -> Unit)? = null

    private var state: TrackingState? = null
    private var loaded = false

    val isArmed: Boolean
        get() = synchronized(this) { current() != null }

    /**
     * Arm, or re-arm with new options, and start sampling. Returns whether the service is
     * running afterwards. A refused start (app behind the lock screen, another app on top)
     * leaves the tracker armed with no service; [onAppResumed] repairs that the next time the
     * app is on screen, which is the one moment the start is sure to be allowed.
     */
    fun arm(config: LocationTrackingConfig): Boolean = synchronized(this) {
        val previous = current()
        persist(TrackingState(config = config, lastAccepted = previous?.lastAccepted))
        platform.clearResumeNudge()
        if (platform.isSamplingRunning()) {
            // Re-armed with the service already up (the web side re-arms on every app open):
            // the running service picks up the new config from the store on its next fix.
            return true
        }
        platform.startSampling(config)
    }

    fun disarm() = synchronized(this) {
        platform.stopSampling()
        platform.clearResumeNudge()
        state = null
        loaded = true
        store.clear()
    }

    /**
     * The app is on screen: the one place Android always allows the location service to
     * start. Puts it back if Always is on and it is missing -- after a reboot, an update, a
     * process death or a refused start -- so recording resumes on the open itself, not on the
     * web side's later re-arm. A running service is never touched.
     */
    fun onAppResumed() = synchronized(this) {
        val now = current() ?: return@synchronized
        if (platform.isSamplingRunning()) {
            return@synchronized
        }
        if (platform.startSampling(now.config)) {
            platform.clearResumeNudge()
        }
    }

    /**
     * Sampling stopped for a reason the person did not choose. With Always on, the only way
     * back is an app open, so ask for one. Nothing to say when Always is off.
     */
    fun onSamplingLost(reason: SamplingLossReason) = synchronized(this) {
        val now = current() ?: return@synchronized
        platform.showResumeNudge(now.config, reason)
    }

    /** The service's config, or null when Always is off (the service then stops itself). */
    fun configForService(): LocationTrackingConfig? = synchronized(this) { current()?.config }

    /** One OS fix from the foreground location service. */
    fun onFix(fix: LocationFix): FixOutcome = synchronized(this) {
        val now = current() ?: return FixOutcome.Ignored("not armed")
        val decision = LocationSamplingGate.decide(
            now.config,
            now.lastAccepted,
            fix.latitude,
            fix.longitude,
            fix.accuracyMeters,
            fix.capturedAtMs,
        )
        if (decision is LocationSamplingGate.Decision.Reject) {
            return FixOutcome.Ignored(decision.reason)
        }
        val record = PositionRecordJson.record(fix, now.config.deviceKey, now.config.provider)
            ?: return FixOutcome.Ignored("unusable fix")
        val outcome = try {
            outbox().enqueue(
                kind = PositionRecordJson.OUTBOX_KIND,
                payloadJson = PositionRecordJson.payload(record).toString(),
                capturedAt = record.getString("time"),
                idempotencyKey = record.getString("source_id"),
                owner = now.config.owner,
            )
        } catch (e: Exception) {
            return FixOutcome.Failed(e.message ?: e.javaClass.simpleName)
        }
        return when (outcome) {
            is EnqueueOutcome.Created, is EnqueueOutcome.Duplicate -> {
                persist(now.copy(lastAccepted = GateSample(fix.latitude, fix.longitude, fix.capturedAtMs)))
                listener?.invoke(PositionRecordJson.eventBody(fix))
                FixOutcome.Queued(record.getString("source_id"))
            }
            EnqueueOutcome.AtCapacity -> FixOutcome.Failed("outbox at capacity")
        }
    }

    sealed class FixOutcome {
        data class Queued(val sourceId: String) : FixOutcome()
        data class Ignored(val reason: String) : FixOutcome()
        data class Failed(val message: String) : FixOutcome()
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
}
