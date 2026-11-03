package com.companionintelligence.localhub.upload

import com.companionintelligence.localhub.EnqueueOutcome
import com.companionintelligence.localhub.OutboxCounts
import com.companionintelligence.localhub.OutboxItem
import com.companionintelligence.localhub.OutboxQueue
import com.companionintelligence.localhub.location.PositionRecordJson
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** A real little queue: rows go away on delete and move to needs_attention on a permanent failure. */
private class MemoryOutbox : OutboxQueue {
    override val maxItems = 100
    override val warnAt = 80
    val rows = mutableListOf<OutboxItem>()
    private var seq = 0L

    fun add(kind: String = PositionRecordJson.OUTBOX_KIND, owner: String?, payload: String = "{\"n\":${seq + 1}}"): OutboxItem {
        seq += 1
        val item = OutboxItem("id-$seq", kind, "2026-10-30T00:00:00Z", seq, "pending", 0, null, payload, owner)
        rows += item
        return item
    }

    override fun enqueue(kind: String, payloadJson: String, capturedAt: String, idempotencyKey: String, owner: String?): EnqueueOutcome =
        throw UnsupportedOperationException()

    override fun list(statusFilter: String?): List<OutboxItem> =
        rows.filter { statusFilter == null || it.status == statusFilter }.map { it.copy(payload = null) }

    override fun get(id: String): OutboxItem? = rows.firstOrNull { it.id == id }

    override fun delete(id: String): Boolean = rows.removeIf { it.id == id }

    override fun deleteAll(): Int = rows.size.also { rows.clear() }

    override fun recordFailedAttempt(id: String, error: String, permanent: Boolean): OutboxItem? {
        val index = rows.indexOfFirst { it.id == id }
        if (index < 0) return null
        val row = rows[index]
        rows[index] = row.copy(attempts = row.attempts + 1, lastError = error, status = if (permanent) "needs_attention" else "pending")
        return rows[index]
    }

    override fun retry(id: String): OutboxItem? = null

    override fun counts(): OutboxCounts = OutboxCounts(
        pending = rows.count { it.status == "pending" },
        needsAttention = rows.count { it.status == "needs_attention" },
        total = rows.size,
    )
}

/** Answers from a script, one status per request in order; null plays "no response". */
private class ScriptedTransport(vararg statuses: Int?) : UploadTransport {
    private val script = ArrayDeque(statuses.toList())
    val requests = mutableListOf<Triple<String, String, String>>()
    /** Optional hook run before answering, to play a fix queued mid-drain. */
    var beforeAnswer: (() -> Unit)? = null

    override fun postJson(url: String, apiKey: String, body: String): UploadResponse {
        requests += Triple(url, apiKey, body)
        beforeAnswer?.invoke()
        beforeAnswer = null
        val status = if (script.isEmpty()) 201 else script.removeFirst()
        return if (status == null) UploadResponse(null, "unreachable") else UploadResponse(status)
    }
}

