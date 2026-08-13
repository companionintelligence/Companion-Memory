package com.companionintelligence.localhub

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.net.HttpURLConnection
import java.net.URL
import java.security.KeyPairGenerator
import java.security.KeyStore
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * On-device (instrumented) verification that [LocalHubServer] actually binds, listens on
 * loopback, enforces the bearer token, and that the durable outbox behind `/api/outbox`
 * really persists -- run via `connectedAndroidTest` against a real emulator/device rather
 * than only asserted by code review. Exercises the real `java.net.ServerSocket`/HTTP stack
 * end to end (a real `HttpURLConnection` client talking to the real bound port) against a
 * real on-disk SQLite database in the test app's private storage.
 *
 * Every test gets a freshly deleted database file ([TEST_DATABASE_NAME]) so state can't
 * leak between tests; the durability test deliberately reuses that same file across two
 * separate [OutboxStore]/[LocalHubServer] instances, which is the whole point of it.
 *
 * The database is SQLCipher-encrypted, so "a real on-disk database" now also means a real
 * AndroidKeyStore key behind it. Two groups of tests exist because of that: one that reads the
 * raw file back off disk and asserts it is *not* plaintext SQLite, and one that builds a
 * genuine pre-encryption plaintext outbox with the framework driver and asserts every queued
 * row survives the migration into the encrypted one.
 */
@RunWith(AndroidJUnit4::class)
class LocalHubServerTest {
    private val context: Context
        get() = InstrumentationRegistry.getInstrumentation().targetContext

    private val startedServers = mutableListOf<LocalHubServer>()
    private val openedStores = mutableListOf<OutboxStore>()

    @Before
    fun setUp() {
        context.deleteDatabase(TEST_DATABASE_NAME)
        context.deleteDatabase(LEGACY_TEST_DATABASE_NAME)
        clearTestKeystoreState()
    }

    @After
    fun tearDown() {
        startedServers.forEach { it.stop() }
        startedServers.clear()
        openedStores.forEach { it.close() }
        openedStores.clear()
        context.deleteDatabase(TEST_DATABASE_NAME)
        context.deleteDatabase(LEGACY_TEST_DATABASE_NAME)
        context.deleteDatabase("ci_local_hub_outbox_keyless_test.db")
        clearTestKeystoreState()
    }

    // ------------------------------------------------------------------ health + transport

    @Test
    fun healthEndpoint_withValidToken_returns200WithExpectedBody() {
        val token = "test-token-abc123"
        val srv = startServer(token)

        val connection = openConnection(srv.listeningPort, "/api/health", "GET", "Bearer $token")
        try {
            assertEquals(200, connection.responseCode)
            val body = connection.inputStream.bufferedReader().readText()
            assertTrue("body was: $body", body.contains("\"status\":\"ok\""))
            assertTrue("body was: $body", body.contains("\"version\":\"${LocalHubServer.API_VERSION}\""))
        } finally {
            connection.disconnect()
        }
    }

    @Test
    fun healthEndpoint_withMissingAuthHeader_returns401() {
        val srv = startServer("test-token-abc123")

        val connection = openConnection(srv.listeningPort, "/api/health", "GET", authHeader = null)
        try {
            assertEquals(401, connection.responseCode)
        } finally {
            connection.disconnect()
        }
    }

    @Test
    fun healthEndpoint_withWrongToken_returns401() {
        val srv = startServer("correct-token")

        val connection = openConnection(srv.listeningPort, "/api/health", "GET", "Bearer wrong-token")
        try {
            assertEquals(401, connection.responseCode)
        } finally {
            connection.disconnect()
        }
    }

    @Test
    fun server_bindsToLoopbackAddressOnly() {
        val srv = startServer("any-token")

        // The bound hostname is exactly 127.0.0.1 -- never 0.0.0.0 / any-address.
        assertEquals("127.0.0.1", srv.hostname)
        assertTrue("expected an OS-assigned ephemeral port, got ${srv.listeningPort}", srv.listeningPort > 0)
    }

    // Regression coverage for a real bug found via end-to-end device testing (not caught by
    // the tests above): HttpURLConnection is a plain HTTP client, not a browser, so it never
    // enforces CORS -- these tests can only check that the *header* is present, the same
    // thing a real browser's preflight check reads. The actual failure mode (a real WebView
    // `fetch()` rejecting the response before JS ever saw it) can only be observed by running
    // the app and watching a real CORS error appear/disappear in logcat; that verification
    // happened separately on-device, this just locks in the fix so it can't regress silently.
    @Test
    fun optionsPreflight_succeedsWithoutAuth_andCarriesCorsHeaders() {
        val srv = startServer("any-token")

        val connection = openConnection(srv.listeningPort, "/api/health", "OPTIONS", authHeader = null)
        try {
            // No Authorization header on a preflight -- must not be treated as unauthorized.
            assertTrue(
                "expected 2xx for an unauthenticated preflight, got ${connection.responseCode}",
                connection.responseCode in 200..299,
            )
            assertEquals("*", connection.getHeaderField("Access-Control-Allow-Origin"))
            assertTrue(
                "expected Authorization to be allowed as a preflighted header",
                connection.getHeaderField("Access-Control-Allow-Headers")?.contains("Authorization") == true,
            )
        } finally {
            connection.disconnect()
        }
    }

    @Test
    fun healthEndpoint_response_carriesCorsHeaderRegardlessOfAuthOutcome() {
        val token = "test-token-abc123"
        val srv = startServer(token)

        // The browser reads Access-Control-Allow-Origin off *every* response in a CORS
        // context to decide whether JS may see it -- including error responses, which is
        // exactly the case the original bug hit (a 401/404 with no CORS header is just as
        // unreadable to `fetch()` as a 200 with no CORS header).
        val unauthorized = openConnection(srv.listeningPort, "/api/health", "GET", authHeader = null)
        try {
            assertEquals(401, unauthorized.responseCode)
            assertEquals("*", unauthorized.getHeaderField("Access-Control-Allow-Origin"))
        } finally {
            unauthorized.disconnect()
        }

        val authorized = openConnection(srv.listeningPort, "/api/health", "GET", "Bearer $token")
        try {
            assertEquals(200, authorized.responseCode)
            assertEquals("*", authorized.getHeaderField("Access-Control-Allow-Origin"))
        } finally {
            authorized.disconnect()
        }
    }

