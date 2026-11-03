package com.companionintelligence.localhub.replica

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** A scripted core: answers each control call from [replies] by op (and, for lines, by content). */
private class FakeCore(
    private val pending: Int = 0,
    private val startReply: String = """[{"EstablishSyncStream":{"request":{"buckets":[]}}}]""",
    private val lineReplies: Map<String, String> = emptyMap(),
) : ReplicaCore {
    val calls = mutableListOf<Pair<String, String?>>()
    var closed = false

    override fun control(op: String, payload: String?): String {
        calls += op to payload
        return when (op) {
            "start" -> startReply
            "line_text" -> lineReplies[payload] ?: "[]"
            else -> "[]"
        }
    }

    override fun pendingUploads(): Int = pending

    override fun close() {
        closed = true
    }
}

private class FakeTransport(private val lines: List<String>) : ReplicaTransport {
    var credentialFetches = 0
    var openedWith: String? = null
    var streamClosed = false

    override fun fetchCredentials(): ReplicaCredentials {
        credentialFetches += 1
        return ReplicaCredentials("https://memory.example/powersync", "jwt")
    }

    override fun openStream(credentials: ReplicaCredentials, requestBody: String): SyncLineSource {
        openedWith = requestBody
        val remaining = ArrayDeque(lines)
        return object : SyncLineSource {
            override fun readLine(): String? = remaining.removeFirstOrNull()

            override fun close() {
                streamClosed = true
            }
        }
    }
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ReplicaSyncRunnerTest {
    private val startOptions = """{"parameters":{},"schema":{"tables":[]}}"""
    private val checkpoint = """{"checkpoint":{"last_op_id":"10822"}}"""
    private val data = """{"data":{"bucket":"b"}}"""
    private val complete = """{"checkpoint_complete":{"last_op_id":"10822"}}"""
    private val far = Long.MAX_VALUE

    @Test
    fun `syncs to the first complete checkpoint the way the JS client drives the core, then stops`() {
        val core = FakeCore(lineReplies = mapOf(complete to """[{"LogLine":{"line":"applied"}},{"DidCompleteSync":{}}]"""))
        val transport = FakeTransport(listOf(checkpoint, "", data, complete, """{"never":"read"}"""))

        val outcome = ReplicaSyncRunner(transport, { core }, startOptions).run(far)

        assertEquals(ReplicaSyncRunner.Outcome.Completed(lines = 3), outcome)
        assertEquals(
            listOf(
                "start" to startOptions,
                "connection" to "established",
                "line_text" to checkpoint,
                "line_text" to data,
                "line_text" to complete,
                "stop" to null,
            ),
            core.calls,
        )
        // The core's own request, verbatim.
        assertEquals(JSONObject("""{"buckets":[]}""").toString(), transport.openedWith)
        assertTrue(transport.streamClosed)
        assertTrue(core.closed)
    }

    @Test
    fun `does not touch the network with local writes waiting for the app to upload`() {
        val core = FakeCore(pending = 2)
        val transport = FakeTransport(listOf(complete))

        val outcome = ReplicaSyncRunner(transport, { core }, startOptions).run(far)

        assertTrue(outcome is ReplicaSyncRunner.Outcome.Skipped)
        assertEquals(0, transport.credentialFetches)
        assertTrue(core.calls.isEmpty())
        assertTrue(core.closed)
    }

    @Test
    fun `nothing to sync without a replica on the phone`() {
        val transport = FakeTransport(emptyList())

        val outcome = ReplicaSyncRunner(transport, { null }, startOptions).run(far)

        assertTrue(outcome is ReplicaSyncRunner.Outcome.Skipped)
        assertEquals(0, transport.credentialFetches)
    }

    @Test
    fun `an expired token, a closed stream, or the service hanging up end the run, and always stop the core`() {
        val cases = listOf(
            """[{"FetchCredentials":{"did_expire":true}}]""" to "the sync token expired",
            """[{"CloseSyncStream":{"hide_disconnect":false}}]""" to "the core closed the stream",
        )
        for ((reply, reason) in cases) {
            val core = FakeCore(lineReplies = mapOf(data to reply))
            val outcome = ReplicaSyncRunner(FakeTransport(listOf(data, complete)), { core }, startOptions).run(far)

            assertEquals(ReplicaSyncRunner.Outcome.Stopped(reason, lines = 1), outcome)
            assertEquals("stop" to null, core.calls.last())
        }

        val core = FakeCore()
        val outcome = ReplicaSyncRunner(FakeTransport(listOf(data)), { core }, startOptions).run(far)
        assertEquals(ReplicaSyncRunner.Outcome.Stopped("the service ended the stream", lines = 1), outcome)
        assertEquals("stop" to null, core.calls.last())
    }

    @Test
    fun `a credentials refresh that is not an expiry does not end the run`() {
        val core = FakeCore(
            lineReplies = mapOf(
                data to """[{"FetchCredentials":{"did_expire":false}}]""",
                complete to """[{"DidCompleteSync":{}}]""",
            ),
        )

        val outcome = ReplicaSyncRunner(FakeTransport(listOf(data, complete)), { core }, startOptions).run(far)

        assertEquals(ReplicaSyncRunner.Outcome.Completed(lines = 2), outcome)
    }

    @Test
    fun `stops between lines when the app takes the replica, or when time is up`() {
        var cancelled = false
        val core = FakeCore(lineReplies = mapOf(data to "[]"))
        val outcome = ReplicaSyncRunner(FakeTransport(listOf(data, data, complete)), { core }, startOptions)
            .run(far, isCancelled = { cancelled.also { cancelled = true } })
        assertEquals(ReplicaSyncRunner.Outcome.Stopped("cancelled: the app took the replica", lines = 1), outcome)
        assertEquals("stop" to null, core.calls.last())

        var now = 0L
        val timed = FakeCore()
        val late = ReplicaSyncRunner(FakeTransport(listOf(data, data, complete)), { timed }, startOptions, nowMs = { now })
            .run(deadlineMs = 1, onStreamOpen = { now = 5 })
        assertEquals(ReplicaSyncRunner.Outcome.Stopped("out of time", lines = 0), late)
    }

    @Test
    fun `a core that asks for no stream is a stopped run, not a hang`() {
        val core = FakeCore(startReply = """[{"LogLine":{"line":"nothing"}}]""")
        val transport = FakeTransport(listOf(complete))

        val outcome = ReplicaSyncRunner(transport, { core }, startOptions).run(far)

        assertEquals(ReplicaSyncRunner.Outcome.Stopped("the core did not ask for a sync stream", lines = 0), outcome)
        assertEquals(null, transport.openedWith)
        assertEquals(listOf("start" to startOptions, "stop" to null), core.calls)
    }
}