private class MemoryDebt : IngestFinishDebt {
    val owed: Boolean get() = value
    private var value = false
    override fun isOwed() = value
    override fun setOwed(owed: Boolean) { value = owed }
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class OutboxUploaderTest {
    private val origin = "https://memory.example.lan"
    private val key = "ci_live_abc123"
    private val mine = OutboxOwnerStamp.of(origin, key)
    private val outbox = MemoryOutbox()
    private val debt = MemoryDebt()

    private fun uploader(transport: UploadTransport) = OutboxUploader(outbox, transport, debt)

    @Test
    fun `uploads this account's positions oldest first, then asks for processing`() {
        outbox.add(owner = mine, payload = "{\"a\":1}")
        outbox.add(owner = mine, payload = "{\"a\":2}")
        val transport = ScriptedTransport()

        val outcome = uploader(transport).drain(origin, key)

        assertEquals(OutboxUploader.Outcome.Done(2), outcome)
        assertTrue(outbox.rows.isEmpty())
        assertEquals(
            listOf(
                Triple("$origin/api/v1/positions", key, "{\"a\":1}"),
                Triple("$origin/api/v1/positions", key, "{\"a\":2}"),
            ),
            transport.requests.take(2),
        )
        val (finishUrl, _, finishBody) = transport.requests[2]
        assertEquals("$origin/api/v1/ingest/finish", finishUrl)
        assertEquals("[\"reverse_position\",\"estimate_locations\"]", JSONObject(finishBody).getJSONArray("stages").toString())
        assertFalse(debt.owed)
    }

    @Test
    fun `leaves rows from another account, another appliance, or another kind alone`() {
        outbox.add(owner = OutboxOwnerStamp.of(origin, "someone-else"))
        outbox.add(owner = OutboxOwnerStamp.of("https://other.example", key))
        outbox.add(owner = null)
        outbox.add(kind = "note", owner = mine)
        val transport = ScriptedTransport()

        val outcome = uploader(transport).drain(origin, key)

        assertEquals(OutboxUploader.Outcome.Done(0), outcome)
        assertEquals(4, outbox.rows.size)
        assertTrue(transport.requests.isEmpty())
    }

    @Test
    fun `a trailing slash on the origin still matches the app's stamp`() {
        outbox.add(owner = mine)
        val transport = ScriptedTransport()

        uploader(transport).drain("$origin/", key)

        assertTrue(outbox.rows.isEmpty())
        assertEquals("$origin/api/v1/positions", transport.requests[0].first)
    }

    @Test
    fun `an unreachable appliance stops the drain without spending attempts`() {
        outbox.add(owner = mine)
        outbox.add(owner = mine)
        val transport = ScriptedTransport(null)

        val outcome = uploader(transport).drain(origin, key)

        assertTrue(outcome is OutboxUploader.Outcome.RetryLater)
        assertEquals(1, transport.requests.size)
        assertEquals(listOf(0, 0), outbox.rows.map { it.attempts })
        assertTrue(outbox.rows.all { it.status == "pending" })
    }

    @Test
    fun `server errors and retryable 4xx are transient too`() {
        for (status in listOf(500, 503, 401, 403, 408, 429)) {
            outbox.rows.clear()
            outbox.add(owner = mine)

            val outcome = uploader(ScriptedTransport(status)).drain(origin, key)

            assertTrue("HTTP $status", outcome is OutboxUploader.Outcome.RetryLater)
            assertEquals("HTTP $status", "pending", outbox.rows.single().status)
        }
    }

    @Test
    fun `a rejected payload is parked for the person and the rest still go`() {
        outbox.add(owner = mine)
        outbox.add(owner = mine)
        val transport = ScriptedTransport(422, 201)

        val outcome = uploader(transport).drain(origin, key)

        assertEquals(OutboxUploader.Outcome.Done(1), outcome)
        val parked = outbox.rows.single()
        assertEquals("id-1", parked.id)
        assertEquals("needs_attention", parked.status)
        assertEquals("HTTP 422", parked.lastError)
    }

    @Test
    fun `a fix queued during the drain goes out in the same run`() {
        outbox.add(owner = mine)
        val transport = ScriptedTransport()
        transport.beforeAnswer = { outbox.add(owner = mine) }

        val outcome = uploader(transport).drain(origin, key)

        assertEquals(OutboxUploader.Outcome.Done(2), outcome)
        assertTrue(outbox.rows.isEmpty())
    }

    @Test
    fun `a failed processing request stays owed and is retried even with nothing new to send`() {
        outbox.add(owner = mine)

        val first = uploader(ScriptedTransport(201, null)).drain(origin, key)
        assertTrue(first is OutboxUploader.Outcome.RetryLater)
        assertTrue(outbox.rows.isEmpty())
        assertTrue(debt.owed)

        val transport = ScriptedTransport()
        val second = uploader(transport).drain(origin, key)
        assertEquals(OutboxUploader.Outcome.Done(0), second)
        assertEquals("$origin/api/v1/ingest/finish", transport.requests.single().first)
        assertFalse(debt.owed)
    }

    @Test
    fun `processing already running for this account is asked again later`() {
        outbox.add(owner = mine)

        val outcome = uploader(ScriptedTransport(201, 409)).drain(origin, key)

        assertTrue(outcome is OutboxUploader.Outcome.RetryLater)
        assertTrue(debt.owed)
    }

    @Test
    fun `nothing sent and nothing owed means no requests at all`() {
        val transport = ScriptedTransport()

        assertEquals(OutboxUploader.Outcome.Done(0), uploader(transport).drain(origin, key))
        assertTrue(transport.requests.isEmpty())
    }
}