    /**
     * The outbox routes send JSON bodies, and `Content-Type: application/json` is itself a
     * CORS preflight trigger. If `Content-Type` is missing from `Access-Control-Allow-Headers`
     * the browser rejects `POST /api/outbox` before it is ever sent -- the identical failure
     * mode the missing `Access-Control-Allow-Origin` caused on GET.
     */
    @Test
    fun outboxPost_preflightAllowsContentTypeHeader_andPostResponseCarriesCors() {
        val token = "cors-token"
        val srv = startServer(token)

        val preflight = openConnection(srv.listeningPort, "/api/outbox", "OPTIONS", authHeader = null)
        try {
            assertTrue(
                "expected 2xx for an unauthenticated preflight, got ${preflight.responseCode}",
                preflight.responseCode in 200..299,
            )
            val allowedHeaders = preflight.getHeaderField("Access-Control-Allow-Headers").orEmpty()
            assertTrue("Allow-Headers was: $allowedHeaders", allowedHeaders.contains("Content-Type"))
            val allowedMethods = preflight.getHeaderField("Access-Control-Allow-Methods").orEmpty()
            assertTrue("Allow-Methods was: $allowedMethods", allowedMethods.contains("POST"))
            assertTrue("Allow-Methods was: $allowedMethods", allowedMethods.contains("DELETE"))
        } finally {
            preflight.disconnect()
        }

        val response = post(srv, token, "/api/outbox", enqueueBody(idempotencyKey = "cors-1"))
        assertEquals(201, response.code)
        assertEquals("*", response.headers["Access-Control-Allow-Origin"])
    }

    // ------------------------------------------------------------------ outbox: enqueue + list

    @Test
    fun enqueueThenList_returnsItemWithCountsAndCapacity() {
        val token = "outbox-token"
        val srv = startServer(token)

        val created = post(
            srv,
            token,
            "/api/outbox",
            enqueueBody(
                kind = "note",
                payload = JSONObject().put("text", "hello from the emulator"),
                capturedAt = "2026-08-13T10:00:00.000Z",
                idempotencyKey = "key-1",
            ),
        )
        assertEquals(201, created.code)
        val createdJson = created.json()
        assertEquals("pending", createdJson.getString("status"))
        assertEquals("2026-08-13T10:00:00.000Z", createdJson.getString("capturedAt"))
        assertTrue("expected a non-empty id", createdJson.getString("id").isNotEmpty())
        assertTrue("seq should be a positive monotonic counter", createdJson.getLong("seq") > 0)

        val listed = get(srv, token, "/api/outbox")
        assertEquals(200, listed.code)
        val listJson = listed.json()

        val items = listJson.getJSONArray("items")
        assertEquals(1, items.length())
        val item = items.getJSONObject(0)
        assertEquals(createdJson.getString("id"), item.getString("id"))
        assertEquals("note", item.getString("kind"))
        assertEquals("2026-08-13T10:00:00.000Z", item.getString("capturedAt"))
        assertEquals("pending", item.getString("status"))
        assertEquals(0, item.getInt("attempts"))
        assertTrue("lastError should be present and null on a fresh item", item.isNull("lastError"))
        // The list view deliberately omits payloads -- they can be large and a queue-depth
        // poll should not have to stream them.
        assertFalse("list items must not carry payloads", item.has("payload"))

        val counts = listJson.getJSONObject("counts")
        assertEquals(1, counts.getInt("pending"))
        assertEquals(0, counts.getInt("needsAttention"))
        assertEquals(1, counts.getInt("total"))

        val capacity = listJson.getJSONObject("capacity")
        assertEquals(OutboxStore.MAX_ITEMS, capacity.getInt("max"))
        assertEquals(1, capacity.getInt("used"))
        assertEquals(OutboxStore.MAX_ITEMS * 8 / 10, capacity.getInt("warnAt"))
    }

    @Test
    fun list_isFifoOrderedBySeq_evenWhenCapturedAtMovesBackwards() {
        val token = "fifo-token"
        val srv = startServer(token)

        // Descending capturedAt on purpose: the device clock can jump backwards (NTP
        // correction, user change), and replay order must follow insertion order, not time.
        val insertionOrder = listOf("first", "second", "third", "fourth")
        val capturedAts = listOf(
            "2026-08-13T10:00:03.000Z",
            "2026-08-13T10:00:02.000Z",
            "2026-08-13T10:00:01.000Z",
            "2026-08-13T10:00:00.000Z",
        )
        val ids = insertionOrder.mapIndexed { index, name ->
            val response = post(
                srv,
                token,
                "/api/outbox",
                enqueueBody(
                    kind = name,
                    capturedAt = capturedAts[index],
                    idempotencyKey = "fifo-$index",
                ),
            )
            assertEquals(201, response.code)
            response.json().getString("id")
        }

        val items = get(srv, token, "/api/outbox").json().getJSONArray("items")
        assertEquals(4, items.length())

        var previousSeq = 0L
        items.forEachObject { index, item ->
            assertEquals("wrong item at position $index", ids[index], item.getString("id"))
            assertEquals(insertionOrder[index], item.getString("kind"))
            assertTrue("seq must strictly increase; got ${item.getLong("seq")} after $previousSeq", item.getLong("seq") > previousSeq)
            previousSeq = item.getLong("seq")
        }
    }

    /**
     * Deleting the newest row must not let the next insert reuse its seq. Without
     * `AUTOINCREMENT` SQLite hands back the freed rowid, and the replacement item would sort
     * *ahead* of items that were already queued -- a silent FIFO violation.
     */
    @Test
    fun seq_isNeverReusedAfterTheNewestItemIsDeleted() {
        val token = "seq-token"
        val srv = startServer(token)

        val firstId = post(srv, token, "/api/outbox", enqueueBody(idempotencyKey = "seq-1")).json().getString("id")
        val second = post(srv, token, "/api/outbox", enqueueBody(idempotencyKey = "seq-2")).json()
        val secondSeq = second.getLong("seq")

        assertEquals(204, delete(srv, token, "/api/outbox/${second.getString("id")}").code)

        val third = post(srv, token, "/api/outbox", enqueueBody(idempotencyKey = "seq-3")).json()
        assertTrue(
            "seq ${third.getLong("seq")} was reused after deleting seq $secondSeq",
            third.getLong("seq") > secondSeq,
        )

        val items = get(srv, token, "/api/outbox").json().getJSONArray("items")
        assertEquals(2, items.length())
        assertEquals(firstId, items.getJSONObject(0).getString("id"))
        assertEquals(third.getString("id"), items.getJSONObject(1).getString("id"))
    }

