package com.companionintelligence.localllm.intents

import com.companionintelligence.localllm.RecordedRequest
import com.companionintelligence.localllm.TestExchange
import com.companionintelligence.localllm.TestHttpServer
import com.companionintelligence.localllm.respond
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * [IntentTool] is `internal`; the unit-test compilation is associated with the main one via the
 * Kotlin plugin's friend paths, so it is visible here without widening it in production code.
 */
@RunWith(RobolectricTestRunner::class)
class IntentToolTest {

    @Test
    fun the_function_handed_to_the_model_uses_the_mcp_tool_name_and_the_servers_schema_verbatim() {
        val schema =
            JSONObject(
                """{"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]}""",
            )
        val description = JSONObject(IntentTool(intent(parameters = schema), unreachableClient()).getToolDescriptionJsonString())

        // `memory_recall`, not `memory.recall`: MCP tools/call addresses tools by the underscored
        // name, and the model emits whatever this string says. A dotted name here fails at
        // runtime, on the appliance, with no compile-time signal at all.
        assertEquals("memory_recall", description.getString("name"))
        assertEquals("Recall memory. Search the user's own records.", description.getString("description"))

        // The schema is passed through untouched so the model is constrained by the same JSON
        // Schema the appliance validates against.
        val parameters = description.getJSONObject("parameters")
        assertEquals("object", parameters.getString("type"))
        assertEquals("string", parameters.getJSONObject("properties").getJSONObject("query").getString("type"))
        assertEquals(listOf("query"), parameters.getJSONArray("required").toStringList())
    }

    @Test
    fun the_description_drops_a_title_that_would_only_repeat_the_description() {
        val duplicated = intent(title = "Search the user's own records.")
        val untitled = intent(title = "")

        assertEquals(
            "Search the user's own records.",
            JSONObject(IntentTool(duplicated, unreachableClient()).getToolDescriptionJsonString()).getString("description"),
        )
        assertEquals(
            "Search the user's own records.",
            JSONObject(IntentTool(untitled, unreachableClient()).getToolDescriptionJsonString()).getString("description"),
        )
    }

    @Test
    fun a_non_executable_ruling_is_refused_at_call_time_without_contacting_the_appliance() {
        mcpServer { exchange, _ -> exchange.respond(200, toolResult("should never run")) }.use { server ->
            val client = CompanionIntentClient(server.baseUrl, "k")
            val queued =
                IntentTool(
                    intent(dispatch = DispatchRuling("queue", "writes", "Confirm this on the appliance first.")),
                    client,
                )
            val denied = IntentTool(intent(dispatch = DispatchRuling("deny", "third-party", "Not from this device.")), client)
            val unruled = IntentTool(intent(dispatch = null), client)

            // The refusal is handed back as content the model can read out, not thrown.
            assertEquals("Confirm this on the appliance first.", JSONObject(queued.execute("""{"query": "x"}""")).getString("error"))
            assertEquals("Not from this device.", JSONObject(denied.execute("{}")).getString("error"))
            assertEquals("\"memory.recall\" may not run on this device", JSONObject(unruled.execute("{}")).getString("error"))

            // The point of re-checking at call time: registration and invocation are separated by
            // the whole lifetime of a loaded conversation, and this is the last chokepoint before
            // a queued or denied action would actually leave the device.
            assertTrue("a non-executable intent reached the appliance", server.requests.isEmpty())
        }
    }

    @Test
    fun whitespace_arguments_mean_no_arguments_but_malformed_json_is_refused() {
        mcpServer { exchange, _ -> exchange.respond(200, toolResult("done")) }.use { server ->
            val tool = IntentTool(intent(), CompanionIntentClient(server.baseUrl, "k"))

            // A model that emits nothing (or a stray newline) for a zero-argument tool must still
            // get the call made; "Arguments were not valid JSON" for whitespace would make every
            // no-argument intent unusable.
            assertEquals("done", tool.execute(""))
            assertEquals("done", tool.execute("   "))

            val sent = server.requests.map { JSONObject(it.body) }.filter { it.getString("method") == "tools/call" }
            assertEquals(2, sent.size)
            assertEquals(0, sent[0].getJSONObject("params").getJSONObject("arguments").length())

            val requestsBefore = server.requests.size
            val refusal = JSONObject(tool.execute("{not json"))
            assertTrue(refusal.getString("error").startsWith("Arguments were not valid JSON"))
            assertEquals("malformed arguments still reached the appliance", requestsBefore, server.requests.size)
        }
    }

