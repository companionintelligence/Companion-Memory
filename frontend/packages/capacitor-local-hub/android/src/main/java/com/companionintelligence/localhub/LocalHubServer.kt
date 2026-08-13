package com.companionintelligence.localhub

import fi.iki.elonen.NanoHTTPD
import org.json.JSONArray
import org.json.JSONObject

/**
 * Embedded loopback-only HTTP server for the Local Hub sidecar.
 *
 * Routes today: a bearer-authenticated health check plus the durable capture outbox
 * (`/api/outbox`, backed by [OutboxStore]). Later phases (see this package's root
 * `README.md`) add local inference -- [serve] is meant to stay the one router root for all
 * of them rather than scattering NanoHTTPD subclasses, so new routes should be added as
 * extra `when` branches here.
 *
 * Security posture (per the Local Hub design doc): this server binds explicitly to
 * [LOOPBACK_ADDRESS] (127.0.0.1), never `0.0.0.0`, so nothing off-device -- and nothing
 * else on the LAN -- can ever reach it, regardless of firewall/VPN state. Every route also
 * requires the current per-launch bearer [token], so no other app *on the same device*
 * can call it either without having separately obtained the token from a live `start()`
 * call through this plugin. The auth check happens in the router *before* dispatch, so
 * an unauthenticated caller cannot even probe which routes exist.
 *
 * CORS: the caller is always the app's own WebView, but it's still a browser context
 * (Capacitor serves the bundle from `https://localhost` on Android), so plain XHR/fetch
 * same-origin rules don't apply and the browser enforces CORS against this different-origin
 * loopback server -- confirmed the hard way (a real device/emulator run showed `fetch()`
 * rejecting with a CORS policy error despite the server responding fine). A wildcard
 * `Access-Control-Allow-Origin` doesn't weaken this server's actual security boundary: the
 * bearer token is what gates real access, and CORS on a token-authenticated loopback server
 * only prevents the browser from letting arbitrary page JS *read* a response it could not
 * have produced without the token anyway. The `Authorization` header also makes every real
 * request "non-simple", so the browser preflights it with an unauthenticated `OPTIONS` --
 * that must succeed without the bearer check or every real request would fail before it's
 * even sent. The outbox routes additionally send `Content-Type: application/json` bodies,
 * which is itself a preflight trigger, so `Content-Type` has to be in
 * `Access-Control-Allow-Headers` too -- omitting it reproduces the exact same class of bug
 * on POST that the missing `Access-Control-Allow-Origin` caused on GET.
 */