    @Test
    fun enqueue_withReplayedIdempotencyKey_doesNotDuplicate() {
        val token = "idem-token"
        val srv = startServer(token)

        val body = enqueueBody(
            kind = "capture",
            payload = JSONObject().put("text", "only once"),
            capturedAt = "2026-08-13T11:00:00.000Z",
            idempotencyKey = "stable-key",
        )

        val first = post(srv, token, "/api/outbox", body)
        assertEquals(201, first.code)

        // Same key, *different* payload/capturedAt: a client retrying a request whose
        // response it never saw. The original row must win; nothing may be overwritten and
        // nothing may be duplicated.
        val replay = post(
            srv,
            token,
            "/api/outbox",
            enqueueBody(
                kind = "capture",
                payload = JSONObject().put("text", "a different body"),
                capturedAt = "2026-08-13T12:00:00.000Z",
                idempotencyKey = "stable-key",
            ),
        )
        assertEquals(201, replay.code)
        assertEquals(first.json().getString("id"), replay.json().getString("id"))
        assertEquals(first.json().getLong("seq"), replay.json().getLong("seq"))
        assertEquals("2026-08-13T11:00:00.000Z", replay.json().getString("capturedAt"))

        val listJson = get(srv, token, "/api/outbox").json()
        assertEquals(1, listJson.getJSONArray("items").length())
        assertEquals(1, listJson.getJSONObject("counts").getInt("total"))

        val stored = get(srv, token, "/api/outbox/${first.json().getString("id")}").json()
        assertEquals("only once", stored.getJSONObject("payload").getString("text"))
    }

    @Test
    fun enqueue_withMissingOrMalformedFields_returns400AndStoresNothing() {
        val token = "validation-token"
        val srv = startServer(token)

        val invalidBodies = listOf(
            "not json at all",
            JSONObject().put("payload", JSONObject()).put("capturedAt", "t").put("idempotencyKey", "k").toString(),
            JSONObject().put("kind", "note").put("capturedAt", "t").put("idempotencyKey", "k").toString(),
            // payload must be an object, not a scalar
            JSONObject().put("kind", "note").put("payload", "nope").put("capturedAt", "t").put("idempotencyKey", "k").toString(),
            JSONObject().put("kind", "note").put("payload", JSONObject()).put("idempotencyKey", "k").toString(),
            JSONObject().put("kind", "note").put("payload", JSONObject()).put("capturedAt", "t").toString(),
        )

        invalidBodies.forEachIndexed { index, body ->
            val response = post(srv, token, "/api/outbox", body)
            assertEquals("body #$index should have been rejected: $body", 400, response.code)
        }

        assertEquals(0, get(srv, token, "/api/outbox").json().getJSONObject("counts").getInt("total"))
    }

    @Test
    fun list_statusFilter_selectsPendingOrNeedsAttention() {
        val token = "filter-token"
        val srv = startServer(token)

        val pendingId = post(srv, token, "/api/outbox", enqueueBody(idempotencyKey = "filter-1")).json().getString("id")
        val stuckId = post(srv, token, "/api/outbox", enqueueBody(idempotencyKey = "filter-2")).json().getString("id")
        assertEquals(
            200,
            post(srv, token, "/api/outbox/$stuckId/attempt", failureBody("nope", permanent = true)).code,
        )

        val pendingOnly = get(srv, token, "/api/outbox?status=pending").json().getJSONArray("items")
        assertEquals(1, pendingOnly.length())
        assertEquals(pendingId, pendingOnly.getJSONObject(0).getString("id"))

        val stuckOnly = get(srv, token, "/api/outbox?status=needs_attention").json().getJSONArray("items")
        assertEquals(1, stuckOnly.length())
        assertEquals(stuckId, stuckOnly.getJSONObject(0).getString("id"))

        assertEquals(2, get(srv, token, "/api/outbox?status=all").json().getJSONArray("items").length())
        assertEquals(400, get(srv, token, "/api/outbox?status=bogus").code)
    }

    // ------------------------------------------------------------------ outbox: single item

    @Test
    fun getSingleItem_returnsPayload_andUnknownIdIs404() {
        val token = "single-token"
        val srv = startServer(token)

        val payload = JSONObject()
            .put("text", "nested payload")
            .put("tags", JSONArray().put("a").put("b"))
            .put("meta", JSONObject().put("source", "mic"))
        val id = post(
            srv,
            token,
            "/api/outbox",
            enqueueBody(kind = "capture", payload = payload, idempotencyKey = "single-1"),
        ).json().getString("id")

        val fetched = get(srv, token, "/api/outbox/$id")
        assertEquals(200, fetched.code)
        val json = fetched.json()
        assertEquals(id, json.getString("id"))
        assertEquals("capture", json.getString("kind"))
        // The payload round-trips as real nested JSON, not as an escaped string.
        val storedPayload = json.getJSONObject("payload")
        assertEquals("nested payload", storedPayload.getString("text"))
        assertEquals("mic", storedPayload.getJSONObject("meta").getString("source"))
        assertEquals(2, storedPayload.getJSONArray("tags").length())

        assertEquals(404, get(srv, token, "/api/outbox/does-not-exist").code)
    }

    @Test
    fun deleteItem_removesIt_andUnknownIdIs404() {
        val token = "delete-token"
        val srv = startServer(token)

        val id = post(srv, token, "/api/outbox", enqueueBody(idempotencyKey = "delete-1")).json().getString("id")

        assertEquals(204, delete(srv, token, "/api/outbox/$id").code)
        assertEquals(404, get(srv, token, "/api/outbox/$id").code)
        assertEquals(0, get(srv, token, "/api/outbox").json().getJSONObject("counts").getInt("total"))

        assertEquals(404, delete(srv, token, "/api/outbox/$id").code)
    }

    // ------------------------------------------------------------------ outbox: attempts

    @Test
    fun failedAttempts_incrementUntilMaxAttempts_thenRetryResetsToPending() {
        val token = "attempt-token"
        val srv = startServer(token)

        val id = post(srv, token, "/api/outbox", enqueueBody(idempotencyKey = "attempt-1")).json().getString("id")

        // Attempts 1..MAX_ATTEMPTS-1 keep the item pending and retryable.
        for (attempt in 1 until OutboxStore.MAX_ATTEMPTS) {
            val response = post(srv, token, "/api/outbox/$id/attempt", failureBody("network unreachable ($attempt)"))
            assertEquals(200, response.code)
            val json = response.json()
            assertEquals(attempt, json.getInt("attempts"))
            assertEquals("pending", json.getString("status"))
            assertEquals("network unreachable ($attempt)", json.getString("lastError"))
        }

        // The MAX_ATTEMPTS-th failure exhausts the budget: the item stops retrying and
        // becomes a visible needs_attention row rather than being dropped.
        val exhausted = post(srv, token, "/api/outbox/$id/attempt", failureBody("still down")).json()
        assertEquals(OutboxStore.MAX_ATTEMPTS, exhausted.getInt("attempts"))
        assertEquals("needs_attention", exhausted.getString("status"))

        val afterCounts = get(srv, token, "/api/outbox").json().getJSONObject("counts")
        assertEquals(0, afterCounts.getInt("pending"))
        assertEquals(1, afterCounts.getInt("needsAttention"))
        assertEquals(1, afterCounts.getInt("total"))

        val retried = post(srv, token, "/api/outbox/$id/retry", body = null)
        assertEquals(200, retried.code)
        assertEquals("pending", retried.json().getString("status"))
        assertEquals(0, retried.json().getInt("attempts"))

        val retriedCounts = get(srv, token, "/api/outbox").json().getJSONObject("counts")
        assertEquals(1, retriedCounts.getInt("pending"))
        assertEquals(0, retriedCounts.getInt("needsAttention"))
    }

