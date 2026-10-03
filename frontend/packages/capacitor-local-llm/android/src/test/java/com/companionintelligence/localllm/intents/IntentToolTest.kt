package com.companionintelligence.localllm.intents

import com.companionintelligence.localllm.LocalLlmAccelerator
import com.companionintelligence.localllm.LocalLlmEngine
import com.companionintelligence.localllm.LocalLlmModelInfo
import com.companionintelligence.localllm.LocalLlmModels
import com.companionintelligence.localllm.LocalLlmPolicy
import com.companionintelligence.localllm.RecordedRequest
import com.companionintelligence.localllm.TestExchange
import com.companionintelligence.localllm.TestHttpServer
import com.companionintelligence.localllm.intents.ToolResultFixtures.utf8
import com.companionintelligence.localllm.respond
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.shadows.ShadowLog

/**
 * [IntentTool] is `internal`; the unit-test compilation is associated with the main one via the
 * Kotlin plugin's friend paths, so it is visible here without widening it in production code.
 */
@RunWith(RobolectricTestRunner::class)
class IntentToolTest {

    /** What a tool on Qwen3-0.6B's 1,024-token window is given: the smallest window the app ships. */
    private val budget = LocalLlmPolicy.toolResultByteBudget(1024)

    @Test
    fun the_function_handed_to_the_model_uses_the_mcp_tool_name_and_the_servers_schema_verbatim() {
        val schema =
            JSONObject(
                """{"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]}""",
            )
        val description = JSONObject(IntentTool(intent(parameters = schema), unreachableClient(), budget).getToolDescriptionJsonString())

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
            JSONObject(IntentTool(duplicated, unreachableClient(), budget).getToolDescriptionJsonString()).getString("description"),
        )
        assertEquals(
            "Search the user's own records.",
            JSONObject(IntentTool(untitled, unreachableClient(), budget).getToolDescriptionJsonString()).getString("description"),
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
                    budget,
                )
            val denied = IntentTool(intent(dispatch = DispatchRuling("deny", "third-party", "Not from this device.")), client, budget)
            val unruled = IntentTool(intent(dispatch = null), client, budget)

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
            val tool = IntentTool(intent(), CompanionIntentClient(server.baseUrl, "k"), budget)

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
            val tool = IntentTool(intent(), CompanionIntentClient(server.baseUrl, "k"), budget)

