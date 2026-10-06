package com.companionintelligence.localhub

import fi.iki.elonen.NanoHTTPD.Method
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Path-shape rejection, the `capacity` block, and the catch-all 500 -- the parts of the router
 * that either no device test probes at all, or that the device tests probe by recomputing the
 * implementation (both existing `warnAt` assertions are literally `MAX_ITEMS * 8 / 10`, so they
 * cannot fail if the expression changes).
 */
@RunWith(RobolectricTestRunner::class)
// Pinned rather than inherited from targetSdk, the same way the app module's
// Robolectric tests are: variables.gradle now sets targetSdkVersion 36 for Play,
// and Robolectric 4.14.1 ships android-all images only up to 35, so an inherited
// SDK fails the whole class at configure time with
// `Package targetSdkVersion=36 > maxSdkVersion=35` before a single assertion runs.
// Nothing under test here is SDK-specific.
@Config(sdk = [34])
class LocalHubServerRoutingTest {

    @Test
    fun pathsThatAreNotOutboxRoutes_are404_andNeverReachTheStore() {
        val outbox = FakeOutbox()
        val notRoutes = listOf(
            // An extra segment after "attempt" must not be read as an attempt report: that
            // would let an unexpected client shape mutate an item it did not name properly.
            Method.POST to "/api/outbox/item-1/attempt/extra",
            Method.POST to "/api/outbox/item-1/bogus",
            Method.GET to "/api/outbox/a/b",
            Method.GET to "/api/outboxes",
            Method.GET to "/api/outboxfoo",
            // Method/segment mismatches share the same fall-through.
            // DELETE on the collection itself is a route (sign-out's clear), so PUT stands in
            // for a mismatch on the collection.
            Method.PUT to "/api/outbox/item-1",
            Method.PUT to "/api/outbox",
            Method.POST to "/api/outbox/item-1",
        )

        notRoutes.forEach { (method, uri) ->
            val response = serve(request(method, uri), outbox)

            assertEquals("$method $uri", 404, response.code())
            assertEquals("not_found", JSONObject(response.text()).getString("error"))
        }

        assertFalse("a 404 must not have touched the queue", outbox.wasTouched)
    }

    @Test
    fun aTrailingSlashAndEmptySegments_collapseOntoTheSameRoutes() {
        val outbox = FakeOutbox()
        outbox.getResult = outboxItem(id = "item-1", payload = "{}")

        assertEquals(200, serve(request(Method.GET, "/api/outbox"), outbox).code())
        assertEquals(200, serve(request(Method.GET, "/api/outbox/"), outbox).code())
        assertEquals(listOf<String?>(null, null), outbox.listFilters)

        // "//" is what a client that naively joins a base URL with an id produces. Dropping the
        // empty-segment filter would turn it into a two-segment path and 404 the read.
        assertEquals(200, serve(request(Method.GET, "/api/outbox//item-1"), outbox).code())
        assertEquals(200, serve(request(Method.GET, "/api/outbox/item-1/"), outbox).code())
        assertEquals(listOf("item-1", "item-1"), outbox.fetchedIds)
    }

    @Test
    fun theCapacityBlock_echoesTheStoresOwnLimits_ratherThanRecomputingThem() {
        // A deliberately inconsistent pair: on a device warnAt is always exactly maxItems*8/10,
        // so a recomputation in the handler is invisible there. Here it is not.
        val outbox = FakeOutbox(maxItems = 7, warnAt = 3)
        outbox.countsResult = OutboxCounts(pending = 2, needsAttention = 1, total = 3)
        outbox.listResult = listOf(outboxItem(id = "a", seq = 1), outboxItem(id = "b", seq = 2))

        val body = JSONObject(serve(request(Method.GET, "/api/outbox"), outbox).text())

        val capacity = body.getJSONObject("capacity")
        assertEquals(7, capacity.getInt("max"))
        assertEquals(3, capacity.getInt("warnAt"))
        assertEquals(3, capacity.getInt("used"))

        val counts = body.getJSONObject("counts")
        assertEquals(2, counts.getInt("pending"))
        assertEquals(1, counts.getInt("needsAttention"))
        assertEquals(3, counts.getInt("total"))

        val items = body.getJSONArray("items")
        assertEquals(2, items.length())
        // A queue-depth poll must not stream every payload back; payloads can be media-sized.
        assertFalse(items.getJSONObject(0).has("payload"))
    }