    @Test
    fun permanentFailure_movesToNeedsAttentionImmediately() {
        val token = "permanent-token"
        val srv = startServer(token)

        val id = post(srv, token, "/api/outbox", enqueueBody(idempotencyKey = "permanent-1")).json().getString("id")

        val response = post(srv, token, "/api/outbox/$id/attempt", failureBody("422 rejected by server", permanent = true))
        assertEquals(200, response.code)
        val json = response.json()
        assertEquals(1, json.getInt("attempts"))
        assertEquals("needs_attention", json.getString("status"))
        assertEquals("422 rejected by server", json.getString("lastError"))
        // Still on disk, still visible -- a permanent failure is surfaced, never discarded.
        assertEquals(200, get(srv, token, "/api/outbox/$id").code)
    }

    @Test
    fun successfulAttempt_removesTheItem() {
        val token = "success-token"
        val srv = startServer(token)

        val id = post(srv, token, "/api/outbox", enqueueBody(idempotencyKey = "success-1")).json().getString("id")

        val response = post(srv, token, "/api/outbox/$id/attempt", JSONObject().put("ok", true).toString())
        assertEquals(204, response.code)

        assertEquals(404, get(srv, token, "/api/outbox/$id").code)
        assertEquals(0, get(srv, token, "/api/outbox").json().getJSONObject("counts").getInt("total"))

        // A second success report for an already-flushed item is a 404, not a crash.
        assertEquals(404, post(srv, token, "/api/outbox/$id/attempt", JSONObject().put("ok", true).toString()).code)
    }

    @Test
    fun attemptAndRetry_onUnknownId_return404() {
        val token = "unknown-token"
        val srv = startServer(token)

        assertEquals(404, post(srv, token, "/api/outbox/nope/attempt", failureBody("boom")).code)
        assertEquals(404, post(srv, token, "/api/outbox/nope/retry", body = null).code)
    }

    // ------------------------------------------------------------------ outbox: capacity

    /**
     * Drives a deliberately tiny queue into its hard cap. Production uses
     * [OutboxStore.MAX_ITEMS] (5000); filling that over HTTP would make this test unbearably
     * slow, so the cap is injected -- the code path under test (`>= maxItems` -> 507, with
     * nothing evicted) is identical.
     */
    @Test
    fun enqueue_atHardCap_returns507AndKeepsEveryExistingItem() {
        val token = "capacity-token"
        val cap = 3
        val srv = startServer(token, maxItems = cap)

        val acceptedIds = (0 until cap).map { index ->
            val response = post(srv, token, "/api/outbox", enqueueBody(idempotencyKey = "cap-$index"))
            assertEquals(201, response.code)
            response.json().getString("id")
        }

        val rejected = post(srv, token, "/api/outbox", enqueueBody(idempotencyKey = "cap-overflow"))
        assertEquals(507, rejected.code)
        assertEquals("outbox_full", rejected.json().getString("error"))

        // Nothing was evicted to make room -- the cap rejects, it does not rotate.
        val listJson = get(srv, token, "/api/outbox").json()
        val items = listJson.getJSONArray("items")
        assertEquals(cap, items.length())
        items.forEachObject { index, item -> assertEquals(acceptedIds[index], item.getString("id")) }

        val capacity = listJson.getJSONObject("capacity")
        assertEquals(cap, capacity.getInt("max"))
        assertEquals(cap, capacity.getInt("used"))
        assertEquals(cap * 8 / 10, capacity.getInt("warnAt"))

        // Draining one slot makes room again, and the replacement gets a fresh seq.
        assertEquals(204, delete(srv, token, "/api/outbox/${acceptedIds[0]}").code)
        assertEquals(201, post(srv, token, "/api/outbox", enqueueBody(idempotencyKey = "cap-after-drain")).code)
    }

    // ------------------------------------------------------------------ outbox: auth

    @Test
    fun outboxRoutes_withoutAuth_return401AndChangeNothing() {
        val token = "auth-token"
        val srv = startServer(token)

        val id = post(srv, token, "/api/outbox", enqueueBody(idempotencyKey = "auth-1")).json().getString("id")

        assertEquals(401, postRaw(srv, authHeader = null, path = "/api/outbox", body = enqueueBody(idempotencyKey = "auth-2")).code)
        assertEquals(401, getRaw(srv, authHeader = null, path = "/api/outbox").code)
        assertEquals(401, getRaw(srv, authHeader = null, path = "/api/outbox/$id").code)
        assertEquals(401, deleteRaw(srv, authHeader = null, path = "/api/outbox/$id").code)
        assertEquals(401, postRaw(srv, authHeader = null, path = "/api/outbox/$id/attempt", body = failureBody("boom")).code)
        assertEquals(401, postRaw(srv, authHeader = null, path = "/api/outbox/$id/retry", body = null).code)
        assertEquals(
            401,
            postRaw(srv, authHeader = "Bearer wrong-token", path = "/api/outbox", body = enqueueBody(idempotencyKey = "auth-3")).code,
        )

        // The rejected calls must not have enqueued, deleted, or mutated anything.
        val listJson = get(srv, token, "/api/outbox").json()
        assertEquals(1, listJson.getJSONArray("items").length())
        val item = listJson.getJSONArray("items").getJSONObject(0)
        assertEquals(id, item.getString("id"))
        assertEquals(0, item.getInt("attempts"))
        assertEquals("pending", item.getString("status"))
    }

    // ------------------------------------------------------------------ outbox: durability

