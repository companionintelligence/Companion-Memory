package com.companionintelligence.localllm.intents

import com.companionintelligence.localllm.LocalLlmAccelerator
import com.companionintelligence.localllm.LocalLlmEngine
import com.companionintelligence.localllm.LocalLlmModels
import com.companionintelligence.localllm.LocalLlmPolicy
import com.companionintelligence.localllm.RepoFiles
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

@RunWith(RobolectricTestRunner::class)
class LocalSearchToolTest {

    private val budget = LocalLlmPolicy.toolResultByteBudget(1024)

    @Test
    fun the_declaration_is_the_appliance_s_lean_form_of_knowledge_search_name_description_and_every_parameter() {
        val declaration = JSONObject(LocalSearchTool(source(), budget).getToolDescriptionJsonString())

        assertEquals("knowledge_search", declaration.getString("name"))

        // The copy is held against the TypeScript that publishes the lean form (`schema.local` in
        // DatabaseSearchTool.ts): the description sentences, each property name, and the kinds.
        val source = RepoFiles.read("backend/apps/api/src/domains/tools/tools/DatabaseSearchTool.ts")
        val local = source.substring(source.indexOf("local: {"), source.indexOf("domain: 'knowledge'"))

        for (sentence in LocalSearchTool.DESCRIPTION.split(". ").map { it.trim().trimEnd('.') }) {
            assertTrue("the TypeScript no longer says \"$sentence\"", local.contains(sentence))
        }

        val properties = declaration.getJSONObject("parameters").getJSONObject("properties")
        for (name in listOf("query", "entityTypes", "since", "until", "sort", "countOnly")) {
            assertTrue("$name is not in the Kotlin copy", properties.has(name))
            assertTrue("$name is no longer in the TypeScript lean form", local.contains("$name: {"))
        }
        assertEquals(6, properties.length())

        val leanTypes = source.substring(source.indexOf("const LEAN_ENTITY_TYPES = ["), source.indexOf("] as const;", source.indexOf("const LEAN_ENTITY_TYPES = [")))
        val published = Regex("'([a-z-]+)'").findAll(leanTypes).map { it.groupValues[1] }.toList()
        assertEquals(published, LocalSearch.LEAN_ENTITY_TYPES)
        assertEquals(JSONArray(published).toString(), properties.getJSONObject("entityTypes").getJSONObject("items").getJSONArray("enum").toString())
    }

    @Test
    fun a_call_runs_against_the_replica_and_the_answer_is_shaped_to_the_budget() {
        val rows = (0 until 25).map { LocalSearchRow("note", "n$it", "Note $it", "x".repeat(900), "2026-01-0${it % 9 + 1} 10:00:00Z", null) }
        val tool = LocalSearchTool(source(total = 2_300, rows = rows), budget)

        val answer = tool.execute("""{"query": "note"}""")

        assertTrue("the model is handed ${utf8(answer)} bytes of a $budget byte budget", utf8(answer) <= budget)
        val parsed = JSONObject(answer)
        assertTrue(parsed.getString("summary").startsWith("Showing the top 25 of 2300 matches (exact count)."))
        assertEquals("local", parsed.getString("mode"))

        // Whitespace is no arguments; malformed JSON is refused without touching the replica.
        assertTrue(JSONObject(tool.execute("  ")).has("items"))
        assertTrue(JSONObject(tool.execute("{nope")).getString("error").startsWith("Arguments were not valid JSON"))
    }

    @Test
    fun a_replica_that_cannot_be_read_answers_with_an_error_the_model_can_repeat() {
        val broken =
            object : LocalSearchSource {
                override fun isAvailable() = true
                override fun rows(sql: String, params: List<String>) = throw IllegalStateException("file is locked")
                override fun count(sql: String, params: List<String>) = throw IllegalStateException("file is locked")
            }

        val answer = JSONObject(LocalSearchTool(broken, budget).execute("""{"query": "x"}"""))

        assertEquals("This phone's copy of your memory could not be searched: file is locked", answer.getString("error"))
    }

    @Test
    fun with_no_appliance_catalog_the_phone_s_search_is_the_whole_tool_set() {
        val unreachable = CompanionIntentClient(TestHttpServer.unreachableBaseUrl(), "k", 1_000)

        val tools = IntentToolProvider.toolsForLoad(loadSpec(), unreachable, source())

        assertEquals(listOf("knowledge_search"), tools.map { (it as LocalSearchTool).name })
        // And none at all when the phone has no replica — what a load got before 2026-10-22.
        assertTrue(IntentToolProvider.toolsForLoad(loadSpec(), unreachable, source(available = false)).isEmpty())
        assertTrue(IntentToolProvider.toolsForLoad(loadSpec(), null, null).isEmpty())
    }

