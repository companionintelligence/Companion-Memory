package com.companionintelligence.applock

/**
 * How long the app may sit in the background before it comes back locked. The wire
 * names are the `AppLockGrace` union in ../src/definitions.ts; `seconds` is what the
 * policy compares against, with -1 standing for "never".
 */
enum class Grace(val wire: String, val seconds: Long) {
    IMMEDIATELY("immediately", 0),
    THIRTY_SECONDS("30s", 30),
    FIVE_MINUTES("5m", 300),
    NEVER("never", -1);

    companion object {
        val DEFAULT = THIRTY_SECONDS

        /** The grace a wire value names, or the default for anything unknown — never a crash on a stale pref. */
        fun fromWire(value: String?): Grace = entries.firstOrNull { it.wire == value } ?: DEFAULT
    }
}

/** The persisted settings. Defaults: off, 30 s, screen secured. */
data class AppLockSettings(
    val enabled: Boolean = false,
    val grace: Grace = Grace.DEFAULT,
    val secureScreen: Boolean = true,
)

/**
 * The lock decisions, as pure functions of settings and time, so the JVM test can pin
 * them without an Activity. [AppLockPlugin] owns the clock and the state; this owns the
 * rules.
 *
 * The lock is a presentation gate — see the plugin and SECURITY_ARCHITECTURE.md § 4.4.
 * Nothing here touches a database key, which is what lets sync run behind it.
 */
object AppLockPolicy {
    /** A cold start comes up locked whenever the lock is on. */
    fun locksOnLaunch(settings: AppLockSettings): Boolean = settings.enabled

    /**
     * Whether returning to the foreground re-locks: the lock is on, the grace is not
     * "never", and the time away reached the grace. [backgroundedAtMs] is null when the
     * app was never in the background since launch (the launch rule covers that case).
     */
    fun locksOnResume(settings: AppLockSettings, backgroundedAtMs: Long?, nowMs: Long): Boolean {
        if (!settings.enabled || settings.grace == Grace.NEVER || backgroundedAtMs == null) {
            return false
        }

        return nowMs - backgroundedAtMs >= settings.grace.seconds * 1000
    }

    /**
     * Whether leaving the foreground locks at once. Only for the "immediately" grace: the
     * overlay then IS the task-switcher snapshot, and `FLAG_SECURE` is not needed to hide
     * the page (though it still blocks screenshots when on).
     */
    fun locksOnPause(settings: AppLockSettings): Boolean =
        settings.enabled && settings.grace == Grace.IMMEDIATELY
}