    /**
     * The durability claim this feature exists for: an accepted item is on disk, not in
     * memory, before the 201 comes back.
     *
     * **What this proves**: the rows survive the [OutboxStore] being closed and a brand-new
     * store + server being opened against the same database file, with a fresh bearer token
     * -- i.e. nothing about the surviving state lives in the old objects.
     *
     * **What this does NOT prove**: an instrumented test runs inside one process, so it
     * cannot literally force-quit the app or reboot the device. That the *same* on-disk file
     * is the only carrier of state here is the closest honest in-process proxy; a real
     * force-quit/reboot survival check needs a manual (or UI-automator-driven) run that
     * kills the app process between the enqueue and the read. Treat this as "the data is
     * genuinely committed to the database file", not as "reboot-tested".
     */
    @Test
    fun enqueuedItems_survive_storeCloseAndReopenAgainstTheSameDatabaseFile() {
        val firstToken = "before-restart"
        val firstServer = startServer(firstToken)

        val created = post(
            srv = firstServer,
            token = firstToken,
            path = "/api/outbox",
            body = enqueueBody(
                kind = "note",
                payload = JSONObject().put("text", "must outlive the process"),
                capturedAt = "2026-08-13T09:30:00.000Z",
                idempotencyKey = "durable-key",
            ),
        )
        assertEquals(201, created.code)
        val id = created.json().getString("id")
        val seq = created.json().getLong("seq")

        // Report one failed attempt too, so we prove the mutable columns persist as well,
        // not just the row.
        assertEquals(200, post(firstServer, firstToken, "/api/outbox/$id/attempt", failureBody("offline")).code)

        // Tear the whole stack down: HTTP listener stopped, database handle closed. The only
        // thing that survives is the file in /data/data/<pkg>/databases/.
        firstServer.stop()
        startedServers.remove(firstServer)
        openedStores.forEach { it.close() }
        openedStores.clear()

        val secondToken = "after-restart"
        val secondServer = startServer(secondToken)

        val listJson = get(secondServer, secondToken, "/api/outbox").json()
        assertEquals(1, listJson.getJSONArray("items").length())
        val item = listJson.getJSONArray("items").getJSONObject(0)
        assertEquals(id, item.getString("id"))
        assertEquals(seq, item.getLong("seq"))
        assertEquals(1, item.getInt("attempts"))
        assertEquals("offline", item.getString("lastError"))
        assertEquals("pending", item.getString("status"))

        val fetched = get(secondServer, secondToken, "/api/outbox/$id").json()
        assertEquals("must outlive the process", fetched.getJSONObject("payload").getString("text"))
        assertEquals("2026-08-13T09:30:00.000Z", fetched.getString("capturedAt"))

        // The old token is dead with the old server instance; the surviving data is not
        // tied to it in any way.
        assertEquals(401, getRaw(secondServer, "Bearer $firstToken", "/api/outbox").code)
    }

    /**
     * The database really is a file in app-private internal storage (which is what makes the
     * OS sandbox, not this code, responsible for keeping other apps out) -- and it exists on
     * disk immediately after the enqueue response, not at some later flush.
     */
    @Test
    fun database_isAFileInAppPrivateInternalStorage() {
        val token = "path-token"
        val srv = startServer(token)

        assertEquals(201, post(srv, token, "/api/outbox", enqueueBody(idempotencyKey = "path-1")).code)

        val databaseFile = context.getDatabasePath(TEST_DATABASE_NAME)
        assertTrue("expected $databaseFile to exist", databaseFile.exists())
        assertTrue("expected a non-empty database file", databaseFile.length() > 0)
        val expectedPrefix = context.applicationInfo.dataDir
        assertTrue(
            "database should live under the app-private data dir ($expectedPrefix), was $databaseFile",
            databaseFile.absolutePath.startsWith(expectedPrefix),
        )
    }

    // ------------------------------------------------------------------ encryption at rest

    /**
     * The claim "the outbox is encrypted at rest" reduced to something a test can actually
     * fail on: a plain SQLite file starts with the 16-byte magic `SQLite format 3\0`, and a
     * SQLCipher file does not -- its very first page, header included, is ciphertext.
     *
     * Paired with a scan for the payload text, because a header check alone would still pass
     * on a file that merely started with something else.
     */
    @Test
    fun databaseFile_isNotReadableAsPlaintextSqlite() {
        val token = "cipher-token"
        val srv = startServer(token)

        val marker = "distinctive-plaintext-marker-4c9a71"
        assertEquals(
            201,
            post(
                srv,
                token,
                "/api/outbox",
                enqueueBody(
                    kind = "note",
                    payload = JSONObject().put("text", marker),
                    idempotencyKey = "cipher-1",
                ),
            ).code,
        )

        val databaseFile = context.getDatabasePath(TEST_DATABASE_NAME)
        assertTrue("expected $databaseFile to exist", databaseFile.exists())
        val bytes = databaseFile.readBytes()
        assertTrue("expected a non-trivial database file", bytes.size > SQLITE_MAGIC.size)

        val header = bytes.copyOfRange(0, SQLITE_MAGIC.size)
        assertFalse(
            "the outbox database still begins with the plain SQLite magic -- it is not encrypted",
            header.contentEquals(SQLITE_MAGIC),
        )
        assertFalse(
            "the payload text is readable in the raw database file",
            bytes.containsSubsequence(marker.toByteArray(Charsets.UTF_8)),
        )
        assertFalse(
            "the idempotency key is readable in the raw database file",
            bytes.containsSubsequence("cipher-1".toByteArray(Charsets.UTF_8)),
        )

        // The rows are of course perfectly readable *through* the store, which is the point:
        // encryption at rest protects the file, not a running process that holds the key.
        val id = get(srv, token, "/api/outbox").json().getJSONArray("items").getJSONObject(0).getString("id")
        assertEquals(marker, get(srv, token, "/api/outbox/$id").json().getJSONObject("payload").getString("text"))
    }

    /**
     * The other half of the same claim: the file is not merely *unreadable as plain SQLite*, it
     * is unreadable without this specific key. A different key produces a failure, not an empty
     * queue -- which is what makes destroying the keystore entry a real crypto-shred.
     */
    @Test
    fun databaseFile_cannotBeOpenedWithADifferentKey() {
        val token = "wrong-key-token"
        val srv = startServer(token)
        assertEquals(201, post(srv, token, "/api/outbox", enqueueBody(idempotencyKey = "wrong-key-1")).code)
        // Close the real handle so the second open is a genuine cold open of the file.
        srv.stop()
        startedServers.remove(srv)
        openedStores.forEach { it.close() }
        openedStores.clear()

        val impostorNamespace = CompanionSecureStore(context, IMPOSTOR_ALIAS, IMPOSTOR_PREFERENCES)
        // A valid-looking but wrong 32-byte key, so the failure is "wrong key", not "no key".
        impostorNamespace.set(OutboxDatabaseKey.DEFAULT_ENTRY_NAME, "ab".repeat(32))
        val impostor = OutboxStore(
            context,
            TEST_DATABASE_NAME,
            OutboxStore.MAX_ITEMS,
            null,
            OutboxDatabaseKey(impostorNamespace),
        )

        var opened = false
        try {
            impostor.open()
            opened = true
        } catch (e: Exception) {
            // Expected: SQLCipher reports the file as unreadable rather than returning rows.
        } finally {
            impostor.close()
        }
        assertFalse("the encrypted outbox opened with the wrong key", opened)
    }

