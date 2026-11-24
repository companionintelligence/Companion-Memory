package com.companionintelligence.localllm.intents

import com.companionintelligence.localllm.LocalLlmPolicy
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * [IntentToolProvider.selectWithinBudget]: which intents become tools when their declarations, all of
 * which sit in every prompt, must fit a share of the window. Pure, so no server, no engine.
 */
@RunWith(RobolectricTestRunner::class)
class IntentToolSelectionTest {

    @Test
    fun everything_fits_when_there_is_no_budget_to_speak_of() {
        val intents = listOf(intent("suggestions.list", "suggestions", 200), intent("knowledge.search", "knowledge", 2_300))

        val selection = IntentToolProvider.selectWithinBudget(intents, Int.MAX_VALUE)

        assertEquals(listOf("knowledge.search", "suggestions.list"), selection.kept.map { it.name })
        assertTrue(selection.omitted.isEmpty())
    }

    @Test
    fun the_named_priorities_come_first_whatever_the_alphabet_says() {
        val intents =
            listOf(
                intent("anomalies.recent", "anomalies", 100),
                intent("memory.remember", "memory", 100),
                intent("memory.recall", "memory", 100),
                intent("knowledge.search", "knowledge", 100),
                intent("planning.findTasks", "planning", 100),
            )

        val kept = IntentToolProvider.selectWithinBudget(intents, Int.MAX_VALUE).kept.map { it.name }

        assertEquals(listOf("knowledge.search", "memory.recall", "planning.findTasks", "memory.remember", "anomalies.recent"), kept)
    }

    @Test
    fun unlisted_intents_follow_in_domain_order_then_by_name_and_an_unknown_domain_goes_last() {
        val intents =
            listOf(
                intent("zz.newThing", "zz", 100),
                intent("suggestions.feedback", "suggestions", 100),
                intent("people.relationships", "people", 100),
                intent("brief.list", "brief", 100),
                intent("places.next", "places", 100),
                intent("insights.explain", "insights", 100),
            )

        val kept = IntentToolProvider.selectWithinBudget(intents, Int.MAX_VALUE).kept.map { it.name }

        assertEquals(
            listOf("people.relationships", "places.next", "brief.list", "insights.explain", "suggestions.feedback", "zz.newThing"),
            kept,
        )
    }

    @Test
    fun a_declaration_that_does_not_fit_is_left_out_and_a_smaller_one_further_down_still_gets_in() {
        // Budget: 100 tokens. search ~ 60, recall ~ 60 (does not fit after search), people.find ~ 30 (does).
        val intents =
            listOf(
                intent("memory.recall", "memory", bytesFor(60)),
                intent("knowledge.search", "knowledge", bytesFor(60)),
                intent("people.find", "people", bytesFor(30)),
            )

        val selection = IntentToolProvider.selectWithinBudget(intents, 100)

        assertEquals(listOf("knowledge.search", "people.find"), selection.kept.map { it.name })
        assertEquals(listOf("memory.recall"), selection.omitted.map { it.name })
        assertTrue("spent ${selection.keptTokens}", selection.keptTokens in 85..100)
    }

    @Test
    fun the_cost_is_the_declaration_the_model_sees_name_description_and_schema_together() {
        val one = intent("people.find", "people", 400)
        val expected = LocalLlmPolicy.estimateDeclarationTokens(IntentTool.declaration(one).toByteArray(Charsets.UTF_8).size)

        val selection = IntentToolProvider.selectWithinBudget(listOf(one), Int.MAX_VALUE)

        assertEquals(expected, selection.keptTokens)
        // The declaration budget and this estimate agree with each other, byte for byte.
        assertTrue(expected > 400 / LocalLlmPolicy.TOOL_DECLARATION_BYTES_PER_TOKEN)
    }

    @Test
    fun a_zero_budget_binds_nothing_and_names_everything_it_left_out() {
        val intents = listOf(intent("knowledge.search", "knowledge", 100), intent("people.find", "people", 100))

        val selection = IntentToolProvider.selectWithinBudget(intents, 0)

        assertTrue(selection.kept.isEmpty())
        assertEquals(listOf("knowledge.search", "people.find"), selection.omitted.map { it.name })
        assertEquals(0, selection.keptTokens)
    }

    @Test
    fun the_device_case_gemma_4s_window_cannot_take_the_published_schemas_but_keeps_the_most_useful_ones() {
        // The sizes the appliance published for its local tier on 2026-10-12, by intent, in bytes.
        val published =
            mapOf(
                "anomalies.recent" to 390, "brief.list" to 496, "calendar.findEvents" to 366, "insights.explain" to 487,
                "knowledge.preferences" to 913, "knowledge.search" to 2_310, "media.entertainmentPreferences" to 758,
                "media.findPhotos" to 935, "memory.recall" to 2_349, "memory.remember" to 1_198, "people.find" to 341,
                "people.relationships" to 649, "places.find" to 353, "places.next" to 436, "planning.createTask" to 1_231,
                "planning.findTasks" to 1_155, "planning.plannedBlocks" to 540, "planning.scheduleTask" to 1_080,
                "planning.updateTask" to 1_573, "suggestions.feedback" to 368, "suggestions.list" to 204,
            )
        val intents = published.map { (name, bytes) -> intent(name, name.substringBefore('.'), bytes) }

        val selection = IntentToolProvider.selectWithinBudget(intents, LocalLlmPolicy.toolDeclarationTokenBudget(4000))

        assertTrue("something was left out: ${selection.omitted.size}", selection.omitted.isNotEmpty())
        assertEquals("the two the offline surface exists for lead", listOf("knowledge.search", "memory.recall"), selection.kept.take(2).map { it.name })
        assertTrue(selection.keptTokens <= LocalLlmPolicy.toolDeclarationTokenBudget(4000))

        // These are the FULL schemas, ~18 KB: even an 8k window cannot take all of them, which is why the
        // appliance publishes leaner ones for the local tier (IntentDefinition.local). A 16k window could.
        val roomier = IntentToolProvider.selectWithinBudget(intents, LocalLlmPolicy.toolDeclarationTokenBudget(8192))
        assertTrue(roomier.kept.size > selection.kept.size)
        assertEquals(21, IntentToolProvider.selectWithinBudget(intents, LocalLlmPolicy.toolDeclarationTokenBudget(16_384)).kept.size)
    }

    /** An intent whose declaration is about [declarationBytes] long: the schema carries the padding. */
    private fun intent(name: String, domain: String, declarationBytes: Int): ManifestIntent {
        val fixed = IntentTool.declaration(ManifestIntent(name, name.replace('.', '_'), "", "", JSONObject().put("type", "object"), null, domain)).length
        val pad = (declarationBytes - fixed).coerceAtLeast(0)
        val parameters = JSONObject().put("type", "object").put("description", "x".repeat(pad))
        return ManifestIntent(
            name = name,
            tool = name.replace('.', '_'),
            title = "",
            description = "",
            parameters = parameters,
            dispatch = DispatchRuling("execute", "allowed", "ok"),
            domain = domain,
        )
    }

    private fun bytesFor(tokens: Int): Int = tokens * LocalLlmPolicy.TOOL_DECLARATION_BYTES_PER_TOKEN
}
