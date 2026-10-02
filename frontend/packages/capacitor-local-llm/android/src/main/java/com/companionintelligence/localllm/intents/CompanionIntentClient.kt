package com.companionintelligence.localllm.intents

import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.atomic.AtomicInteger
import org.json.JSONObject

/**
 * Talks to CI-Server on behalf of the on-device model: reads the intent catalog, and executes an
 * intent when the model calls one.
 *
 * Two facts about the server are baked in here rather than left to callers:
 *
 * 1. **The catalog is `<base>/api/intents` — one `/api`, like `<base>/api/mcp`.** The fronting
 *    proxy strips a leading `/api`, and both `IntentsController`
 *    (`@Controller(['intents', 'agent/intents'])`) and `McpController` (`@Controller('mcp')`) mount
 *    at bare paths. This client used to ask for `/api/api/intents`, which only worked while the
 *    controller baked its own `api/` into its mount (removed in #2653); on a current appliance that
 *    is a 404 and [IntentToolProvider] quietly offers no tools, so the model answers from its
 *    weights alone. An appliance older than #2653 is the mirror case: it only serves the doubled
 *    path, and reads as toolless the same graceful way.
 * 2. **There is no REST "execute this intent" endpoint.** The only wire protocol for
 *    "run intent X with args Y" is MCP `tools/call` over `POST /mcp`, which is JSON-RPC and
 *    requires an `initialize` handshake first; the returned `Mcp-Session-Id` must be echoed on
 *    every later call. That handshake is managed transparently below.
 *
 * Auth is the same `x-api-key` header the iOS App Intents already use — no cookies, no CSRF, so it
 * works from a background thread with no WebView involved.
 */
