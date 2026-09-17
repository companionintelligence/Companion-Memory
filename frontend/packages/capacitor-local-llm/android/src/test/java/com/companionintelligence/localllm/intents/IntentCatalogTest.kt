package com.companionintelligence.localllm.intents

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * Robolectric rather than plain JUnit purely for `org.json`: AGP's mockable `android.jar` stubs
 * `JSONObject` to throw on every call, whereas Robolectric supplies the same AOSP implementation
 * that runs on the device — including its particular habits, like `optString` returning `""`
 * rather than null, which this parser deliberately relies on.
 */
@RunWith(RobolectricTestRunner::class)
class IntentCatalogTest {

    @Test
    fun an_intent_with_no_dispatch_ruling_is_not_offered_to_the_model() {
        val manifest =
            IntentManifest.parse(
                JSONObject(
                    """
                    {
                      "version": "1.2.0",
                      "tier": "local",
                      "intents": [
                        {"name": "memory.recall", "dispatch": {"decision": "execute", "reason": "read-only", "explanation": "ok"}},
                        {"name": "calendar.create", "dispatch": {"decision": "queue", "reason": "writes", "explanation": "Confirm on the appliance."}},
                        {"name": "email.send", "dispatch": {"decision": "deny", "reason": "third-party", "explanation": "Not from this device."}},
                        {"name": "legacy.purge"}
                      ]
                    }
                    """.trimIndent(),
                ),
            )

        // All four are parsed — the filter is a policy decision, not a parse failure, and the
        // caller logs "N of M" using both numbers.
        assertEquals(4, manifest.intents.size)

        // Fail closed. `legacy.purge` has no ruling because the appliance predates tier-aware
        // manifests; treating "unknown" as "allowed" would hand a destructive intent to a model
        // on a device with no confirmation UI.
        assertEquals(listOf("memory.recall"), manifest.executable().map { it.name })

        assertNull(manifest.intents[3].dispatch)
        assertTrue(manifest.intents[0].dispatch!!.isExecutable)
        assertFalse(manifest.intents[1].dispatch!!.isExecutable)
        assertFalse(manifest.intents[2].dispatch!!.isExecutable)
        assertEquals("Confirm on the appliance.", manifest.intents[1].dispatch!!.explanation)
    }

    @Test
    fun a_tool_name_is_derived_from_the_dotted_id_and_unusable_entries_are_dropped() {
        val manifest =
            IntentManifest.parse(
                JSONObject(
                    """
                    {
                      "intents": [
                        {"name": "memory.recall"},
                        {"name": "person.contact.find", "tool": "find_a_person"},
                        {"tool": "orphan_without_a_name"},
                        {"name": ""},
                        "not an object at all"
                      ]
                    }
                    """.trimIndent(),
                ),
            )

        // MCP `tools/call` addresses tools by an underscored name; a dotted one 404s at runtime
        // with nothing to catch it at compile time.
        assertEquals(listOf("memory_recall", "find_a_person"), manifest.intents.map { it.tool })
        assertEquals(listOf("memory.recall", "person.contact.find"), manifest.intents.map { it.name })

        // A nameless entry would otherwise become a tool the model can see but never call.
        assertEquals(2, manifest.intents.size)
    }

    @Test
    fun a_manifest_from_an_appliance_that_ignored_the_tier_query_reports_a_null_tier() {
        // IntentToolProvider keys its "upgrade CI-Server to 1.2.0+" diagnostic on exactly this.
        // org.json hands back "" for a missing key, so without normalisation the caller would
        // take the "the server answered, it just has nothing to offer" branch instead and send
        // the next reader after a server-side problem that does not exist.
        assertNull(IntentManifest.parse(JSONObject("""{"version": "1.1.0", "intents": []}""")).tier)
        assertEquals("local", IntentManifest.parse(JSONObject("""{"tier": "local", "intents": []}""")).tier)
    }

    @Test
    fun an_intent_with_no_argument_schema_gets_an_empty_object_rather_than_null() {
        val intent =
            IntentManifest.parse(
                JSONObject("""{"intents": [{"name": "memory.recall", "dispatch": {"decision": "execute"}}]}"""),
            ).intents.single()

        // The schema is handed straight to OpenApiTool's `parameters`; a null there would be
        // serialised as the JSON literal `null` and confuse the model's tool grammar.
        assertEquals(0, intent.parameters.length())
        assertEquals("", intent.title)
        assertTrue(intent.dispatch!!.isExecutable)
    }

    @Test
    fun a_manifest_with_no_intents_array_parses_to_an_empty_catalogue() {
        val manifest = IntentManifest.parse(JSONObject("""{"version": "1.2.0", "tier": "local"}"""))

        assertEquals(emptyList<ManifestIntent>(), manifest.intents)
        assertEquals(emptyList<ManifestIntent>(), manifest.executable())
        assertEquals("1.2.0", manifest.version)
    }
}