    @Test
    fun an_appliance_failure_comes_back_as_content_so_the_generation_can_continue() {
        mcpServer { exchange, _ -> exchange.respond(500, "the intent handler crashed") }.use { server ->
            val tool = IntentTool(intent(), CompanionIntentClient(server.baseUrl, "k"))

            // Thrown, this would abort the whole generation mid-answer. Returned, the model can
            // say what failed or try a different intent.
            val error = JSONObject(tool.execute("{}")).getString("error")
            assertTrue("unexpected error text: $error", error.contains("500"))
        }
    }

    @Test
    fun an_unreachable_appliance_yields_no_tools_rather_than_failing_the_model_load() {
        // loadModel() calls this before creating the conversation. Throwing here would make the
        // *offline* tier depend on being online — the exact failure on-device inference exists
        // to prevent.
        assertTrue(
            IntentToolProvider.buildProviders(CompanionIntentClient(TestHttpServer.unreachableBaseUrl(), "k", 1_000)).isEmpty(),
        )
    }

    @Test
    fun a_catalogue_the_appliance_cannot_serve_yields_no_tools_rather_than_an_exception() {
        TestHttpServer { exchange, _ -> exchange.respond(500, "internal error") }.use { server ->
            assertTrue(IntentToolProvider.buildProviders(CompanionIntentClient(server.baseUrl, "k")).isEmpty())
        }
    }

    @Test
    fun only_the_intents_the_server_ruled_executable_become_tools() {
        val manifest =
            """
            {
              "version": "1.2.0",
              "tier": "local",
              "intents": [
                {"name": "memory.recall", "dispatch": {"decision": "execute", "reason": "r", "explanation": "e"}},
                {"name": "note.append", "dispatch": {"decision": "execute", "reason": "r", "explanation": "e"}},
                {"name": "email.send", "dispatch": {"decision": "deny", "reason": "r", "explanation": "e"}}
              ]
            }
            """.trimIndent()

        TestHttpServer { exchange, _ -> exchange.respond(200, manifest) }.use { server ->
            assertEquals(2, IntentToolProvider.buildProviders(CompanionIntentClient(server.baseUrl, "k")).size)
        }
    }

    // ---- harness ----------------------------------------------------------------------

    private fun intent(
        name: String = "memory.recall",
        tool: String = "memory_recall",
        title: String = "Recall memory",
        description: String = "Search the user's own records.",
        parameters: JSONObject = JSONObject(),
        dispatch: DispatchRuling? = DispatchRuling("execute", "read-only", "ok"),
    ) = ManifestIntent(name, tool, title, description, parameters, dispatch)

    /** Points at a port nothing is listening on, with a short timeout. */
    private fun unreachableClient() = CompanionIntentClient(TestHttpServer.unreachableBaseUrl(), "k", 1_000)

    private fun mcpServer(onToolCall: (TestExchange, RecordedRequest) -> Unit): TestHttpServer =
        TestHttpServer { exchange, request ->
            if (JSONObject(request.body).getString("method") == "initialize") {
                exchange.responseHeaders.add("Mcp-Session-Id", "session-1")
                exchange.respond(200, """{"jsonrpc": "2.0", "id": 1, "result": {}}""")
            } else {
                onToolCall(exchange, request)
            }
        }

    private fun toolResult(text: String): String =
        JSONObject()
            .put("jsonrpc", "2.0")
            .put("id", 2)
            .put("result", JSONObject().put("content", JSONArray().put(JSONObject().put("type", "text").put("text", text))))
            .toString()

    private fun JSONArray.toStringList(): List<String> = (0 until length()).map { getString(it) }
}