class LocalHubServer(
    private val token: String,
    private val outbox: OutboxStore,
) : NanoHTTPD(LOOPBACK_ADDRESS, 0) {

    override fun serve(session: IHTTPSession): Response =
        withCors(
            try {
                // The body is read up front, on every path including the ones that reject the
                // request, because NanoHTTPD reuses keep-alive sockets: an unread request body
                // is still sitting in the stream when the next request is parsed off the same
                // connection, which corrupts *that* request. Draining here costs nothing on a
                // loopback server and keeps 401/404 responses from poisoning the connection.
                route(session, readJsonBody(session))
            } catch (e: Exception) {
                // NanoHTTPD's own error path would answer without the CORS headers above,
                // making a server bug indistinguishable from a CORS failure in the WebView.
                // "connection: close" makes NanoHTTPD drop the socket rather than risk
                // reusing one whose body may have been left half-read by the failure.
                jsonResponse(Response.Status.INTERNAL_ERROR, errorBody("internal_error", e.message))
                    .apply { addHeader("connection", "close") }
            },
        )

    private fun route(session: IHTTPSession, body: JSONObject?): Response =
        when {
            // Preflight must answer before the bearer check -- the browser sends it without
            // credentials, and a 401 here kills the real request before it is ever sent.
            session.method == Method.OPTIONS ->
                newFixedLengthResponse(Response.Status.NO_CONTENT, MIME_PLAINTEXT, "")

            !isAuthorized(session) ->
                jsonResponse(Response.Status.UNAUTHORIZED, errorBody("unauthorized"))

            session.method == Method.GET && session.uri == HEALTH_PATH ->
                jsonResponse(Response.Status.OK, """{"status":"ok","version":"$API_VERSION"}""")

            else -> routeOutbox(session, body)
        }

    // ---------------------------------------------------------------- outbox routing

    private fun routeOutbox(session: IHTTPSession, body: JSONObject?): Response {
        val segments = outboxPathSegments(session.uri) ?: return notFound()
        val method = session.method
        return when {
            segments.isEmpty() && method == Method.POST -> handleEnqueue(body)
            segments.isEmpty() && method == Method.GET -> handleList(session)
            segments.size == 1 && method == Method.GET -> handleGetOne(segments[0])
            segments.size == 1 && method == Method.DELETE -> handleDelete(segments[0])
            segments.size == 2 && method == Method.POST && segments[1] == ATTEMPT_SEGMENT ->
                handleAttempt(body, segments[0])
            segments.size == 2 && method == Method.POST && segments[1] == RETRY_SEGMENT ->
                handleRetry(segments[0])
            else -> notFound()
        }
    }

    /**
     * Splits the path *below* `/api/outbox`: `null` when the URI isn't an outbox route at
     * all, `[]` for the collection itself, `[id]` / `[id, "attempt"]` for item routes.
     * A trailing slash is tolerated so `/api/outbox/` and `/api/outbox` behave alike.
     */
    private fun outboxPathSegments(uri: String): List<String>? {
        val normalized = uri.trimEnd('/')
        if (normalized == OUTBOX_PATH) {
            return emptyList()
        }
        if (!normalized.startsWith("$OUTBOX_PATH/")) {
            return null
        }
        return normalized.substring(OUTBOX_PATH.length + 1).split('/').filter { it.isNotEmpty() }
    }

    // ---------------------------------------------------------------- outbox handlers

    private fun handleEnqueue(body: JSONObject?): Response {
        if (body == null) {
            return badRequest("Request body must be a JSON object.")
        }

        val kind = body.stringOrNull("kind") ?: return badRequest("\"kind\" must be a non-empty string.")
        val payload = body.opt("payload") as? JSONObject
            ?: return badRequest("\"payload\" must be a JSON object.")
        // Client capture time, stored verbatim -- see OutboxStore.enqueue. The sidecar never
        // substitutes its own clock, so an item that queues offline for a day still lands
        // on the server with the timestamp the user actually captured it at.
        val capturedAt = body.stringOrNull("capturedAt")
            ?: return badRequest("\"capturedAt\" must be a non-empty ISO-8601 string.")
        val idempotencyKey = body.stringOrNull("idempotencyKey")
            ?: return badRequest("\"idempotencyKey\" must be a non-empty string.")

        return when (val outcome = outbox.enqueue(kind, payload.toString(), capturedAt, idempotencyKey)) {
            // A replay of an already-accepted key answers exactly like the original accept:
            // the caller retried because it never saw the first response, so it should not
            // have to special-case the second one.
            is EnqueueOutcome.Created -> jsonResponse(Response.Status.CREATED, enqueueBody(outcome.item))
            is EnqueueOutcome.Duplicate -> jsonResponse(Response.Status.CREATED, enqueueBody(outcome.item))
            EnqueueOutcome.AtCapacity ->
                jsonResponse(
                    ExtendedStatus.INSUFFICIENT_STORAGE,
                    errorBody(
                        "outbox_full",
                        "The outbox is at its ${outbox.maxItems}-item cap. " +
                            "Nothing was dropped; flush or discard existing items before capturing more.",
                    ),
                )
        }
    }

    private fun handleList(session: IHTTPSession): Response {
        val requested = session.parameters[STATUS_PARAM]?.firstOrNull() ?: STATUS_FILTER_ALL
        val filter = when (requested) {
            STATUS_FILTER_ALL -> null
            OutboxStore.STATUS_PENDING -> OutboxStore.STATUS_PENDING
            OutboxStore.STATUS_NEEDS_ATTENTION -> OutboxStore.STATUS_NEEDS_ATTENTION
            else -> return badRequest(
                "\"status\" must be one of ${OutboxStore.STATUS_PENDING}, " +
                    "${OutboxStore.STATUS_NEEDS_ATTENTION}, $STATUS_FILTER_ALL.",
            )
        }

        val items = JSONArray()
        // Oldest-first: the list doubles as the flusher's work queue, so its order IS the
        // replay order. Payloads are omitted here -- they can be large (media, long notes)
        // and a queue-depth poll should not have to stream all of them.
        outbox.list(filter).forEach { items.put(itemJson(it, includePayload = false)) }

        val counts = outbox.counts()
        val body = JSONObject()
            .put("items", items)
            .put(
                "counts",
                JSONObject()
                    .put("pending", counts.pending)
                    .put("needsAttention", counts.needsAttention)
                    .put("total", counts.total),
            )
            .put(
                "capacity",
                JSONObject()
                    .put("max", outbox.maxItems)
                    .put("used", counts.total)
                    .put("warnAt", outbox.warnAt),
            )
        return jsonResponse(Response.Status.OK, body.toString())
    }

    private fun handleGetOne(id: String): Response {
        val item = outbox.get(id) ?: return notFound()
        return jsonResponse(Response.Status.OK, itemJson(item, includePayload = true).toString())
    }

    private fun handleDelete(id: String): Response =
        if (outbox.delete(id)) noContent() else notFound()

    private fun handleAttempt(body: JSONObject?, id: String): Response {
        if (body == null) {
            return badRequest("Request body must be a JSON object.")
        }
        val ok = body.opt("ok") as? Boolean ?: return badRequest("\"ok\" must be a boolean.")

        if (ok) {
            // Success is the same terminal state as an explicit user discard: the row goes
            // away. Handing the flusher a separate "mark done" state would just create a
            // second thing to garbage-collect.
            return if (outbox.delete(id)) noContent() else notFound()
        }

        val error = body.stringOrNull("error") ?: return badRequest("\"error\" must be a non-empty string when ok is false.")
        val permanent = body.opt("permanent") as? Boolean ?: false
        val updated = outbox.recordFailedAttempt(id, error, permanent) ?: return notFound()
        return jsonResponse(Response.Status.OK, itemJson(updated, includePayload = false).toString())
    }

    private fun handleRetry(id: String): Response {
        val updated = outbox.retry(id) ?: return notFound()
        return jsonResponse(Response.Status.OK, itemJson(updated, includePayload = false).toString())
    }

    // ---------------------------------------------------------------- JSON helpers

    /** The 201 body: just enough for the caller to correlate and order, never the echoed payload. */
    private fun enqueueBody(item: OutboxItem): String =
        JSONObject()
            .put("id", item.id)
            .put("status", item.status)
            .put("capturedAt", item.capturedAt)
            .put("seq", item.seq)
            .toString()

    private fun itemJson(item: OutboxItem, includePayload: Boolean): JSONObject {
        val json = JSONObject()
            .put("id", item.id)
            .put("kind", item.kind)
            .put("capturedAt", item.capturedAt)
            .put("seq", item.seq)
            .put("status", item.status)
            .put("attempts", item.attempts)
            // JSONObject#put drops the key entirely on a Kotlin null, and the contract says
            // lastError is `string | null` -- always present. JSONObject.NULL keeps it.
            .put("lastError", item.lastError ?: JSONObject.NULL)
        if (includePayload) {
            // Re-parsed rather than string-spliced so the payload nests as real JSON. It was
            // validated as an object on the way in, so this cannot throw for stored rows.
            json.put("payload", JSONObject(item.payload ?: "{}"))
        }
        return json
    }

    /**
     * Reads a JSON object body. NanoHTTPD stashes a non-form POST body under `postData`
     * once [IHTTPSession.parseBody] has consumed the socket. Any failure (unreadable body,
     * malformed JSON, a JSON array/scalar instead of an object) collapses to `null` -- the
     * caller turns that into a 400.
     */
    private fun readJsonBody(session: IHTTPSession): JSONObject? =
        try {
            val files = HashMap<String, String>()
            session.parseBody(files)
            files["postData"]?.let { JSONObject(it) }
        } catch (e: Exception) {
            null
        }

    /** A present, non-blank string value, or `null` for missing/blank/wrong-typed. */
    private fun JSONObject.stringOrNull(key: String): String? = (opt(key) as? String)?.takeIf { it.isNotBlank() }

    private fun jsonResponse(status: Response.IStatus, body: String): Response =
        newFixedLengthResponse(status, "application/json", body)

    private fun errorBody(error: String, detail: String? = null): String {
        val json = JSONObject().put("error", error)
        if (detail != null) {
            json.put("detail", detail)
        }
        return json.toString()
    }

    private fun notFound(): Response = jsonResponse(Response.Status.NOT_FOUND, errorBody("not_found"))

    private fun badRequest(detail: String): Response =
        jsonResponse(Response.Status.BAD_REQUEST, errorBody("invalid_request", detail))

    private fun noContent(): Response = newFixedLengthResponse(Response.Status.NO_CONTENT, MIME_PLAINTEXT, "")

    private fun withCors(response: Response): Response {
        response.addHeader("Access-Control-Allow-Origin", "*")
        response.addHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        response.addHeader("Access-Control-Allow-Headers", "$AUTH_HEADER, Content-Type")
        return response
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

    /**
     * Status codes NanoHTTPD 2.3.1's own [Response.Status] enum doesn't carry. 507 is the
     * honest answer for "your item is fine, this queue has no room" -- a 4xx would tell the
     * client it sent something wrong and invite it to give up on the capture.
     */
    private enum class ExtendedStatus(private val code: Int, private val reason: String) : Response.IStatus {
        INSUFFICIENT_STORAGE(507, "Insufficient Storage"),
        ;

        override fun getRequestStatus(): Int = code

        // NanoHTTPD writes this straight into the status line, so it must be "<code> <reason>".
        override fun getDescription(): String = "$code $reason"
    }

    companion object {
        private const val LOOPBACK_ADDRESS = "127.0.0.1"
        private const val HEALTH_PATH = "/api/health"
        private const val OUTBOX_PATH = "/api/outbox"
        private const val ATTEMPT_SEGMENT = "attempt"
        private const val RETRY_SEGMENT = "retry"
        private const val STATUS_PARAM = "status"
        private const val STATUS_FILTER_ALL = "all"
        private const val AUTH_HEADER = "Authorization"
        private const val BEARER_PREFIX = "Bearer "

        /** Reported by GET /api/health -- bump alongside the Local Hub design doc's phase markers. */
        const val API_VERSION = "0.2.0"
    }
}
