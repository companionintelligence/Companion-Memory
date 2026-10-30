package com.companionintelligence.localhub.replica

import android.content.Context
import org.json.JSONObject

/**
 * What the app hands over each time its own sync client connects, so the background job can
 * do exactly what that client does without any JavaScript: where the appliance is, which file
 * is the replica, how far back the working set reaches (the token request's `cutoff`), and the
 * `start` options the JS client sends the core -- its schema included, which must match the
 * app's or the core would write rows the app's tables do not expect.
 */
data class ReplicaSyncConfig(
    val apiBaseUrl: String,
    /** The file name on disk, as the Capacitor SQLite plugin names it (`<name>SQLite.db`). */
    val databaseFile: String,
    val lookbackDays: Int,
    val startOptions: String,
) {
    fun toJson(): JSONObject = JSONObject()
        .put(KEY_API_BASE_URL, apiBaseUrl)
        .put(KEY_DATABASE_FILE, databaseFile)
        .put(KEY_LOOKBACK_DAYS, lookbackDays)
        .put(KEY_START_OPTIONS, startOptions)

    companion object {
        private const val KEY_API_BASE_URL = "apiBaseUrl"
        private const val KEY_DATABASE_FILE = "databaseFile"
        private const val KEY_LOOKBACK_DAYS = "lookbackDays"
        private const val KEY_START_OPTIONS = "startOptions"

        /** Null when anything needed is missing; a partial config must not sync. */
        fun fromJson(json: JSONObject): ReplicaSyncConfig? {
            val apiBaseUrl = json.optString(KEY_API_BASE_URL, "").trim().trimEnd('/')
            val databaseFile = json.optString(KEY_DATABASE_FILE, "").trim()
            val lookbackDays = json.optInt(KEY_LOOKBACK_DAYS, 0)
            val startOptions = json.optString(KEY_START_OPTIONS, "")
            if (apiBaseUrl.isEmpty() || databaseFile.isEmpty() || '/' in databaseFile || lookbackDays <= 0) {
                return null
            }
            if (runCatching { JSONObject(startOptions) }.isFailure) {
                return null
            }
            return ReplicaSyncConfig(apiBaseUrl, databaseFile, lookbackDays, startOptions)
        }
    }
}

/** The config, kept where a process started only for the background job can read it. */
class ReplicaSyncConfigStore(context: Context) {
    private val preferences = context.applicationContext.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE)

    fun load(): ReplicaSyncConfig? =
        preferences.getString(KEY, null)?.let { raw -> runCatching { ReplicaSyncConfig.fromJson(JSONObject(raw)) }.getOrNull() }

    fun save(config: ReplicaSyncConfig) {
        preferences.edit().putString(KEY, config.toJson().toString()).commit()
    }

    fun clear() {
        preferences.edit().remove(KEY).commit()
    }

    private companion object {
        const val PREFERENCES = "ci_local_hub_replica_sync"
        const val KEY = "config"
    }
}
