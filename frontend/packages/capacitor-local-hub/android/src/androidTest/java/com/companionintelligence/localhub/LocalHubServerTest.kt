package com.companionintelligence.localhub

import androidx.test.ext.junit.runners.AndroidJUnit4
import java.net.HttpURLConnection
import java.net.URL
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith

/**
 * On-device (instrumented) verification that [LocalHubServer] actually binds, listens on
 * loopback, and enforces the bearer token -- run via `connectedAndroidTest` against a real
 * emulator/device rather than only asserted by code review. Exercises the real
 * `java.net.ServerSocket`/HTTP stack end to end: a real `HttpURLConnection` client talking
 * to the real bound port.
 */
@RunWith(AndroidJUnit4::class)
class LocalHubServerTest {
    private var server: LocalHubServer? = null

    @After
    fun tearDown() {
        server?.stop()
        server = null
    }

    @Test
    fun healthEndpoint_withValidToken_returns200WithExpectedBody() {
        val token = "test-token-abc123"
        val srv = LocalHubServer(token).also { server = it }
        srv.start(5000, true)

        val connection = openHealthConnection(srv.listeningPort, "Bearer $token")
        try {
            assertEquals(200, connection.responseCode)
            val body = connection.inputStream.bufferedReader().readText()
            assertTrue("body was: $body", body.contains("\"status\":\"ok\""))
            assertTrue("body was: $body", body.contains("\"version\":\"0.1.0\""))
        } finally {
            connection.disconnect()
        }
    }

    @Test
    fun healthEndpoint_withMissingAuthHeader_returns401() {
        val token = "test-token-abc123"
        val srv = LocalHubServer(token).also { server = it }
        srv.start(5000, true)

        val connection = openHealthConnection(srv.listeningPort, authHeader = null)
        try {
            assertEquals(401, connection.responseCode)
        } finally {
            connection.disconnect()
        }
    }

    @Test
    fun healthEndpoint_withWrongToken_returns401() {
        val srv = LocalHubServer("correct-token").also { server = it }
        srv.start(5000, true)

        val connection = openHealthConnection(srv.listeningPort, "Bearer wrong-token")
        try {
            assertEquals(401, connection.responseCode)
        } finally {
            connection.disconnect()
        }
    }

    @Test
    fun server_bindsToLoopbackAddressOnly() {
        val srv = LocalHubServer("any-token").also { server = it }
        srv.start(5000, true)

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
        val srv = LocalHubServer("any-token").also { server = it }
        srv.start(5000, true)

        val connection = openConnection(srv.listeningPort, method = "OPTIONS", authHeader = null)
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
        val srv = LocalHubServer(token).also { server = it }
        srv.start(5000, true)

        // The browser reads Access-Control-Allow-Origin off *every* response in a CORS
        // context to decide whether JS may see it -- including error responses, which is
        // exactly the case the original bug hit (a 401/404 with no CORS header is just as
        // unreadable to `fetch()` as a 200 with no CORS header).
        val unauthorized = openConnection(srv.listeningPort, method = "GET", authHeader = null)
        try {
            assertEquals(401, unauthorized.responseCode)
            assertEquals("*", unauthorized.getHeaderField("Access-Control-Allow-Origin"))
        } finally {
            unauthorized.disconnect()
        }

        val authorized = openConnection(srv.listeningPort, method = "GET", authHeader = "Bearer $token")
        try {
            assertEquals(200, authorized.responseCode)
            assertEquals("*", authorized.getHeaderField("Access-Control-Allow-Origin"))
        } finally {
            authorized.disconnect()
        }
    }

    private fun openConnection(port: Int, method: String, authHeader: String?): HttpURLConnection {
        val url = URL("http://127.0.0.1:$port/api/health")
        val connection = url.openConnection() as HttpURLConnection
        connection.requestMethod = method
        connection.connectTimeout = 5000
        connection.readTimeout = 5000
        if (authHeader != null) {
            connection.setRequestProperty("Authorization", authHeader)
        }
        return connection
    }

    private fun openHealthConnection(port: Int, authHeader: String?): HttpURLConnection {
        val url = URL("http://127.0.0.1:$port/api/health")
        val connection = url.openConnection() as HttpURLConnection
        connection.requestMethod = "GET"
        connection.connectTimeout = 5000
        connection.readTimeout = 5000
        if (authHeader != null) {
            connection.setRequestProperty("Authorization", authHeader)
        }
        return connection
    }
}
