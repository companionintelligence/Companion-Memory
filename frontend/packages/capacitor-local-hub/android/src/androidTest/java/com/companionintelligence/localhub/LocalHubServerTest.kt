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