            // Thrown, this would abort the whole generation mid-answer. Returned, the model can
            // say what failed or try a different intent.
            val error = JSONObject(tool.execute("{}")).getString("error")
            assertTrue("unexpected error text: $error", error.contains("500"))
        }
    }

    @Test
    fun a_failure_with_a_whole_page_for_a_body_reaches_the_model_as_a_sentence_that_still_names_the_status() {
        mcpServer { exchange, _ -> exchange.respond(502, "<html>" + "Bad gateway from the proxy. ".repeat(3_000)) }.use { server ->
            val tool = IntentTool(intent(), CompanionIntentClient(server.baseUrl, "k"), budget)
            val payload = tool.execute("{}")
            val error = JSONObject(payload).getString("error")

            assertTrue("it still says what happened: $error", error.contains("HTTP 502"))
            assertTrue("and how the server began to say it: $error", error.contains("<html>Bad gateway from the proxy."))
            assertTrue("but it is not the page (${utf8(payload)} bytes)", utf8(payload) < 400)
        }
    }

    @Test
    fun an_unreachable_appliance_yields_no_tools_rather_than_failing_the_model_load() {
        // loadModel() calls this before creating the conversation. Throwing here would make the
        // *offline* tier depend on being online — the exact failure on-device inference exists
        // to prevent.
        assertTrue(
            IntentToolProvider.buildProviders(CompanionIntentClient(TestHttpServer.unreachableBaseUrl(), "k", 1_000), budget).isEmpty(),
        )
    }

    @Test
    fun a_catalogue_the_appliance_cannot_serve_yields_no_tools_rather_than_an_exception() {
        TestHttpServer { exchange, _ -> exchange.respond(500, "internal error") }.use { server ->
            assertTrue(IntentToolProvider.buildProviders(CompanionIntentClient(server.baseUrl, "k"), budget).isEmpty())
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
            assertEquals(2, IntentToolProvider.buildProviders(CompanionIntentClient(server.baseUrl, "k"), budget).size)
        }
    }

    // ---- what comes back is bounded ------------------------------------------------------------------------

    @Test
    fun a_tool_result_many_times_the_window_is_cut_to_the_budget_before_the_model_sees_it() {
        // What `knowledge_search` really answers with: 25 hydrated entities, pretty-printed, tens of kilobytes.
        val raw = ToolResultFixtures.searchResult(items = 25, contentLength = 1_200)

        assertTrue("the fixture is as big as the real thing (${utf8(raw)} bytes)", utf8(raw) > 40_000)

        mcpServer { exchange, _ -> exchange.respond(200, toolResult(raw)) }.use { server ->
            val tool = IntentTool(intent(), CompanionIntentClient(server.baseUrl, "k"), budget)

            val answer = tool.execute("""{"query": "zephyr"}""")

            assertTrue("the model is handed ${utf8(answer)} bytes of a $budget byte budget", utf8(answer) <= budget)
            assertEquals("exactly what the shaper makes of it", ToolResultShaper.shape(raw, budget), answer)

            // ...and still an answer: the header whole, and a note that the list was cut.
            val parsed = JSONObject(answer)

            assertTrue(parsed.getString("summary").startsWith("Showing the top 25 of at least 25 matches."))

            val items = parsed.getJSONArray("items")

            assertTrue(items.getString(items.length() - 1).contains("more results omitted"))
        }
    }

    @Test
    fun a_small_result_and_the_tools_own_error_payloads_reach_the_model_untouched() {
        // Pretty-printed on purpose: any reshaping would show.
        val small = "{\n  \"summary\": \"Showing the top 1 of at least 1 matches.\",\n  \"items\": [\n    {\n      \"title\": \"One\"\n    }\n  ]\n}"

        mcpServer { exchange, _ -> exchange.respond(200, toolResult(small)) }.use { server ->
            assertEquals(small, IntentTool(intent(), CompanionIntentClient(server.baseUrl, "k"), budget).execute("{}"))
        }

        // With the smallest budget there is, one that even these sentences are over, so that anything routed
        // through the shaper would change them: a failure the appliance reports, a refusal, and arguments that
        // are not JSON.
        val floor = ToolResultShaper.MINIMUM_BUDGET_BYTES

        mcpServer { exchange, _ -> exchange.respond(500, "the intent handler crashed") }.use { server ->
            val failed = IntentTool(intent(), CompanionIntentClient(server.baseUrl, "k"), floor).execute("{}")

            assertEquals("""{"error":"MCP call failed (HTTP 500) the intent handler crashed"}""", failed)
            assertTrue(utf8(failed) > floor)
        }

        val explanation = "Not from this device, and not from any other either, as it happens."
        val refused = IntentTool(intent(dispatch = DispatchRuling("deny", "third-party", explanation)), unreachableClient(), floor)

        assertEquals("""{"error":"$explanation"}""", refused.execute("{}"))

        val garbled = IntentTool(intent(), unreachableClient(), floor).execute("{not json")

        assertTrue(garbled, garbled.startsWith("""{"error":"Arguments were not valid JSON"""))
        assertTrue(utf8(garbled) > floor)
    }

    @Test
    fun the_budget_a_tool_is_built_with_is_the_one_it_enforces() {
        val raw = ToolResultFixtures.searchResult(items = 25, contentLength = 200)

        applianceServer(manifestOf("knowledge.search", "people.find"), raw).use { server ->
            val client = CompanionIntentClient(server.baseUrl, "k")

            val narrow = IntentToolProvider.buildTools(client, 700)
            val roomy = IntentToolProvider.buildTools(client, 3_000)

            assertEquals(2, narrow.size)
            assertEquals(2, roomy.size)

            for (tool in narrow) {
                assertTrue(utf8(tool.execute("{}")) <= 700)
            }
            for (tool in roomy) {
                val answer = utf8(tool.execute("{}"))

                assertTrue("a roomier budget lets more through ($answer bytes)", answer in 701..3_000)
            }
        }
    }

    @Test
    fun the_tools_a_load_is_given_are_sized_for_the_window_that_load_was_configured_with() {
        val raw = ToolResultFixtures.searchResult(items = 25, contentLength = 200)

        applianceServer(manifestOf("knowledge.search"), raw).use { server ->
            val client = CompanionIntentClient(server.baseUrl, "k")
            val answers = ArrayList<Int>()

            // The window a load was configured with, not the model's default: `loadModel` passes spec.maxTokens.
            for (window in listOf(1024, 2048, 4096)) {
                val tools = IntentToolProvider.toolsForLoad(loadSpec(maxTokens = window), client)
                val answer = utf8(tools.single().execute("{}"))

                assertTrue("a $window token window gets at most ${LocalLlmPolicy.toolResultByteBudget(window)} bytes, not $answer", answer <= LocalLlmPolicy.toolResultByteBudget(window))

                answers.add(answer)
            }

            assertTrue("a bigger window lets more through: $answers", answers[0] < answers[1] && answers[1] < answers[2])
        }
    }

    @Test
    fun a_load_gets_no_tools_for_a_model_without_a_tool_slot_or_without_an_appliance_and_asks_for_nothing() {
        applianceServer(manifestOf("knowledge.search"), "{}").use { server ->
            val client = CompanionIntentClient(server.baseUrl, "k")

            assertTrue(LocalLlmModels.QWEN3_0_6B_INT4.supportsTools)
            assertFalse("Qwen2.5's chat template has no tool slot", LocalLlmModels.QWEN2_5_1_5B_INSTRUCT.supportsTools)

            assertTrue(IntentToolProvider.toolsForLoad(loadSpec(info = LocalLlmModels.QWEN2_5_1_5B_INSTRUCT), client).isEmpty())
            assertTrue(IntentToolProvider.toolsForLoad(loadSpec(), null).isEmpty())
            assertTrue("neither asked the appliance for its catalogue", server.requests.isEmpty())
            assertEquals(1, IntentToolProvider.toolsForLoad(loadSpec(), client).size)
        }
    }

    @Test
    fun the_log_has_sizes_and_the_tools_name_and_nothing_the_tool_returned() {
        val raw = ToolResultFixtures.searchResult(items = 25)
        val shaped = ToolResultShaper.shape(raw, budget)

        ShadowLog.clear()

        mcpServer { exchange, _ -> exchange.respond(200, toolResult(raw)) }.use { server ->
            IntentTool(intent(), CompanionIntentClient(server.baseUrl, "k"), budget).execute("""{"query": "zephyr"}""")
        }

        val lines = ShadowLog.getLogs().filter { it.tag == "IntentTool" }.map { it.msg }

        assertEquals(lines.toString(), 1, lines.size)
        assertEquals("memory_recall returned ${utf8(raw)} bytes; passing ${utf8(shaped)} to the model (budget $budget)", lines.single())

        // The result is the user's own data. Not one line, from any tag, may carry a word of it.
        for (entry in ShadowLog.getLogs()) {
            assertFalse(entry.msg, entry.msg.contains("marmalade") || entry.msg.contains("0198a3f2") || entry.msg.contains("communication"))
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

    private fun loadSpec(info: LocalLlmModelInfo = LocalLlmModels.QWEN3_0_6B_INT4, maxTokens: Int = 1024) =
        LocalLlmEngine.LoadSpec(
            info = info,
            modelPath = "/models/model.litertlm",
            maxTokens = maxTokens,
            topK = 64,
            topP = 0.95,
            temperature = 1.0,
            accelerator = LocalLlmAccelerator.CPU,
            enableSpeculativeDecoding = false,
            toolsGeneration = 0,
        )

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

    /** A whole appliance: the catalogue on `GET`, and MCP on `POST` — every tool call answered with [toolText]. */
    private fun applianceServer(manifest: String, toolText: String): TestHttpServer =
        TestHttpServer { exchange, request ->
            when {
                request.method == "GET" -> exchange.respond(200, manifest)
                JSONObject(request.body).getString("method") == "initialize" -> {
                    exchange.responseHeaders.add("Mcp-Session-Id", "session-1")
                    exchange.respond(200, """{"jsonrpc": "2.0", "id": 1, "result": {}}""")
                }
                else -> exchange.respond(200, toolResult(toolText))
            }
        }

    /** A tier-aware catalogue in which every one of [names] may run on the device. */
    private fun manifestOf(vararg names: String): String =
        JSONObject()
            .put("version", "1.2.0")
            .put("tier", "local")
            .put(
                "intents",
                JSONArray(
                    names.map {
                        JSONObject()
                            .put("name", it)
                            .put("title", it)
                            .put("description", "Does $it.")
                            .put("parameters", JSONObject().put("type", "object"))
                            .put("dispatch", JSONObject().put("decision", "execute").put("reason", "read-only").put("explanation", "ok"))
                    },
                ),
            )
            .toString()

    private fun toolResult(text: String): String =
        JSONObject()
            .put("jsonrpc", "2.0")
            .put("id", 2)
            .put("result", JSONObject().put("content", JSONArray().put(JSONObject().put("type", "text").put("text", text))))
            .toString()

    private fun JSONArray.toStringList(): List<String> = (0 until length()).map { getString(it) }
}
