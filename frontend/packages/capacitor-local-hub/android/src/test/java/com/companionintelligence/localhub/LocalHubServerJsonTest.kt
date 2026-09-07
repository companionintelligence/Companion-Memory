package com.companionintelligence.localhub

import fi.iki.elonen.NanoHTTPD.Method
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * How the router types the JSON it is handed, and the shape of the JSON it hands back.
 *
 * The instrumented suite sends missing and wrong-typed fields but never *blank* ones, and never
 * a JSON-typed lie like `"ok": "true"` -- which is the dangerous one, because a coercing read
 * would turn a malformed flusher report into a DELETE of a capture that was never flushed.
 *
 * Robolectric is here only to supply the real AOSP `org.json`: that implementation's coercion
 * rules are precisely what these assertions are about, so running them against a different
 * `org.json` would be testing the wrong library.
 */
@RunWith(RobolectricTestRunner::class)
class LocalHubServerJsonTest {

    @Test
    fun aNonBooleanOkFlag_isRejectedRatherThanCoerced() {
        val outbox = FakeOutbox()
        outbox.deleteResult = true

        val response = serve(
            request(Method.POST, "/api/outbox/item-1/attempt", body = """{"ok":"true"}"""),
            outbox,
        )

        assertEquals(400, response.code())
        assertTrue(JSONObject(response.text()).getString("detail").contains("\"ok\""))
        // The whole point: a coercing read ("true" -> true) would have deleted the capture.
        assertTrue("nothing may be deleted on a malformed report", outbox.deletedIds.isEmpty())
    }

    @Test
    fun aMissingOkFlag_isRejected_ratherThanDefaultingToFalse() {
        val outbox = FakeOutbox()

        val response = serve(
            request(Method.POST, "/api/outbox/item-1/attempt", body = """{"error":"boom"}"""),
            outbox,
        )

        assertEquals(400, response.code())
        // Defaulting to false would silently burn a retry from the item's budget.
        assertTrue(outbox.recordedAttempts.isEmpty())
    }

    @Test
    fun aNonBooleanPermanentFlag_isTreatedAsNotPermanent() {
        val outbox = FakeOutbox()
        outbox.recordFailedAttemptResult = outboxItem(id = "item-1", attempts = 1, lastError = "boom")

        val response = serve(
            request(
                Method.POST,
                "/api/outbox/item-1/attempt",
                body = """{"ok":false,"error":"boom","permanent":"true"}""",
            ),
            outbox,
        )

        assertEquals(200, response.code())
        // `as? Boolean ?: false` is the lenient half of the contract, and it is lenient in the
        // safe direction: an unparseable permanence claim leaves the item retryable rather than
        // parking it in needs_attention where only a human can free it.
        assertEquals(Triple("item-1", "boom", false), outbox.recordedAttempts.single())
    }

    @Test
    fun blankStringFields_areRejectedExactlyLikeMissingOnes() {
        val outbox = FakeOutbox()

        val blankKey = serve(
            request(Method.POST, "/api/outbox", body = validEnqueueBody(idempotencyKey = "\"   \"")),
            outbox,
        )
        val blankKind = serve(
            request(Method.POST, "/api/outbox", body = validEnqueueBody(kind = "\"\\t\"")),
            outbox,
        )
        val blankError = serve(
            request(
                Method.POST,
                "/api/outbox/item-1/attempt",
                body = """{"ok":false,"error":"   "}""",
            ),
            outbox,
        )

        // A whitespace-only idempotency key is not a key: it would collide with the next one and
        // make two unrelated captures look like a replay of each other.
        assertEquals(400, blankKey.code())
        assertEquals(400, blankKind.code())
        assertEquals(400, blankError.code())
        assertFalse("nothing may be stored from a blank field", outbox.wasTouched)
    }

