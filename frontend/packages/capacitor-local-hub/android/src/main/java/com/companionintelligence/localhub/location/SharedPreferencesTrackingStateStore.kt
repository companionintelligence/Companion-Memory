package com.companionintelligence.localhub.location

import android.content.Context
import org.json.JSONException
import org.json.JSONObject

/**
 * [TrackingStateStore] on app-private SharedPreferences. The state holds no secret (the
 * owner stamp is a fingerprint, not the key) and must be readable from a cold process before
 * any keystore work, so plain preferences are the right tier.
 */
class SharedPreferencesTrackingStateStore(context: Context) : TrackingStateStore {
    private val prefs = context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    override fun load(): TrackingState? {
        val raw = prefs.getString(KEY_STATE, null) ?: return null
        return try {
            TrackingState.fromJson(JSONObject(raw))
        } catch (e: JSONException) {
            null
        }
    }

    override fun save(state: TrackingState) {
        prefs.edit().putString(KEY_STATE, state.toJson().toString()).apply()
    }

    override fun clear() {
        prefs.edit().remove(KEY_STATE).apply()
    }

    private companion object {
        const val PREFS_NAME = "ci_local_hub_location"
        const val KEY_STATE = "state"
    }
}
