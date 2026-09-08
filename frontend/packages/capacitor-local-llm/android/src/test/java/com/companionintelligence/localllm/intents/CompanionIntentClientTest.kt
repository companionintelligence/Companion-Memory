package com.companionintelligence.localllm.intents

import com.companionintelligence.localllm.RecordedRequest
import com.companionintelligence.localllm.TestExchange
import com.companionintelligence.localllm.TestHttpServer
import com.companionintelligence.localllm.respond
import java.io.IOException
import java.util.concurrent.atomic.AtomicInteger
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * Driven against a real loopback server rather than a mocked connection: everything here is a
 * wire-level contract with CI-Server (a path, a header, a JSON-RPC frame, an SSE body), and a
 * mock could only restate what this file already believes.
 */
@RunWith(RobolectricTestRunner::class)
class CompanionIntentClientTest {

    @Test
    fun the_catalogue_path_keeps_the_servers_doubled_api_prefix_however_the_base_url_is_written() {
        TestHttpServer { exchange, _ ->
            exchange.respond(200, """{"version": "1.2.0", "tier": "local", "intents": []}""")
        }.use { server ->
            // A base URL with and without a trailing slash: the app stores whatever the user
            // typed into the appliance-address field, so both really occur.
            CompanionIntentClient(server.baseUrl, "secret-key").fetchManifest()
            CompanionIntentClient(server.baseUrl + "/", "secret-key").fetchManifest()

            // The doubled `/api` is not a typo: IntentsController is @Controller('api/intents')
            // behind a proxy that already strips one `/api`. "Fixing" it 404s every install and
            // leaves the model silently toolless.
            assertEquals(
                listOf("/api/api/intents?tier=local", "/api/api/intents?tier=local"),
                server.requests.map { it.path },
            )
            assertEquals("GET", server.requests[0].method)
            assertEquals("secret-key", server.requests[0].headers["x-api-key"]?.firstOrNull())
        }
    }

    @Test
    fun a_catalogue_error_is_raised_with_the_status_code_rather_than_parsed_as_a_manifest() {
        TestHttpServer { exchange, _ -> exchange.respond(500, "boom") }.use { server ->
            val error =
                assertThrows(IOException::class.java) {
                    CompanionIntentClient(server.baseUrl, "k").fetchManifest()
                }

            assertTrue(error.message!!.contains("500"))
            assertTrue(error.message!!.contains("boom"))
        }
    }

    @Test
    fun one_mcp_handshake_is_reused_across_tool_calls() {
        mcpServer { exchange, _ -> exchange.respond(200, toolResult("recalled")) }.use { server ->
            val client = CompanionIntentClient(server.baseUrl, "k")

            assertEquals("recalled", client.callTool("memory_recall", JSONObject().put("query", "a")))
            assertEquals("recalled", client.callTool("memory_recall", JSONObject().put("query", "b")))

            val frames = server.requests.map { JSONObject(it.body) }
            assertEquals(3, frames.size)
            assertEquals(listOf("initialize", "tools/call", "tools/call"), frames.map { it.getString("method") })

            // Every frame is addressed to /api/mcp — the *single* `/api`, unlike the catalogue.
            assertEquals(listOf("/api/mcp", "/api/mcp", "/api/mcp"), server.requests.map { it.path })

            // Ids must advance; a strict JSON-RPC peer treats a repeated id as a duplicate request.
            assertEquals(listOf(1, 2, 3), frames.map { it.getInt("id") })
            assertEquals(listOf("2.0", "2.0", "2.0"), frames.map { it.getString("jsonrpc") })

            // The session the handshake handed out is echoed on both calls — and the handshake is
            // not repeated, which is what makes the second call cheap.
            assertEquals(
                listOf("session-1", "session-1"),
                server.requests.drop(1).map { it.headers["mcp-session-id"]?.firstOrNull() },
            )

            val params = frames[1].getJSONObject("params")
            assertEquals("memory_recall", params.getString("name"))
            assertEquals("a", params.getJSONObject("arguments").getString("query"))
        }
    }

    @Test
    fun an_expired_session_is_re_established_once_and_the_call_retried() {
        val toolCalls = AtomicInteger(0)

        // 404 is how the server reports an unknown session (they are reaped after 30 minutes
        // idle), so the *first* tool call after a pause always looks like this.
        mcpServer { exchange, _ ->
            if (toolCalls.incrementAndGet() == 1) {
                exchange.respond(404, """{"error": "no such session"}""")
            } else {
                exchange.respond(200, toolResult("recovered"))
            }
        }.use { server ->
            val client = CompanionIntentClient(server.baseUrl, "k")

            assertEquals("recovered", client.callTool("memory_recall", JSONObject()))
            assertEquals(2, server.requests.count { JSONObject(it.body).getString("method") == "initialize" })
            assertEquals(2, toolCalls.get())
        }
    }

