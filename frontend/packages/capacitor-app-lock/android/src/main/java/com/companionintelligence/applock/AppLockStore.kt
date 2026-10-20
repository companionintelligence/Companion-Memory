package com.companionintelligence.applock

import android.content.Context
import android.content.SharedPreferences

/**
 * Where the settings live: plain SharedPreferences, read by [AppLockPlugin.load] before
 * the WebView has loaded a byte, which is what lets a cold start come up locked instead
 * of flashing the last page first. The settings are not secrets (whether the lock is on
 * and how long the grace is); the thing that matters is that they are native, not in
 * the page's localStorage where the gate would have to wait for JS to read them.
 */
class AppLockStore(context: Context) {
    private val prefs: SharedPreferences =
        context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    fun read(): AppLockSettings =
        AppLockSettings(
            enabled = prefs.getBoolean(KEY_ENABLED, false),
            grace = Grace.fromWire(prefs.getString(KEY_GRACE, null)),
            secureScreen = prefs.getBoolean(KEY_SECURE_SCREEN, true),
        )

    fun write(settings: AppLockSettings) {
        prefs
            .edit()
            .putBoolean(KEY_ENABLED, settings.enabled)
            .putString(KEY_GRACE, settings.grace.wire)
            .putBoolean(KEY_SECURE_SCREEN, settings.secureScreen)
            .apply()
    }

    companion object {
        const val PREFS_NAME = "ci_app_lock"
        const val KEY_ENABLED = "enabled"
        const val KEY_GRACE = "grace"
        const val KEY_SECURE_SCREEN = "secureScreen"
    }
}