class CompanionIntentClient(
    private val baseUrl: String,
    private val apiKey: String,
    private val timeoutMs: Int = 30_000,
) {
    private val requestId = AtomicInteger(1)

    @Volatile
    private var sessionId: String? = null

    /** Reads the catalog with the server's own rulings for the on-device tier attached. */
    fun fetchManifest(): IntentManifest {
        val body = get("/api/intents?tier=local")

        return IntentManifest.parse(JSONObject(body))
    }

    /**
     * Runs [toolName] with [arguments] via MCP and returns the tool's text result.
     *
     * Re-handshakes once on a 404, which is how the server reports an expired or unknown session
     * (sessions are reaped after 30 minutes idle) — without that retry the first tool call after a
     * long pause would surface to the model as a hard failure.
     */
    fun callTool(toolName: String, arguments: JSONObject): String {
        return try {
            callToolOnce(toolName, arguments)
        } catch (e: SessionExpiredException) {
            sessionId = null
            callToolOnce(toolName, arguments)
        }
    }

    private fun callToolOnce(toolName: String, arguments: JSONObject): String {
        val session = sessionId ?: initializeSession()
        val payload =
            jsonRpc(
                "tools/call",
                JSONObject().put("name", toolName).put("arguments", arguments),
            )
        val response = postJsonRpc(payload, session)

        return extractToolText(response)
    }

    /** Opens an MCP session and caches its id. */
    private fun initializeSession(): String {
        val payload =
            jsonRpc(
                "initialize",
                JSONObject()
                    .put("protocolVersion", MCP_PROTOCOL_VERSION)
                    .put("capabilities", JSONObject())
                    .put(
                        "clientInfo",
                        JSONObject().put("name", "companion-on-device-llm").put("version", "1.0.0"),
                    ),
            )

        val connection = openConnection("/api/mcp")
        writeBody(connection, payload.toString())

        val status = connection.responseCode
        if (status !in 200..299) {
            throw IOException("MCP initialize failed (HTTP $status)")
        }

        // Case-insensitive: header casing is not guaranteed across proxies.
        val id =
            connection.headerFields.entries
                .firstOrNull { it.key?.equals(MCP_SESSION_HEADER, ignoreCase = true) == true }
                ?.value
                ?.firstOrNull()
                ?: throw IOException("MCP initialize returned no $MCP_SESSION_HEADER header")

        connection.inputStream.use { it.readBytes() }
        sessionId = id

        return id
    }

    private fun postJsonRpc(payload: JSONObject, session: String): JSONObject {
        val connection = openConnection("/api/mcp")
        connection.setRequestProperty(MCP_SESSION_HEADER, session)
        writeBody(connection, payload.toString())

        val status = connection.responseCode
        if (status == HttpURLConnection.HTTP_NOT_FOUND) {
            throw SessionExpiredException()
        }
        if (status !in 200..299) {
            val detail = connection.errorStream?.use { String(it.readBytes()) }.orEmpty()
            throw IOException("MCP call failed (HTTP $status) $detail".trim())
        }

        val text = connection.inputStream.use { String(it.readBytes()) }

        return parseMaybeSse(text)
    }

    /**
     * The MCP endpoint is Streamable HTTP: a response may come back as a plain JSON body or as an
     * SSE stream whose `data:` lines carry the JSON-RPC frames. Handle both rather than assuming
     * the transport stays in its simpler mode.
     */
    private fun parseMaybeSse(raw: String): JSONObject {
        val trimmed = raw.trim()
        if (trimmed.startsWith("{")) {
            return JSONObject(trimmed)
        }

        val payload =
            trimmed
                .lineSequence()
                .filter { it.startsWith("data:") }
                .map { it.removePrefix("data:").trim() }
                .lastOrNull { it.startsWith("{") }
                ?: throw IOException("MCP response was neither JSON nor an SSE frame")

        return JSONObject(payload)
    }

    /** Pulls the concatenated `content[].text` out of an MCP `CallToolResult`, surfacing errors. */
    private fun extractToolText(response: JSONObject): String {
        response.optJSONObject("error")?.let { error ->
            throw IOException("Intent failed: ${error.optString("message", "unknown MCP error")}")
        }

        val result = response.optJSONObject("result") ?: return response.toString()
        val content = result.optJSONArray("content") ?: return result.toString()
        val text = buildString {
            for (i in 0 until content.length()) {
                content.optJSONObject(i)?.optString("text")?.let(::append)
            }
        }

        // `isError` marks a tool-level failure whose message is already in `text`; hand it back to
        // the model as content rather than throwing, so it can explain or try a different intent.
        return text.ifEmpty { result.toString() }
    }

    private fun get(path: String): String {
        val connection = openConnection(path, method = "GET")
        val status = connection.responseCode

        if (status !in 200..299) {
            val detail = connection.errorStream?.use { String(it.readBytes()) }.orEmpty()
            throw IOException("GET $path failed (HTTP $status) $detail".trim())
        }

        return connection.inputStream.use { String(it.readBytes()) }
    }

    private fun openConnection(path: String, method: String = "POST"): HttpURLConnection {
        val url = URL(baseUrl.trimEnd('/') + path)
        val connection = url.openConnection() as HttpURLConnection

        connection.requestMethod = method
        connection.connectTimeout = timeoutMs
        connection.readTimeout = timeoutMs
        connection.setRequestProperty("x-api-key", apiKey)
        connection.setRequestProperty("Accept", "application/json, text/event-stream")

        if (method == "POST") {
            connection.doOutput = true
            connection.setRequestProperty("Content-Type", "application/json")
        }

        return connection
    }

    private fun writeBody(connection: HttpURLConnection, body: String) {
        connection.outputStream.use { it.write(body.toByteArray()) }
    }

    private fun jsonRpc(method: String, params: JSONObject): JSONObject =
        JSONObject()
            .put("jsonrpc", "2.0")
            .put("id", requestId.getAndIncrement())
            .put("method", method)
            .put("params", params)

    private class SessionExpiredException : IOException("MCP session expired")

    private companion object {
        const val MCP_SESSION_HEADER = "Mcp-Session-Id"
        const val MCP_PROTOCOL_VERSION = "2025-03-26"
    }
}