    @Test
    fun a_session_that_is_rejected_twice_gives_up_instead_of_re_handshaking_forever() {
        val toolCalls = AtomicInteger(0)

        mcpServer { exchange, _ ->
            toolCalls.incrementAndGet()
            exchange.respond(404, """{"error": "no such session"}""")
        }.use { server ->
            val client = CompanionIntentClient(server.baseUrl, "k")

            assertThrows(IOException::class.java) { client.callTool("memory_recall", JSONObject()) }

            // Exactly one retry: two handshakes, two tool calls, then the failure surfaces.
            assertEquals(2, toolCalls.get())
            assertEquals(2, server.requests.count { JSONObject(it.body).getString("method") == "initialize" })
        }
    }

    @Test
    fun an_sse_framed_response_is_read_from_its_last_frame_not_its_first() {
        // Streamable HTTP: the result frame is the last one, after any number of progress or
        // notification frames. Taking the first returns whatever the server happened to emit
        // while it was still working.
        val stream =
            "event: message\n" +
                "data: ${toolResult("a progress notification")}\n" +
                "\n" +
                "event: message\n" +
                "data: ${toolResult("the real answer")}\n" +
                "\n"

        mcpServer { exchange, _ ->
            exchange.responseHeaders.add("Content-Type", "text/event-stream")
            exchange.respond(200, stream)
        }.use { server ->
            assertEquals("the real answer", CompanionIntentClient(server.baseUrl, "k").callTool("memory_recall", JSONObject()))
        }
    }

    @Test
    fun a_body_that_is_neither_json_nor_an_sse_frame_is_reported_rather_than_returned() {
        mcpServer { exchange, _ -> exchange.respond(200, "<html>proxy error page</html>") }.use { server ->
            val error =
                assertThrows(IOException::class.java) {
                    CompanionIntentClient(server.baseUrl, "k").callTool("memory_recall", JSONObject())
                }

            assertTrue(error.message!!.contains("neither JSON nor an SSE frame"))
        }
    }

    @Test
    fun every_text_part_of_a_tool_result_is_returned_in_order() {
        // MCP results are an array of content blocks; a long answer arrives split across several.
        // Reading only the first truncates the answer with no error anywhere.
        mcpServer { exchange, _ -> exchange.respond(200, toolResult("one ", "two ", "three")) }.use { server ->
            assertEquals("one two three", CompanionIntentClient(server.baseUrl, "k").callTool("memory_recall", JSONObject()))
        }
    }

    @Test
    fun a_json_rpc_error_frame_is_raised_carrying_the_appliances_own_message() {
        mcpServer { exchange, _ ->
            exchange.respond(
                200,
                """{"jsonrpc": "2.0", "id": 2, "error": {"code": -32000, "message": "intent blew up"}}""",
            )
        }.use { server ->
            val error =
                assertThrows(IOException::class.java) {
                    CompanionIntentClient(server.baseUrl, "k").callTool("memory_recall", JSONObject())
                }

            // A JSON-RPC error is HTTP 200, so nothing else in the stack would notice it.
            assertTrue(error.message!!.contains("intent blew up"))
        }
    }

    // ---- harness ----------------------------------------------------------------------

    /** Handles the `initialize` handshake; delegates every other frame to [onToolCall]. */
    private fun mcpServer(onToolCall: (TestExchange, RecordedRequest) -> Unit): TestHttpServer =
        TestHttpServer { exchange, request ->
            if (JSONObject(request.body).getString("method") == "initialize") {
                exchange.responseHeaders.add("Mcp-Session-Id", "session-1")
                exchange.respond(200, """{"jsonrpc": "2.0", "id": 1, "result": {"protocolVersion": "2025-03-26"}}""")
            } else {
                onToolCall(exchange, request)
            }
        }

    private fun toolResult(vararg texts: String): String {
        val content = JSONArray()
        texts.forEach { content.put(JSONObject().put("type", "text").put("text", it)) }

        return JSONObject()
            .put("jsonrpc", "2.0")
            .put("id", 2)
            .put("result", JSONObject().put("content", content))
            .toString()
    }
}
