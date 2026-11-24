package com.companionintelligence.applock

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * JVM unit tests for the lock rules in [AppLockPolicy] and the wire mapping in [Grace].
 * These are the whole of the lock's decision logic; the prompt, the overlay and the
 * window flag need an Activity and are exercised on a device.
 */
class AppLockPolicyTest {
    private val on = AppLockSettings(enabled = true)

    @Test
    fun a_cold_start_locks_only_when_the_lock_is_on() {
        assertTrue(AppLockPolicy.locksOnLaunch(on))
        assertFalse(AppLockPolicy.locksOnLaunch(AppLockSettings(enabled = false)))
    }

    @Test
    fun returning_inside_the_grace_stays_unlocked_and_at_or_past_it_locks() {
        val thirty = on.copy(grace = Grace.THIRTY_SECONDS)

        assertFalse(AppLockPolicy.locksOnResume(thirty, backgroundedAtMs = 0, nowMs = 29_999))
        assertTrue(AppLockPolicy.locksOnResume(thirty, backgroundedAtMs = 0, nowMs = 30_000))
        assertTrue(AppLockPolicy.locksOnResume(thirty, backgroundedAtMs = 0, nowMs = 86_400_000))
    }

    @Test
    fun immediately_locks_on_the_way_out_and_on_the_way_back() {
        val now = on.copy(grace = Grace.IMMEDIATELY)

        assertTrue(AppLockPolicy.locksOnPause(now))
        assertTrue(AppLockPolicy.locksOnResume(now, backgroundedAtMs = 1_000, nowMs = 1_000))
        // The other graces wait for the resume decision; the switcher snapshot is FLAG_SECURE's job.
        assertFalse(AppLockPolicy.locksOnPause(on.copy(grace = Grace.THIRTY_SECONDS)))
    }

    @Test
    fun never_locks_only_on_launch_and_on_request() {
        val never = on.copy(grace = Grace.NEVER)

        assertTrue(AppLockPolicy.locksOnLaunch(never))
        assertFalse(AppLockPolicy.locksOnResume(never, backgroundedAtMs = 0, nowMs = Long.MAX_VALUE / 2))
        assertFalse(AppLockPolicy.locksOnPause(never))
    }

    @Test
    fun a_resume_that_was_never_preceded_by_a_pause_does_not_lock() {
        // First resume after launch: the launch rule already decided; a null timestamp must not count as "forever ago".
        assertFalse(AppLockPolicy.locksOnResume(on, backgroundedAtMs = null, nowMs = 10_000_000))
    }

    @Test
    fun a_disabled_lock_never_locks_whatever_the_timing() {
        val off = AppLockSettings(enabled = false, grace = Grace.IMMEDIATELY)

        assertFalse(AppLockPolicy.locksOnResume(off, backgroundedAtMs = 0, nowMs = 10_000_000))
        assertFalse(AppLockPolicy.locksOnPause(off))
    }

    @Test
    fun grace_wire_values_round_trip_and_an_unknown_one_falls_back_to_the_default() {
        for (grace in Grace.entries) {
            assertEquals(grace, Grace.fromWire(grace.wire))
        }

        assertEquals(Grace.THIRTY_SECONDS, Grace.fromWire(null))
        assertEquals(Grace.THIRTY_SECONDS, Grace.fromWire("forty-two"))
    }

    @Test
    fun every_grace_wire_value_is_a_member_of_the_typescript_union() {
        // ../src/definitions.ts, read off disk the way @ci/capacitor-speech's tests do, so a rename
        // on either side fails here rather than at runtime as "unknown grace → default".
        val definitions = RepoFiles.pluginSource("src/definitions.ts").readText()
        val union = Regex("export type AppLockGrace = ([^;]+);").find(definitions)?.groupValues?.get(1)
            ?: error("AppLockGrace union not found in definitions.ts")
        val members = Regex("'([^']+)'").findAll(union).map { it.groupValues[1] }.toSet()

        assertEquals(members, Grace.entries.map { it.wire }.toSet())
    }
}

/** Finds the plugin package root from wherever Gradle runs the test, like the speech plugin's helper. */
object RepoFiles {
    fun pluginSource(relative: String): File {
        var dir: File? = File(System.getProperty("user.dir")).absoluteFile

        repeat(6) {
            val candidate = File(dir, relative)

            if (candidate.exists()) {
                return candidate
            }

            dir = dir?.parentFile
        }

        error("could not find $relative above ${System.getProperty("user.dir")}")
    }
}