    /**
     * Fail-closed, end to end: with no usable key there is no store, and therefore no database
     * file -- as opposed to an unencrypted one created "just to keep going".
     */
    @Test
    fun store_withoutAUsableKey_refusesToOpenAndCreatesNoDatabase() {
        val freshName = "ci_local_hub_outbox_keyless_test.db"
        context.deleteDatabase(freshName)
        val databaseFile = context.getDatabasePath(freshName)

        // A namespace whose alias is occupied by a signing RSA key: the AES path cannot use it,
        // which is the same condition capacitor-secure-storage-plugin answers with plain Base64.
        occupyAliasWithAnRsaKey(HOSTILE_ALIAS)
        val hostileNamespace = CompanionSecureStore(context, HOSTILE_ALIAS, HOSTILE_PREFERENCES)

        var constructed = false
        try {
            OutboxStore(context, freshName, OutboxStore.MAX_ITEMS, null, OutboxDatabaseKey(hostileNamespace)).close()
            constructed = true
        } catch (e: SecureStoreUnavailableException) {
            // Expected.
        }

        assertFalse("an outbox store was constructed without a usable key", constructed)
        assertFalse("a database file was created despite there being no key", databaseFile.exists())
    }

    // ------------------------------------------------------------------ plaintext -> encrypted

    /**
     * The upgrade path for an install that already has a plaintext outbox. Those rows are
     * captures that have never reached any server, so the migration has to move every one of
     * them -- payload, seq, status, attempts and last error -- and only then get rid of the
     * plaintext file.
     */
    @Test
    fun plaintextOutbox_isMigratedIntoTheEncryptedDatabase_andTheOldFileIsRemoved() {
        val legacyFile = writeLegacyPlaintextOutbox(
            LegacyRow(seq = 1, id = "legacy-a", kind = "note", payload = """{"text":"first legacy capture"}""", capturedAt = "2026-08-13T08:00:00.000Z", idempotencyKey = "legacy-key-a", status = "pending", attempts = 0, lastError = null),
            LegacyRow(seq = 2, id = "legacy-b", kind = "capture", payload = """{"text":"second legacy capture"}""", capturedAt = "2026-08-13T08:05:00.000Z", idempotencyKey = "legacy-key-b", status = "needs_attention", attempts = 5, lastError = "server said no"),
            LegacyRow(seq = 9, id = "legacy-c", kind = "note", payload = """{"text":"third legacy capture"}""", capturedAt = "2026-08-13T08:10:00.000Z", idempotencyKey = "legacy-key-c", status = "pending", attempts = 2, lastError = "offline"),
        )
        // Sanity: the fixture really is a plaintext SQLite file before we migrate it.
        assertTrue(legacyFile.readBytes().copyOfRange(0, SQLITE_MAGIC.size).contentEquals(SQLITE_MAGIC))

        val token = "migration-token"
        val srv = startServer(token, legacyPlaintextDatabaseName = LEGACY_TEST_DATABASE_NAME)

        val listJson = get(srv, token, "/api/outbox").json()
        val items = listJson.getJSONArray("items")
        assertEquals("every queued capture must survive the migration", 3, items.length())

        // FIFO order and the original seq values are preserved, so replay order is unchanged.
        assertEquals("legacy-a", items.getJSONObject(0).getString("id"))
        assertEquals(1L, items.getJSONObject(0).getLong("seq"))
        assertEquals("legacy-b", items.getJSONObject(1).getString("id"))
        assertEquals(2L, items.getJSONObject(1).getLong("seq"))
        assertEquals("legacy-c", items.getJSONObject(2).getString("id"))
        assertEquals(9L, items.getJSONObject(2).getLong("seq"))

        // Mutable columns come across too, not just the row.
        assertEquals("needs_attention", items.getJSONObject(1).getString("status"))
        assertEquals(5, items.getJSONObject(1).getInt("attempts"))
        assertEquals("server said no", items.getJSONObject(1).getString("lastError"))
        assertTrue(items.getJSONObject(0).isNull("lastError"))

        val counts = listJson.getJSONObject("counts")
        assertEquals(2, counts.getInt("pending"))
        assertEquals(1, counts.getInt("needsAttention"))
        assertEquals(3, counts.getInt("total"))

        // Payloads survive verbatim.
        assertEquals(
            "second legacy capture",
            get(srv, token, "/api/outbox/legacy-b").json().getJSONObject("payload").getString("text"),
        )

        // The plaintext file is gone, and the encrypted one that replaced it is not plaintext.
        assertFalse("the plaintext outbox was left on disk", legacyFile.exists())
        val encrypted = context.getDatabasePath(TEST_DATABASE_NAME).readBytes()
        assertFalse(encrypted.copyOfRange(0, SQLITE_MAGIC.size).contentEquals(SQLITE_MAGIC))
        assertFalse(
            "a migrated payload is readable in the encrypted file",
            encrypted.containsSubsequence("second legacy capture".toByteArray(Charsets.UTF_8)),
        )

        // The idempotency keys came across as well: re-POSTing one must be recognised as a
        // replay of the migrated row rather than accepted as a new capture.
        val replay = post(srv, token, "/api/outbox", enqueueBody(idempotencyKey = "legacy-key-a"))
        assertEquals(201, replay.code)
        assertEquals("legacy-a", replay.json().getString("id"))
        assertEquals(3, get(srv, token, "/api/outbox").json().getJSONObject("counts").getInt("total"))
    }

