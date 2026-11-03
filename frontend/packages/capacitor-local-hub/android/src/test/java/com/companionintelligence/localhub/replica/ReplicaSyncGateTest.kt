package com.companionintelligence.localhub.replica

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import kotlin.concurrent.thread
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ReplicaSyncGateTest {
    @After
    fun reset() {
        ReplicaSyncGate.endBackgroundRun()
        ReplicaSyncGate.releaseFromApp()
    }

    @Test
    fun `no background run while the app holds the replica, and one at a time otherwise`() {
        ReplicaSyncGate.claimForApp(timeoutMs = 0)
        assertFalse(ReplicaSyncGate.tryBeginBackgroundRun())

        ReplicaSyncGate.releaseFromApp()
        assertTrue(ReplicaSyncGate.tryBeginBackgroundRun())
        assertFalse(ReplicaSyncGate.tryBeginBackgroundRun())
    }

    @Test
    fun `a claim stops a run in progress by closing its stream, and waits for it to end`() {
        assertTrue(ReplicaSyncGate.tryBeginBackgroundRun())
        val streamClosed = CountDownLatch(1)
        ReplicaSyncGate.onCancel { streamClosed.countDown() }
        // The run notices (its read fails), stops the core and ends.
        val run = thread {
            streamClosed.await(5, TimeUnit.SECONDS)
            Thread.sleep(50)
            ReplicaSyncGate.endBackgroundRun()
        }

        val free = ReplicaSyncGate.claimForApp(timeoutMs = 5_000)

        assertTrue(free)
        assertEquals(0L, streamClosed.count)
        run.join()
    }

    @Test
    fun `a claim landing before the stream opened still cancels it once it does`() {
        assertTrue(ReplicaSyncGate.tryBeginBackgroundRun())
        val claimed = thread { ReplicaSyncGate.claimForApp(timeoutMs = 5_000) }
        while (!ReplicaSyncGate.isCancelled) Thread.sleep(5)

        var closed = false
        ReplicaSyncGate.onCancel { closed = true }
        ReplicaSyncGate.endBackgroundRun()
        claimed.join()

        assertTrue(closed)
    }

    @Test
    fun `a claim gives up waiting after its timeout and says the replica is not yet free`() {
        assertTrue(ReplicaSyncGate.tryBeginBackgroundRun())

        assertFalse(ReplicaSyncGate.claimForApp(timeoutMs = 20))
    }

    @Test
    fun `a config missing anything needed is no config`() {
        val full = JSONObject()
            .put("apiBaseUrl", "https://memory.example/")
            .put("databaseFile", "ci-powersyncSQLite.db")
            .put("lookbackDays", 14)
            .put("startOptions", """{"schema":{}}""")
        assertEquals("https://memory.example", ReplicaSyncConfig.fromJson(full)?.apiBaseUrl)
        assertEquals(ReplicaSyncConfig.fromJson(full), ReplicaSyncConfig.fromJson(ReplicaSyncConfig.fromJson(full)!!.toJson()))

        for (broken in listOf(
            JSONObject(full.toString()).put("apiBaseUrl", ""),
            JSONObject(full.toString()).put("databaseFile", "../elsewhere.db"),
            JSONObject(full.toString()).put("lookbackDays", 0),
            JSONObject(full.toString()).put("startOptions", "not json"),
        )) {
            assertNull(broken.toString(), ReplicaSyncConfig.fromJson(broken))
        }
    }
}