    @Test
    fun connected_the_appliance_s_search_stays_and_the_phone_s_fills_in_only_what_the_catalog_lacks() {
        applianceServer(manifestOf("knowledge.search", "people.find")).use { server ->
            val client = CompanionIntentClient(server.baseUrl, "k")

            val connected = IntentToolProvider.toolsForLoad(loadSpec(), client, source(), preferLocal = false)
            assertEquals(listOf("knowledge_search", "people_find"), connected.map { name(it) })
            assertTrue(connected[0] is IntentTool)
        }

        applianceServer(manifestOf("people.find")).use { server ->
            val client = CompanionIntentClient(server.baseUrl, "k")

            val filled = IntentToolProvider.toolsForLoad(loadSpec(), client, source(), preferLocal = false)
            assertEquals(listOf("people_find", "knowledge_search"), filled.map { name(it) })
            assertTrue(filled[1] is LocalSearchTool)
        }
    }

    @Test
    fun not_connected_the_phone_s_search_replaces_the_appliance_s() {
        applianceServer(manifestOf("knowledge.search", "people.find")).use { server ->
            val client = CompanionIntentClient(server.baseUrl, "k")

            val offline = IntentToolProvider.toolsForLoad(loadSpec(), client, source(), preferLocal = true)

            assertEquals(listOf("people_find", "knowledge_search"), offline.map { name(it) })
            assertTrue(offline.last() is LocalSearchTool)
            assertFalse(offline.any { it is IntentTool && it.name == "knowledge_search" })
        }
    }

    @Test
    fun a_model_without_a_tool_slot_gets_nothing_even_with_a_replica() {
        val toolless = LocalLlmModels.GEMMA_4_E2B_IT.copy(modelId = "toolless-test", capabilities = setOf("thinking"))

        assertTrue(IntentToolProvider.toolsForLoad(loadSpec(info = toolless), null, source()).isEmpty())
    }

    // ---- harness ----------------------------------------------------------------------

    private fun name(tool: Any): String =
        when (tool) {
            is IntentTool -> tool.name
            is LocalSearchTool -> tool.name
            else -> error("unexpected tool $tool")
        }

    private fun source(available: Boolean = true, total: Int = 0, rows: List<LocalSearchRow> = emptyList()): LocalSearchSource =
        object : LocalSearchSource {
            override fun isAvailable() = available
            override fun rows(sql: String, params: List<String>) = rows
            override fun count(sql: String, params: List<String>) = total
        }

    private fun loadSpec(info: com.companionintelligence.localllm.LocalLlmModelInfo = LocalLlmModels.GEMMA_4_E2B_IT, maxTokens: Int = 1024) =
        LocalLlmEngine.LoadSpec(
            info = info,
            modelPath = "/dev/null",
            maxTokens = maxTokens,
            topK = info.defaultTopK,
            topP = info.defaultTopP,
            temperature = info.defaultTemperature,
            accelerator = LocalLlmAccelerator.CPU,
            enableSpeculativeDecoding = false,
            toolsGeneration = 0,
        )

    private fun applianceServer(manifest: String): TestHttpServer =
        TestHttpServer { exchange, request ->
            when {
                request.method == "GET" -> exchange.respond(200, manifest)
                JSONObject(request.body).getString("method") == "initialize" -> {
                    exchange.responseHeaders.add("Mcp-Session-Id", "session-1")
                    exchange.respond(200, """{"jsonrpc": "2.0", "id": 1, "result": {}}""")
                }
                else -> exchange.respond(200, """{"jsonrpc": "2.0", "id": 2, "result": {"content": [{"type": "text", "text": "{}"}]}}""")
            }
        }

    private fun manifestOf(vararg names: String): String =
        JSONObject()
            .put("version", "1.2.0")
            .put("tier", "local")
            .put(
                "intents",
                JSONArray(
                    names.map { name ->
                        JSONObject()
                            .put("name", name)
                            .put("tool", name.replace('.', '_'))
                            .put("title", name)
                            .put("description", "d")
                            .put("domain", name.substringBefore('.'))
                            .put("parameters", JSONObject().put("type", "object"))
                            .put("dispatch", JSONObject().put("decision", "execute").put("reason", "r").put("explanation", "ok"))
                    },
                ),
            )
            .toString()
}