    /**
     * A second launch after a completed migration must not resurrect anything or fail: the
     * plaintext file is already gone, so the import is a no-op.
     */
    @Test
    fun migration_isANoOpOnEveryLaunchAfterTheFirst() {
        writeLegacyPlaintextOutbox(
            LegacyRow(seq = 1, id = "legacy-only", kind = "note", payload = """{"text":"once"}""", capturedAt = "2026-08-13T08:00:00.000Z", idempotencyKey = "legacy-only-key", status = "pending", attempts = 0, lastError = null),
        )

        val firstServer = startServer("first-launch", legacyPlaintextDatabaseName = LEGACY_TEST_DATABASE_NAME)
        assertEquals(1, get(firstServer, "first-launch", "/api/outbox").json().getJSONArray("items").length())
        firstServer.stop()
        startedServers.remove(firstServer)
        openedStores.forEach { it.close() }
        openedStores.clear()

        val secondServer = startServer("second-launch", legacyPlaintextDatabaseName = LEGACY_TEST_DATABASE_NAME)
        val items = get(secondServer, "second-launch", "/api/outbox").json().getJSONArray("items")
        assertEquals("the migrated row was duplicated or lost on the second launch", 1, items.length())
        assertEquals("legacy-only", items.getJSONObject(0).getString("id"))
    }

    /**
     * A fresh install has no plaintext predecessor. Nothing should be created, imported, or
     * shredded -- and the queue starts empty rather than erroring.
     */
    @Test
    fun migration_withNoPlaintextPredecessor_startsAnEmptyQueue() {
        context.deleteDatabase(LEGACY_TEST_DATABASE_NAME)

        val token = "fresh-install-token"
        val srv = startServer(token, legacyPlaintextDatabaseName = LEGACY_TEST_DATABASE_NAME)

        assertEquals(0, get(srv, token, "/api/outbox").json().getJSONObject("counts").getInt("total"))
        assertFalse(context.getDatabasePath(LEGACY_TEST_DATABASE_NAME).exists())
    }

    // ------------------------------------------------------------------ concurrency

    /**
     * NanoHTTPD serves each request on its own worker thread, so the store is genuinely hit
     * concurrently in production. This fires overlapping enqueues from several threads and
     * asserts nothing is lost, nothing is duplicated, and every seq is unique -- the failure
     * this guards against (two threads both passing the idempotency-key check before either
     * inserts) is invisible in single-threaded tests.
     */
    @Test
    fun concurrentEnqueues_areAllPersistedExactlyOnce() {
        val token = "concurrent-token"
        val srv = startServer(token)

        val threadCount = 4
        val perThread = 5
        val failures = java.util.Collections.synchronizedList(mutableListOf<String>())
        val threads = (0 until threadCount).map { threadIndex ->
            Thread {
                repeat(perThread) { i ->
                    // Half the writers deliberately replay a key another writer also uses, so
                    // the idempotency check is exercised under contention too.
                    val key = if (threadIndex % 2 == 0) "shared-$i" else "unique-$threadIndex-$i"
                    val response = post(srv, token, "/api/outbox", enqueueBody(idempotencyKey = key))
                    if (response.code != 201) {
                        failures.add("key=$key code=${response.code} body=${response.body}")
                    }
                }
            }
        }
        threads.forEach { it.start() }
        threads.forEach { it.join(30_000) }

        assertTrue("concurrent enqueues failed: $failures", failures.isEmpty())

        val expectedUnique = perThread + (threadCount / 2) * perThread
        val items = get(srv, token, "/api/outbox").json().getJSONArray("items")
        assertEquals("one row per distinct idempotency key", expectedUnique, items.length())

        val seqs = mutableSetOf<Long>()
        items.forEachObject { _, item -> assertTrue("duplicate seq ${item.getLong("seq")}", seqs.add(item.getLong("seq"))) }
    }

    // ------------------------------------------------------------------ helpers

    private fun startServer(
        token: String,
        maxItems: Int = OutboxStore.MAX_ITEMS,
        /**
         * `null` by default so the ordinary tests never look at, let alone shred, a plaintext
         * database -- including the production one, which the default would otherwise point at.
         * The migration tests pass their own throwaway name.
         */
        legacyPlaintextDatabaseName: String? = null,
    ): LocalHubServer {
        val store = OutboxStore(
            context,
            TEST_DATABASE_NAME,
            maxItems,
            legacyPlaintextDatabaseName,
        ).also { openedStores.add(it) }
        return LocalHubServer(token, store).also {
            startedServers.add(it)
            it.start(5000, true)
        }
    }

    private fun enqueueBody(
        kind: String = "note",
        payload: JSONObject = JSONObject().put("text", "payload"),
        capturedAt: String = "2026-08-13T10:00:00.000Z",
        idempotencyKey: String,
    ): String =
        JSONObject()
            .put("kind", kind)
            .put("payload", payload)
            .put("capturedAt", capturedAt)
            .put("idempotencyKey", idempotencyKey)
            .toString()

    private fun failureBody(error: String, permanent: Boolean = false): String =
        JSONObject().put("ok", false).put("error", error).put("permanent", permanent).toString()

    // The `…Raw` variants take the literal Authorization header (or none) so the auth tests
    // can send a missing/wrong one; the plain ones take the token and build the header.
    // They can't be overloads of the same name -- `String` and `String?` erase to the same
    // JVM signature.
    private fun get(srv: LocalHubServer, token: String, path: String): HttpResult =
        exchange(srv, path, "GET", "Bearer $token", body = null)

    private fun getRaw(srv: LocalHubServer, authHeader: String?, path: String): HttpResult =
        exchange(srv, path, "GET", authHeader, body = null)

    private fun post(srv: LocalHubServer, token: String, path: String, body: String?): HttpResult =
        exchange(srv, path, "POST", "Bearer $token", body)

    private fun postRaw(srv: LocalHubServer, authHeader: String?, path: String, body: String?): HttpResult =
        exchange(srv, path, "POST", authHeader, body)

    private fun delete(srv: LocalHubServer, token: String, path: String): HttpResult =
        exchange(srv, path, "DELETE", "Bearer $token", body = null)

    private fun deleteRaw(srv: LocalHubServer, authHeader: String?, path: String): HttpResult =
        exchange(srv, path, "DELETE", authHeader, body = null)

    private fun exchange(
        srv: LocalHubServer,
        path: String,
        method: String,
        authHeader: String?,
        body: String?,
    ): HttpResult {
        val connection = openConnection(srv.listeningPort, path, method, authHeader)
        try {
            if (body != null) {
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/json")
                connection.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            }
            val code = connection.responseCode
            val stream = if (code in 200..299) connection.inputStream else connection.errorStream
            val text = stream?.bufferedReader()?.use { it.readText() }.orEmpty()
            val headers = mapOf(
                "Access-Control-Allow-Origin" to connection.getHeaderField("Access-Control-Allow-Origin"),
            )
            return HttpResult(code, text, headers)
        } finally {
            connection.disconnect()
        }
    }