    @Test
    fun aFullOutbox_is507_andTheDetailNamesTheStoresOwnCap() {
        val outbox = FakeOutbox(maxItems = 7, warnAt = 3)
        outbox.nextEnqueueOutcome = EnqueueOutcome.AtCapacity

        val response = serve(request(Method.POST, "/api/outbox", body = validEnqueueBody()), outbox)

        // 507, not a 4xx: the caller sent nothing wrong, and a 4xx would invite it to give up on
        // a capture that is still sitting in the user's hands.
        assertEquals(507, response.code())
        assertEquals("507 Insufficient Storage", response.status.description)
        val body = JSONObject(response.text())
        assertEquals("outbox_full", body.getString("error"))
        assertTrue(body.getString("detail").contains("7-item cap"))
    }

    @Test
    fun theStatusFilter_mapsAllToNoFilter_andRejectsAnythingElseBeforeQuerying() {
        val outbox = FakeOutbox()

        serve(request(Method.GET, "/api/outbox"), outbox)
        serve(request(Method.GET, "/api/outbox", parameters = mapOf("status" to listOf("all"))), outbox)
        serve(request(Method.GET, "/api/outbox", parameters = mapOf("status" to listOf("pending"))), outbox)
        serve(
            request(Method.GET, "/api/outbox", parameters = mapOf("status" to listOf("needs_attention"))),
            outbox,
        )

        assertEquals(listOf(null, null, "pending", "needs_attention"), outbox.listFilters)

        val rejected = FakeOutbox()
        val response = serve(
            request(Method.GET, "/api/outbox", parameters = mapOf("status" to listOf("done"))),
            rejected,
        )

        assertEquals(400, response.code())
        assertEquals("invalid_request", JSONObject(response.text()).getString("error"))
        assertFalse("an unknown filter must be rejected before the query", rejected.wasTouched)
    }

    @Test
    fun aQueueFailure_becomesA500_thatKeepsTheCorsHeadersAndClosesTheSocket() {
        val outbox = FakeOutbox()
        outbox.thrown = IllegalStateException("database is locked")

        val response = serve(request(Method.GET, "/api/outbox"), outbox)

        assertEquals(500, response.code())
        val body = JSONObject(response.text())
        assertEquals("internal_error", body.getString("error"))
        assertEquals("database is locked", body.getString("detail"))
        // Without the CORS headers the WebView reports a server bug as a CORS policy error, and
        // without "connection: close" NanoHTTPD may reuse a socket whose body was left
        // half-read by the failure.
        assertEquals("*", response.getHeader("Access-Control-Allow-Origin"))
        assertEquals("close", response.getHeader("connection"))
    }

    @Test
    fun deleteAndRetry_reportUnknownIdsAs404_ratherThanPretendingTheyWorked() {
        val outbox = FakeOutbox()
        outbox.deleteResult = false
        outbox.retryResult = null
        outbox.getResult = null

        assertEquals(404, serve(request(Method.DELETE, "/api/outbox/gone"), outbox).code())
        assertEquals(404, serve(request(Method.POST, "/api/outbox/gone/retry"), outbox).code())
        assertEquals(404, serve(request(Method.GET, "/api/outbox/gone"), outbox).code())

        outbox.deleteResult = true
        outbox.retryResult = outboxItem(id = "here", seq = 4)
        assertEquals(204, serve(request(Method.DELETE, "/api/outbox/here"), outbox).code())
        assertEquals(200, serve(request(Method.POST, "/api/outbox/here/retry"), outbox).code())
        assertEquals(listOf("gone", "here"), outbox.retriedIds)
    }
}