    @Test
    fun aBodyThatIsNotAJsonObject_isA400_notACrash() {
        val outbox = FakeOutbox()

        listOf("[1,2,3]", "\"just a string\"", "not json at all", "").forEach { body ->
            val response = serve(request(Method.POST, "/api/outbox", body = body), outbox)

            assertEquals("body <$body>", 400, response.code())
            assertEquals("invalid_request", JSONObject(response.text()).getString("error"))
        }

        // A payload that is present but not an object is the same rejection.
        val scalarPayload = serve(
            request(Method.POST, "/api/outbox", body = validEnqueueBody(payload = "\"oops\"")),
            outbox,
        )
        assertEquals(400, scalarPayload.code())
        assertFalse(outbox.wasTouched)
    }

    @Test
    fun theEnqueuedPayload_isForwardedAsItsOwnJsonText_andCapturedAtIsPassedThroughVerbatim() {
        val outbox = FakeOutbox()
        outbox.nextEnqueueOutcome = EnqueueOutcome.Created(outboxItem(id = "new-id", seq = 42))

        val response = serve(
            request(
                Method.POST,
                "/api/outbox",
                body = validEnqueueBody(
                    payload = """{"text":"hello","nested":{"n":1}}""",
                    capturedAt = "\"1999-12-31T23:59:59.000Z\"",
                ),
            ),
            outbox,
        )

        assertEquals(201, response.code())
        // [kind, payloadJson, capturedAt, idempotencyKey], in the order enqueue() takes them.
        val forwardedArguments = outbox.enqueueCalls.single()
        assertEquals("note", forwardedArguments[0])
        assertEquals("idem-1", forwardedArguments[3])
        // Client capture time, stored verbatim: the sidecar never substitutes its own clock, so
        // a capture that queues offline for a day still lands with the time the user made it.
        assertEquals("1999-12-31T23:59:59.000Z", forwardedArguments[2])
        // Just the payload, re-serialized as its own document -- not the whole request envelope.
        val forwarded = JSONObject(forwardedArguments[1])
        assertEquals("hello", forwarded.getString("text"))
        assertEquals(1, forwarded.getJSONObject("nested").getInt("n"))
        assertFalse("the envelope must not be forwarded as the payload", forwarded.has("idempotencyKey"))

        val body = JSONObject(response.text())
        assertEquals("new-id", body.getString("id"))
        assertEquals(42L, body.getLong("seq"))
        assertFalse("the 201 must not echo the capture back", body.has("payload"))
    }

    @Test
    fun aReplayedIdempotencyKey_answersExactlyLikeTheOriginalAccept() {
        val outbox = FakeOutbox()
        val original = outboxItem(id = "first-id", seq = 3)
        outbox.nextEnqueueOutcome = EnqueueOutcome.Duplicate(original)

        val response = serve(request(Method.POST, "/api/outbox", body = validEnqueueBody()), outbox)

        // The caller retried because it never saw the first response; making the second one look
        // different would force every client to special-case it.
        assertEquals(201, response.code())
        val body = JSONObject(response.text())
        assertEquals("first-id", body.getString("id"))
        assertEquals(3L, body.getLong("seq"))
    }

    @Test
    fun aSingleItemRead_nestsTheStoredPayload_andAlwaysCarriesLastError() {
        val outbox = FakeOutbox()
        outbox.getResult = outboxItem(
            id = "item-1",
            seq = 8,
            attempts = 2,
            lastError = null,
            payload = """{"text":"hello"}""",
        )

        val body = JSONObject(serve(request(Method.GET, "/api/outbox/item-1"), outbox).text())

        // Re-parsed, not string-spliced, so the payload nests as real JSON rather than arriving
        // as a quoted blob the client has to parse a second time.
        assertEquals("hello", body.getJSONObject("payload").getString("text"))
        assertEquals(8L, body.getLong("seq"))
        assertEquals(2, body.getInt("attempts"))
        // The TS contract says `lastError: string | null` -- always present. JSONObject#put drops
        // the key outright on a Kotlin null, so JSONObject.NULL is what keeps the shape stable.
        assertTrue("lastError must be present, not omitted", body.has("lastError"))
        assertSame(JSONObject.NULL, body.get("lastError"))
    }
}