    private fun openConnection(port: Int, path: String, method: String, authHeader: String?): HttpURLConnection {
        val url = URL("http://127.0.0.1:$port$path")
        val connection = url.openConnection() as HttpURLConnection
        connection.requestMethod = method
        connection.connectTimeout = 5000
        connection.readTimeout = 5000
        if (authHeader != null) {
            connection.setRequestProperty("Authorization", authHeader)
        }
        return connection
    }

    // --- encryption / migration helpers

    /** One row of a pre-encryption plaintext outbox, as the shipped v1 schema stored it. */
    private data class LegacyRow(
        val seq: Long,
        val id: String,
        val kind: String,
        val payload: String,
        val capturedAt: String,
        val idempotencyKey: String,
        val status: String,
        val attempts: Int,
        val lastError: String?,
    )

    /**
     * Builds a real plaintext SQLite outbox with the framework driver -- byte-for-byte what an
     * install from before this slice has sitting in `databases/`. Writing the fixture through
     * `android.database.sqlite` rather than through [OutboxStore] is deliberate: the point is
     * to migrate a file this code can no longer produce.
     */
    private fun writeLegacyPlaintextOutbox(vararg rows: LegacyRow): File {
        context.deleteDatabase(LEGACY_TEST_DATABASE_NAME)
        val file = context.getDatabasePath(LEGACY_TEST_DATABASE_NAME)
        file.parentFile?.mkdirs()

        val database = SQLiteDatabase.openOrCreateDatabase(file, null)
        database.use { db ->
            db.execSQL(
                """
                CREATE TABLE ${OutboxStore.TABLE_NAME} (
                    ${OutboxStore.COLUMN_SEQ} INTEGER PRIMARY KEY AUTOINCREMENT,
                    ${OutboxStore.COLUMN_ID} TEXT NOT NULL UNIQUE,
                    ${OutboxStore.COLUMN_KIND} TEXT NOT NULL,
                    ${OutboxStore.COLUMN_PAYLOAD} TEXT NOT NULL,
                    ${OutboxStore.COLUMN_CAPTURED_AT} TEXT NOT NULL,
                    ${OutboxStore.COLUMN_IDEMPOTENCY_KEY} TEXT NOT NULL UNIQUE,
                    ${OutboxStore.COLUMN_STATUS} TEXT NOT NULL,
                    ${OutboxStore.COLUMN_ATTEMPTS} INTEGER NOT NULL DEFAULT 0,
                    ${OutboxStore.COLUMN_LAST_ERROR} TEXT
                )
                """.trimIndent(),
            )
            db.version = 1
            for (row in rows) {
                db.insertOrThrow(
                    OutboxStore.TABLE_NAME,
                    null,
                    ContentValues().apply {
                        put(OutboxStore.COLUMN_SEQ, row.seq)
                        put(OutboxStore.COLUMN_ID, row.id)
                        put(OutboxStore.COLUMN_KIND, row.kind)
                        put(OutboxStore.COLUMN_PAYLOAD, row.payload)
                        put(OutboxStore.COLUMN_CAPTURED_AT, row.capturedAt)
                        put(OutboxStore.COLUMN_IDEMPOTENCY_KEY, row.idempotencyKey)
                        put(OutboxStore.COLUMN_STATUS, row.status)
                        put(OutboxStore.COLUMN_ATTEMPTS, row.attempts)
                        put(OutboxStore.COLUMN_LAST_ERROR, row.lastError)
                    },
                )
            }
        }
        return file
    }

    /**
     * Occupies a keystore alias with a signing RSA keypair, so the AES path finds an entry of
     * the wrong type -- the "keystore is unusable" condition, reproduced rather than mocked.
     */
    private fun occupyAliasWithAnRsaKey(aliasName: String) {
        val generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_RSA, "AndroidKeyStore")
        generator.initialize(
            KeyGenParameterSpec.Builder(
                aliasName,
                KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY,
            )
                .setDigests(KeyProperties.DIGEST_SHA256)
                .setSignaturePaddings(KeyProperties.SIGNATURE_PADDING_RSA_PKCS1)
                .build(),
        )
        generator.generateKeyPair()
    }

    private fun clearTestKeystoreState() {
        val keyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        for (aliasName in listOf(IMPOSTOR_ALIAS, HOSTILE_ALIAS)) {
            if (keyStore.containsAlias(aliasName)) {
                keyStore.deleteEntry(aliasName)
            }
        }
        for (preferencesName in listOf(IMPOSTOR_PREFERENCES, HOSTILE_PREFERENCES)) {
            context.getSharedPreferences(preferencesName, Context.MODE_PRIVATE).edit().clear().commit()
        }
    }

    private fun ByteArray.containsSubsequence(needle: ByteArray): Boolean {
        if (needle.isEmpty() || needle.size > size) {
            return false
        }
        outer@ for (start in 0..(size - needle.size)) {
            for (offset in needle.indices) {
                if (this[start + offset] != needle[offset]) continue@outer
            }
            return true
        }
        return false
    }

    private data class HttpResult(val code: Int, val body: String, val headers: Map<String, String?>) {
        fun json(): JSONObject = JSONObject(body)
    }

    private inline fun JSONArray.forEachObject(action: (index: Int, item: JSONObject) -> Unit) {
        for (index in 0 until length()) {
            action(index, getJSONObject(index))
        }
    }

    private companion object {
        /**
         * Deliberately not [OutboxStore.DATABASE_NAME]: these tests delete their database
         * between runs, and must never be able to wipe the real outbox if this ever runs in
         * a process that shares storage with the app.
         */
        const val TEST_DATABASE_NAME = "ci_local_hub_outbox_test.db"

        /**
         * Stand-in for [OutboxStore.LEGACY_PLAINTEXT_DATABASE_NAME], for the same reason: the
         * migration tests *shred* this file, and pointing them at the production name would let
         * a stray run destroy a real user's queued captures.
         */
        const val LEGACY_TEST_DATABASE_NAME = "ci_local_hub_outbox_legacy_test.db"

        /** `SQLite format 3 ` -- the 16-byte magic every plain SQLite file starts with. */
        val SQLITE_MAGIC: ByteArray = "SQLite format 3".toByteArray(Charsets.US_ASCII) + 0.toByte()

        const val IMPOSTOR_ALIAS = "com.companionintelligence.localhub.test.impostor_dek"
        const val IMPOSTOR_PREFERENCES = "ci_local_hub_test_impostor_dek"

        const val HOSTILE_ALIAS = "com.companionintelligence.localhub.test.hostile_dek"
        const val HOSTILE_PREFERENCES = "ci_local_hub_test_hostile_dek"
    }
}
