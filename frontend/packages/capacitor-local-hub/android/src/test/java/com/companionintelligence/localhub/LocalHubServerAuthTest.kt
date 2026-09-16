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
 * The bearer check and the preflight-before-auth ordering, driven through `serve()` with a
 * synthetic session.
 *
 * Every case here is out of reach of the instrumented suite. NanoHTTPD lowercases header names
 * before the router ever sees them, so a real HTTP client cannot test the case-insensitive
 * lookup that the source comment says exists because the casing has varied across NanoHTTPD
 * versions. The device suite likewise only ever sends the literal `wrong-token`, which differs
 * from the real token in *length* -- so it passes against a comparison that has been reduced to
 * a prefix or a length check.
 *
 * Robolectric is here only to supply the real AOSP `org.json`, which AGP's mockable
 * `android.jar` replaces with "not mocked" throwers.
 */
@RunWith(RobolectricTestRunner::class)
// Pinned rather than inherited from targetSdk, the same way the app module's
// Robolectric tests are: variables.gradle now sets targetSdkVersion 36 for Play,
// and Robolectric 4.14.1 ships android-all images only up to 35, so an inherited
// SDK fails the whole class at configure time with
// `Package targetSdkVersion=36 > maxSdkVersion=35` before a single assertion runs.
// Nothing under test here is SDK-specific.
@Config(sdk = [34])
class LocalHubServerAuthTest {

    @Test
    fun authorizationHeader_isFoundWhateverCaseTheClientUsed() {
        listOf("authorization", "Authorization", "AUTHORIZATION").forEach { name ->
            val response = serve(
                request(Method.GET, "/api/health", authorizationHeaderName = name),
            )

            assertEquals("header name '$name' was not recognised", 200, response.code())
            assertEquals("ok", JSONObject(response.text()).getString("status"))
        }
    }

    @Test
    fun bearerScheme_isMatchedCaseSensitively() {
        // RFC 7235 says the scheme is case-insensitive, but this server's contract is the one
        // its own JS client speaks, and loosening the match here would also accept a token
        // pasted after a differently-cased scheme by some other app on the device.
        val response = serve(request(Method.GET, "/api/health", authorization = "bearer $TEST_TOKEN"))

        assertEquals(401, response.code())
        assertEquals("unauthorized", JSONObject(response.text()).getString("error"))
    }

    @Test
    fun aTokenThatIsOnlyAPrefixOfTheRealOne_isRejected() {
        val outbox = FakeOutbox()

        val response = serve(
            request(Method.GET, "/api/outbox", authorization = "Bearer ${TEST_TOKEN.dropLast(4)}"),
            outbox,
        )

        assertEquals(401, response.code())
        assertFalse("an unauthenticated caller must not reach the store", outbox.wasTouched)
    }

    @Test
    fun aSameLengthTokenDifferingInOneCharacter_isRejected() {
        // Same length, so the length short-circuit cannot be what rejects it -- this is the case
        // that actually exercises the XOR comparison.
        val forged = TEST_TOKEN.dropLast(1) + if (TEST_TOKEN.last() == 'X') 'Y' else 'X'
        assertEquals(TEST_TOKEN.length, forged.length)

        val response = serve(request(Method.GET, "/api/health", authorization = "Bearer $forged"))

        assertEquals(401, response.code())
    }

    @Test
    fun aMissingAuthorizationHeader_is401_thatStillCarriesTheCorsHeaders() {
        val response = serve(request(Method.GET, "/api/health", authorization = null))

        assertEquals(401, response.code())
        // A 401 without these is indistinguishable from a CORS failure in the WebView, so the
        // client cannot tell "sign in again" from "the sidecar is broken".
        assertEquals("*", response.getHeader("Access-Control-Allow-Origin"))
        assertTrue(response.getHeader("Access-Control-Allow-Headers").contains("Content-Type"))
    }

    @Test
    fun anUnauthenticatedPreflight_isAnsweredForAnyUri_includingOnesThatAreNotRoutes() {
        val outbox = FakeOutbox()

        // The browser sends this without credentials. If the bearer check ran first, every real
        // fetch() would die at preflight and never be sent -- the bug LocalHubServer's class
        // comment records finding the hard way on a device.
        listOf("/api/health", "/api/outbox", "/api/outbox/some-id", "/api/nope").forEach { uri ->
            val response = serve(request(Method.OPTIONS, uri, authorization = null), outbox)

            assertEquals("preflight to $uri", 204, response.code())
            assertEquals("*", response.getHeader("Access-Control-Allow-Origin"))
            assertTrue(response.getHeader("Access-Control-Allow-Methods").contains("DELETE"))
            assertTrue(response.getHeader("Access-Control-Allow-Headers").contains("Authorization"))
        }

        assertFalse("a preflight must not reach the store", outbox.wasTouched)
    }

    @Test
    fun theRequestBody_isDrainedEvenWhenTheRequestIsRejected() {
        // NanoHTTPD reuses keep-alive sockets: an unread body is still in the stream when the
        // next request is parsed off the same connection, which corrupts *that* request. So the
        // drain has to happen on the reject paths too, not just the ones that use the body.
        val session = request(
            Method.POST,
            "/api/outbox",
            body = """{"kind":"note"}""",
            authorization = null,
        )

        val response = serve(session)

        assertEquals(401, response.code())
        assertEquals(1, session.parseBodyCalls)
    }
}
