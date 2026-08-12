package com.companionintelligence.localhub

import fi.iki.elonen.NanoHTTPD

/**
 * Embedded loopback-only HTTP server for the Local Hub sidecar.
 *
 * Phase 1 (this class, as shipped today): a single bearer-authenticated health check.
 * Later phases (see this package's root `README.md`) add routes for a durable outbox and
 * local inference -- [serve] is meant to stay the one router root for all of them rather
 * than scattering NanoHTTPD subclasses, so new routes should be added as extra `when`
 * branches here.
 *
 * Security posture (per the Local Hub design doc): this server binds explicitly to
 * [LOOPBACK_ADDRESS] (127.0.0.1), never `0.0.0.0`, so nothing off-device -- and nothing
 * else on the LAN -- can ever reach it, regardless of firewall/VPN state. Every route also
 * requires the current per-launch bearer [token], so no other app *on the same device*
 * can call it either without having separately obtained the token from a live `start()`
 * call through this plugin.
 */
class LocalHubServer(
    private val token: String,
) : NanoHTTPD(LOOPBACK_ADDRESS, 0) {

    override fun serve(session: IHTTPSession): Response =
        when {
            session.method == Method.GET && session.uri == HEALTH_PATH -> handleHealth(session)
            else -> jsonResponse(Response.Status.NOT_FOUND, """{"error":"not_found"}""")
        }

    private fun handleHealth(session: IHTTPSession): Response {
        if (!isAuthorized(session)) {
            return jsonResponse(Response.Status.UNAUTHORIZED, """{"error":"unauthorized"}""")
        }
        return jsonResponse(Response.Status.OK, """{"status":"ok","version":"$API_VERSION"}""")
    }

    private fun isAuthorized(session: IHTTPSession): Boolean {
        // NanoHTTPD's header map key-casing has varied across versions/forks, so look the
        // header up case-insensitively rather than relying on a fixed casing.
        val header =
            session.headers.entries
                .firstOrNull { it.key.equals(AUTH_HEADER, ignoreCase = true) }
                ?.value
                ?: return false

        if (!header.startsWith(BEARER_PREFIX)) {
            return false
        }
        val presented = header.substring(BEARER_PREFIX.length)
        return constantTimeEquals(presented, token)
    }

    private fun jsonResponse(status: Response.Status, body: String): Response =
        newFixedLengthResponse(status, "application/json", body)

    /** Length-then-XOR comparison so a failed match doesn't leak timing info about how much of the token matched. */
    private fun constantTimeEquals(a: String, b: String): Boolean {
        if (a.length != b.length) {
            return false
        }
        var diff = 0
        for (i in a.indices) {
            diff = diff or (a[i].code xor b[i].code)
        }
        return diff == 0
    }

    companion object {
        private const val LOOPBACK_ADDRESS = "127.0.0.1"
        private const val HEALTH_PATH = "/api/health"
        private const val AUTH_HEADER = "Authorization"
        private const val BEARER_PREFIX = "Bearer "

        /** Reported by GET /api/health -- bump alongside the Local Hub design doc's phase markers. */
        const val API_VERSION = "0.1.0"
    }
}
