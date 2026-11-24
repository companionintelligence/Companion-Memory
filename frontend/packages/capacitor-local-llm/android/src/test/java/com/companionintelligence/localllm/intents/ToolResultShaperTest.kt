package com.companionintelligence.localllm.intents

import com.companionintelligence.localllm.intents.ToolResultFixtures.pretty
import com.companionintelligence.localllm.intents.ToolResultFixtures.quote
import com.companionintelligence.localllm.intents.ToolResultFixtures.searchResult
import com.companionintelligence.localllm.intents.ToolResultFixtures.utf8
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * [ToolResultShaper] against the cases iOS's pure Swift tests (`tests/local-llm-pure/main.swift`) check — same
 * fixtures, same budgets, same expectations — then the rules those cases do not reach one at a time, then what only
 * this port can get wrong: reading and writing JSON without `org.json`, UTF-16 strings that have to be budgeted in
 * UTF-8 bytes, and numbers written the way Swift writes them. [SwiftParityTest] compares the two platforms'
 * answers over several hundred more inputs; [ToolResultShaperInvariantsTest] holds what must be true of every one.
 *
 * The realistic cases read `src/test/resources/synthetic-tool-results`: what `knowledge_search` and `memory_recall`
 * answer for a made-up person's notes, messages, photos, calendar and contacts, in the real shape of a hit. They
 * were written out by the bench corpus (`frontend/apps/ios/tests/local-llm-device/Sources/Fixtures.swift`). Nothing
 * in them is real. Their photo hits carry two `type` keys, `photo` and then `content`, because the bench builds them
 * that way (the appliance would send one); both platforms keep the first, as `JSONSerialization` does.
 *
 * Robolectric supplies the real `org.json` that the outputs are read back with. It is lenient, so every output is
 * also checked by [StrictJsonCheck] first.
 */
@RunWith(RobolectricTestRunner::class)
class ToolResultShaperTest {
    private val marker = ToolResultShaper.TRUNCATION_MARKER
    private val smile = "😀"
    private val uuid = "0199aaaa-bbbb-7ccc-9ddd-eeeeeeeeeeee"

    /**
     * [ToolResultShaper.shape], after checking that there is something to shape. A result that already fits is
     * returned as it is, so a case whose input is under its budget proves nothing; that has gone unnoticed before.
     */
    private fun shape(text: String, budget: Int): String {
        assertTrue(
            "the input (${utf8(text)} bytes) is not over the budget ($budget): this case would shape nothing",
            utf8(text) > maxOf(budget, ToolResultShaper.MINIMUM_BUDGET_BYTES),
        )

        return ToolResultShaper.shape(text, budget)
    }

    @Test
    fun `an instant under a time key is written as its date and minute, which a small model can copy`() {
        // Seen on a device: Gemma 4 E2B wrote "20202-1-128T06:5:59.00Z" for 2022-11-28T06:45:59.000Z.
        val raw = pretty(
            mapOf(
                "summary" to "Showing the top 6 of 6 matches.",
                "items" to (0 until 6).map {
                    mapOf("type" to "communication", "link" to "/communications/c$it", "title" to "Subject $it", "time" to "2022-11-28T06:45:59.000Z", "content" to "x".repeat(400))
                },
            ),
        )

        val shaped = shape(raw, 700)

        assertTrue(shaped, shaped.contains("\"time\":\"2022-11-28 06:45 UTC\""))
        assertFalse(shaped, shaped.contains("2022-11-28T06:45"))
    }

    @Test
    fun `time rendering keeps a date, an offset and a non-time string as they are`() {
        val raw = pretty(
            mapOf(
                "summary" to "Showing the top 6 of 6 matches.",
                "items" to (0 until 6).map {
                    mapOf(
                        "type" to "event", "link" to "/events/e$it", "title" to "Title $it", "content" to "y".repeat(400),
                        "startTime" to "2025-10-09T21:30:00+02:00", "endTime" to "2025-10-09T22:30:00Z", "birthDate" to "1980-01-01", "date" to "next Tuesday",
                    )
                },
            ),
        )

        val shaped = shape(raw, 900)

        assertTrue(shaped, shaped.contains("\"startTime\":\"2025-10-09 21:30 +02:00\""))
        assertTrue(shaped, shaped.contains("\"endTime\":\"2025-10-09 22:30 UTC\""))
        assertTrue(shaped, shaped.contains("\"birthDate\":\"1980-01-01\""))
        assertTrue(shaped, shaped.contains("\"date\":\"next Tuesday\""))
    }

    /** The keys of the top-level object in the order they are written: a `JSONObject` does not promise one. */
    private fun orderOf(text: String): List<String> = checkNotNull(StrictJsonCheck.topLevelKeys(text)) { "not a JSON object: ${text.take(80)}" }

    private fun resource(name: String): String =
        checkNotNull(javaClass.classLoader?.getResourceAsStream("synthetic-tool-results/$name")) { "no test resource $name" }
            .use { String(it.readBytes(), Charsets.UTF_8) }

    private fun heron(): String = resource("knowledge-search-heron.json")

    private fun dentist(): String = resource("knowledge-search-dentist.json")

    private fun graph(): String = resource("memory-recall-maria.json")

    /**
     * [text] as the one JSON value both a strict reader and org.json make of it. org.json is lenient — its own
     * documentation says a successful parse "does not indicate that the input string was valid JSON" — so the strict
     * check comes first.
     */
    private fun parse(text: String): Any {
        assertNull("not strict JSON: ${text.take(100)}", StrictJsonCheck.problem(text))

        val tokener = JSONTokener(text)
        val value = tokener.nextValue()

        assertEquals("text after the JSON value: ${text.takeLast(40)}", '\u0000', tokener.nextClean())

        return value
    }

    private fun parseOrNull(text: String): Any? = if (StrictJsonCheck.isValid(text)) parse(text) else null

    private fun parseObject(text: String): JSONObject {
        val value = parse(text)

        assertTrue("output parses as a JSON object: ${text.take(160)}", value is JSONObject)

        return value as JSONObject
    }

    private fun parseArray(text: String): JSONArray {
        val value = parse(text)

        assertTrue("output parses as a JSON array: ${text.take(160)}", value is JSONArray)

        return value as JSONArray
    }

    private fun keysOf(obj: JSONObject): List<String> = obj.keys().asSequence().toList()

    private fun elementsOf(array: JSONArray): List<Any?> = (0 until array.length()).map { array.get(it).takeUnless { element -> element === JSONObject.NULL } }

    private fun assertWithin(budget: Int, shaped: String) {
        val limit = maxOf(budget, ToolResultShaper.MINIMUM_BUDGET_BYTES)

        assertTrue("within the budget (${utf8(shaped)} of $limit bytes)", utf8(shaped) <= limit)
    }

    /** What survives a trip through UTF-8: a lone surrogate comes back as `?`, a character cut in half as U+FFFD. */
    private fun assertWholeCharacters(text: String) {
        assertEquals("no character cut in half", text, String(text.toByteArray(Charsets.UTF_8), Charsets.UTF_8))
        assertFalse("no replacement character", text.contains('\uFFFD'))
    }

    /** The hits of a shaped search envelope, whatever closes its list, and the rest of what is in the object. */
    private class Envelope(val hits: List<JSONObject>, val note: String?, val header: JSONObject)

    private fun shapedItems(shaped: String): Envelope? {
        val obj = parseOrNull(shaped) as? JSONObject ?: return null
        val items = obj.optJSONArray("items") ?: return null
        val header = JSONObject(obj.toString())

        header.remove("items")

        return Envelope((0 until items.length()).mapNotNull { items.optJSONObject(it) }, items.opt(items.length() - 1) as? String, header)
    }

    private fun omittedBy(note: String?): Int = note?.drop(1)?.takeWhile { it.isDigit() }?.toIntOrNull() ?: 0

    // ---- a result that fits -----------------------------------------------------------------------

    @Test
    fun a_result_that_already_fits_is_passed_on_untouched() {
        val small = "{\n  \"error\": \"Companion is not connected\"\n}"

        // Byte-identical, whitespace and all.
        assertEquals(small, ToolResultShaper.shape(small, 512))
        assertEquals("", ToolResultShaper.shape("", 512))
    }

    @Test
    fun a_result_exactly_the_size_of_the_budget_fits_and_one_byte_more_does_not() {
        val atBudget = "{\n  \"summary\": \"" + "x".repeat(512 - 19) + "\"\n}"
        assertEquals(512, utf8(atBudget))
        assertEquals(atBudget, ToolResultShaper.shape(atBudget, 512))

        val over = atBudget + " "
        assertEquals(513, utf8(over))
        assertNotEquals(over, shape(over, 512))
        assertWithin(512, shape(over, 512))
    }

    // ---- the appliance's search result ---------------------------------------------------------------

    @Test
    fun a_25_hit_knowledge_search_result_is_cut_to_the_budget_and_stays_valid_informative_json() {
        val raw = searchResult(items = 25)
        val budget = 1024

        assertTrue("the fixture is as big as the real thing (${utf8(raw)} bytes)", utf8(raw) > 20_000)

        val shaped = shape(raw, budget)

        assertWithin(budget, shaped)
        assertTrue("...but not emptied (${utf8(shaped)} bytes)", utf8(shaped) > 200)
        assertFalse("compact: pretty-printing whitespace is gone", shaped.contains('\n'))
        assertTrue("the summary leads: ${shaped.take(80)}", shaped.startsWith("{\"summary\":\"Showing the top 25 of at least 25 matches.\","))

        val envelope = checkNotNull(shapedItems(shaped)) { "output parses as a JSON object with items: $shaped" }

        assertEquals("header kept: truncated", true, envelope.header.getBoolean("truncated"))
        assertEquals("header kept: limit", 25, envelope.header.getInt("limit"))
        assertEquals("header kept: mode", "hybrid", envelope.header.getString("mode"))
        assertFalse("an unset header field (totalMatches: null) is not sent", envelope.header.has("totalMatches"))
        assertTrue("several hits survive, not one (${envelope.hits.size})", envelope.hits.size >= 2)
        assertTrue("closing note: ${envelope.note}", envelope.note?.endsWith("more results omitted — refine the query to narrow them down]") == true)
        assertEquals("the note counts exactly the hits that were left out", 25, envelope.hits.size + omittedBy(envelope.note))
    }

    @Test
    fun a_hit_stays_a_hit_no_json_inside_a_string_however_little_of_it_fits() {
        for (budget in listOf(128, 256, 512, 1024)) {
            val shaped = shape(searchResult(items = 25), budget)

            assertWithin(budget, shaped)
            assertFalse("nothing is escaped twice over at $budget: ${shaped.take(120)}", shaped.contains("\\\""))

            val obj = parseOrNull(shaped) as? JSONObject

            if (obj == null) {
                // Below what a header and a hit can share, the cut is plain text that says so.
                assertTrue("a cut that is not JSON says so at $budget", shaped.endsWith(marker))

                continue
            }

            val items = obj.optJSONArray("items")

            if (items != null) {
                assertTrue("every kept hit is an object at $budget, none a string", (0 until items.length() - 1).all { items.get(it) is JSONObject })
            }
        }
    }

    @Test
    fun a_roomier_budget_keeps_whole_hits_link_whole_and_counts_the_ones_it_dropped() {
        val shaped = shape(searchResult(items = 25, contentLength = 200), 4096)

        assertWithin(4096, shaped)

        val envelope = checkNotNull(shapedItems(shaped)) { "output parses: ${shaped.take(120)}" }

        assertTrue("many hits survive (${envelope.hits.size})", envelope.hits.size >= 5)
        assertEquals("the note counts exactly the dropped hits", 25 - envelope.hits.size, omittedBy(envelope.note))
        assertEquals("best hit first, link whole, and its slashes are not escaped", "/communications/0198a3f2-7c1e-7b3a-9d41-000000000000", envelope.hits.first().getString("link"))
        assertFalse("the id is dropped when the link already carries it", envelope.hits.first().has("id"))
        assertFalse("no escaped slashes eating the budget", shaped.contains("\\/"))
    }

    @Test
    fun one_oversized_hit_is_shortened_not_turned_into_a_string_and_the_result_still_fits_and_parses() {
        val shaped = shape(searchResult(items = 1, contentLength = 20_000), 512)

        assertWithin(512, shaped)

        val envelope = checkNotNull(shapedItems(shaped)) { "output parses with a hit: $shaped" }
        val hit = envelope.hits.single()

        assertNull("nothing was dropped, so there is no omission note", envelope.note)
        assertEquals("type survives", "communication", hit.getString("type"))
        assertEquals("link survives whole", "/communications/0198a3f2-7c1e-7b3a-9d41-000000000000", hit.getString("link"))
        assertEquals("the title survives", "Zephyr marmalade note 0", hit.getString("title"))

        val content = hit.optString("content")

        assertTrue("the long content is what was shortened (${content.length} characters)", content.endsWith("…") && content.length < 400)
    }

    @Test
    fun what_identifies_a_hit_is_written_first_then_when_then_what_it_says_bookkeeping_last() {
        val raw = pretty(mapOf("content" to "lorem ipsum ".repeat(100), "id" to "abc", "title" to "Short title", "type" to "note", "createdAt" to "2025-03-08T18:04:00.000Z", "sourceSystem" to "takeout", "tags" to listOf("a")))
        val shaped = shape(raw, 700)

        assertWithin(700, shaped)

        // Bookkeeping goes last, shortest value first among itself: `id` ("abc") before `sourceSystem`.
        var cursor = 0

        for (key in listOf("type", "title", "createdAt", "content", "tags", "id", "sourceSystem")) {
            val found = shaped.indexOf("\"$key\":", cursor)

            assertTrue("$key is written, in order: ${shaped.take(200)}", found >= 0)

            cursor = found + key.length
        }
    }

    @Test
    fun a_hit_that_has_to_lose_members_loses_its_bookkeeping_before_the_date() {
        val raw =
            pretty(
                mapOf(
                    "type" to "event", "link" to "/events/e1", "title" to "Dentist: Dr. Nair", "startTime" to "2025-10-09T21:30:00.000Z", "endTime" to "2025-10-09T22:30:00.000Z",
                    "sourceId" to "evt_" + "x".repeat(40), "sourceSystem" to "google_calendar", "sentimentScore" to 0.4, "importanceScore" to 0.3, "confidenceScore" to 1,
                    "metadata" to mapOf("htmlLink" to "https://calendar.example.com/event?eid=" + "q".repeat(60)),
                    "locationName" to "Fremont Smile Dental, Fremont", "category" to "health",
                ),
            )
        val shaped = shape(raw, 230)

        assertWithin(230, shaped)
        assertTrue("the start time survives: $shaped", shaped.contains("\"startTime\":\"2025-10-09 21:30 UTC\""))
        assertTrue("so does the title", shaped.contains("\"title\":\"Dentist: Dr. Nair\""))
        assertFalse("the bookkeeping is what was dropped", shaped.contains("sourceId"))
    }

    @Test
    fun an_unset_column_costs_nothing_nulls_empties_false_and_foreign_keys_are_not_sent() {
        val raw =
            pretty(
                mapOf(
                    "type" to "communication", "link" to "/communications/$uuid", "id" to uuid, "entityType" to "communication", "subject" to null, "summary" to "",
                    "attachments" to emptyList<Any>(), "metadata" to emptyMap<String, Any>(), "isEncrypted" to false, "isArchived" to false, "threadId" to uuid, "fromEntityId" to uuid,
                    "toEntityIds" to listOf(uuid), "content" to "Did you see the heron? ".repeat(30), "importanceScore" to 0.3, "durationSeconds" to 0, "isRecurring" to true,
                ),
            )
        val hit = parseObject(shape(raw, 600))

        assertEquals("only what means something is left", setOf("type", "link", "content", "importanceScore", "durationSeconds", "isRecurring"), keysOf(hit).toSet())
        assertEquals("0 is a number, not an unset column", 0, hit.get("durationSeconds"))
        assertEquals("true is information", true, hit.get("isRecurring"))
    }

    @Test
    fun a_link_is_only_useful_whole_it_is_never_shortened_whatever_the_string_cap() {
        val link = "/communications/$uuid"

        for (budget in listOf(160, 256, 400)) {
            val shaped = shape(pretty(mapOf("type" to "communication", "link" to link, "title" to "T", "content" to "word ".repeat(400))), budget)

            assertTrue("link whole at $budget: $shaped", shaped.contains("\"link\":\"$link\""))
        }
    }

    // ---- realistic results ----------------------------------------------------------------------------

    @Test
    fun the_first_hits_share_the_room_so_three_different_hits_reach_the_model_not_one_long_one() {
        val shaped = shape(heron(), 1024)

        assertWithin(1024, shaped)

        val envelope = checkNotNull(shapedItems(shaped)) { "parses: ${shaped.take(120)}" }

        assertEquals("three hits share the room", 3, envelope.hits.size)
        assertEquals("in the order the appliance ranked them", listOf("note", "communication", "photo"), envelope.hits.map { it.getString("type") })
        assertTrue("each carries something to read, not only its address", envelope.hits.all { it.has("content") || it.has("text") || it.has("title") })
        assertTrue("the answer's place reaches the model", shaped.contains("Lake Merritt"))
    }

    @Test
    fun where_a_budget_is_too_tight_for_three_readable_hits_fewer_share_it() {
        val shaped = shape(heron(), 512)
        val envelope = checkNotNull(shapedItems(shaped)) { "parses: ${shaped.take(120)}" }

        assertTrue("at most two share 512 bytes (${envelope.hits.size})", envelope.hits.size <= 2)
        assertTrue("and the one that is there says where", shaped.contains("Lake Merritt"))
    }

    @Test
    fun the_dentists_appointment_time_survives_a_tight_budget_on_a_realistic_result() {
        for (budget in listOf(512, 1024)) {
            val shaped = shape(dentist(), budget)

            assertWithin(budget, shaped)
            // Rendered for a small model: the date and the minute, not the 24-character instant it mangles.
            assertTrue("the start time reaches the model at $budget", shaped.contains("2025-10-09 21:30 UTC"))
        }
    }

    @Test
    fun a_realistic_result_is_far_smaller_with_the_unset_columns_gone() {
        val raw = dentist()
        val shaped = shape(raw, 8192)

        assertTrue("the raw result is the size of the real one (${utf8(raw)})", utf8(raw) > 25_000)
        assertWithin(8192, shaped)
        assertTrue("and says who", shaped.contains("Dr. Priya Nair"))
    }

    @Test
    fun a_graph_keeps_a_few_edges_beside_a_few_nodes_what_says_how_people_relate_survives_a_tight_budget() {
        val raw = graph()

        for (budget in listOf(700, 1024, 2048)) {
            val shaped = shape(raw, budget)

            assertWithin(budget, shaped)

            val obj = checkNotNull(parseOrNull(shaped) as? JSONObject) { "a graph is still JSON at $budget: ${shaped.take(120)}" }
            val nodes = elementsOf(obj.optJSONArray("nodes") ?: JSONArray())
            val edges = elementsOf(obj.optJSONArray("edges") ?: JSONArray())

            assertTrue("a node survives at $budget", nodes.any { it is JSONObject })
            assertTrue("and so does an edge at $budget", edges.any { it is JSONObject })
            assertTrue("the person named reaches the model at $budget", shaped.contains("Maria Alvarez"))
        }

        val roomy = shape(raw, 2048)

        assertTrue("a relationship type is in what the model reads", roomy.contains("FRIEND_OF") || roomy.contains("WORKS_AT"))
        assertFalse("the list of seed UUIDs is gone: ids the model cannot use", roomy.contains("\"seedEntityIds\""))
    }

    @Test
    fun json_in_is_json_out_at_every_budget_from_400_bytes_up_on_the_realistic_results() {
        // The closing "N more omitted" element used to be reserved as a share of the budget, which for a small
        // list was less than the element: one hit too many was kept and the final guard cut valid JSON in the
        // middle. Across 300..2048 that made 152, 170 and 199 of the budgets below produce invalid JSON for the
        // heron, dentist and graph fixtures respectively (measured against the pre-fix shaper). The element is
        // held back exactly now ([ToolResultShaper] `bound`/`omissionNote`), and what is left is a budget too
        // small for a header, one hit and the note at all — none of these fixtures needs more than ~340 bytes
        // for that, so 400 is comfortably above it.
        val results = listOf("heron" to heron(), "dentist" to dentist(), "graph" to graph())

        for ((name, raw) in results) {
            val notJson = mutableListOf<Int>()
            val overBudget = mutableListOf<Int>()
            val unmarked = mutableListOf<Int>()

            for (budget in 128..2048) {
                val shaped = ToolResultShaper.shape(raw, budget)

                if (utf8(shaped) > budget) overBudget.add(budget)

                if (parseOrNull(shaped) == null) {
                    if (budget >= 400) notJson.add(budget)
                    if (!shaped.endsWith(marker)) unmarked.add(budget)
                }
            }

            assertTrue("$name: never over the budget: ${overBudget.take(3)}", overBudget.isEmpty())
            assertTrue("$name: valid JSON from 400 bytes up: ${notJson.take(5)}", notJson.isEmpty())
            assertTrue("$name: a cut that is not JSON says so: ${unmarked.take(3)}", unmarked.isEmpty())
        }
    }

    @Test
    fun every_list_in_a_result_is_bounded_not_only_items_and_each_says_how_many_it_left_out() {
        val nodes = (0 until 30).map { mapOf("name" to "Person $it", "type" to "person", "note" to "n".repeat(120)) }
        val edges = (0 until 40).map { mapOf("type" to "KNOWS", "from" to mapOf("name" to "A$it"), "to" to mapOf("name" to "B$it")) }
        val shaped = shape(pretty(mapOf("nodes" to nodes, "edges" to edges, "stats" to mapOf("nodeCount" to 30, "edgeCount" to 40))), 900)

        assertWithin(900, shaped)

        val obj = parseObject(shaped)

        for (key in listOf("nodes", "edges")) {
            val list = elementsOf(obj.getJSONArray(key))

            assertTrue("$key keeps hits", list.any { it is JSONObject })
            assertTrue("$key says it was cut", (list.last() as? String)?.contains("more results omitted") == true)
        }

        assertEquals("the small member is kept whole", 30, obj.getJSONObject("stats").getInt("nodeCount"))
    }

    @Test
    fun an_envelopes_own_header_is_capped_so_a_runaway_summary_cannot_take_the_hits_room() {
        val hits = (0 until 10).map { mapOf("type" to "note", "link" to "/notes/n$it", "title" to "Note $it", "content" to "text $it") }
        val raw = pretty(mapOf("summary" to "very long summary sentence ".repeat(200), "limit" to 25, "items" to hits))
        val shaped = shape(raw, 1024)

        assertWithin(1024, shaped)

        val envelope = checkNotNull(shapedItems(shaped)) { "still a JSON object with hits, not a cut: ${shaped.take(120)}" }

        assertTrue("hits survive a header that was huge", envelope.hits.isNotEmpty())

        val summary = envelope.header.getString("summary")

        assertTrue("the summary is capped and says so (${summary.length} characters)", summary.length <= 201 && summary.endsWith("…"))
    }

    @Test
    fun when_nothing_fits_as_json_the_cut_is_of_the_compact_pruned_text_not_of_what_the_appliance_sent() {
        val raw =
            pretty(
                mapOf(
                    "summary" to "Showing the top 3 of at least 3 matches.", "totalMatches" to null, "limit" to 25,
                    "items" to (0 until 3).map { mapOf("type" to "note", "link" to "/notes/n$it", "title" to "Note $it", "tags" to emptyList<Any>()) },
                ),
            )
        val shaped = shape(raw, 80)

        assertWithin(80, shaped)
        assertTrue("a cut that is not JSON says so: $shaped", shaped.endsWith(marker))
        assertFalse("no pretty-printing whitespace is spent: $shaped", shaped.contains('\n') || shaped.contains("  "))
        assertTrue("it begins with the compact text, summary first: $shaped", shaped.startsWith("{\"summary\":"))
        assertFalse("and without the unset columns", shaped.contains("null"))
    }

    // ---- numbers, arrays, strings ---------------------------------------------------------------------

    @Test
    fun numbers_are_written_the_short_way_and_a_boolean_is_told_from_a_1() {
        val raw = pretty(mapOf("score" to 0.8123, "count" to 1, "flag" to true, "zero" to 0, "off" to false, "none" to null, "pad" to "p".repeat(600)))
        val shaped = shape(raw, 512)

        assertTrue("0.8123 stays 0.8123, not 0.81230000000000002: $shaped", shaped.contains("\"score\":0.8123"))
        assertTrue("an integer stays an integer", shaped.contains("\"count\":1"))
        assertTrue("0 is a number, not false", shaped.contains("\"zero\":0"))
        assertTrue("true stays true", shaped.contains("\"flag\":true"))
        assertFalse("false is an unset column and is not sent", shaped.contains("\"off\""))
        assertFalse("null is an unset column and is not sent", shaped.contains("\"none\""))

        val parsed = parseObject(shaped)

        assertEquals(0.8123, parsed.getDouble("score"), 0.0)
        assertEquals(true, parsed.get("flag"))
        assertEquals(1, parsed.get("count"))
        assertEquals(0, parsed.get("zero"))
    }

    @Test
    fun a_number_is_written_as_swift_writes_it() {
        // Each pair is a literal in the input and what iOS's `ToolResultShaper` wrote for it (Swift's
        // `Double.description` for anything with a fraction or exponent, `Int64`/`UInt64` text for the rest).
        val swift =
            listOf(
                "0" to "0", "1" to "1", "-0" to "0", "-1" to "-1", "100" to "100",
                "1.0" to "1.0", "1.5" to "1.5", "100.0" to "100.0", "-0.0" to "-0.0", "0.0" to "0.0", "0.10" to "0.1", "1.50" to "1.5",
                "0.8123" to "0.8123", "0.81230000000000002" to "0.8123", "0.1" to "0.1", "0.2" to "0.2",
                "0.30000000000000004" to "0.30000000000000004", "3.141592653589793" to "3.141592653589793",
                "123456789.123" to "123456789.123", "99999999999999.99" to "99999999999999.98",
                "1e5" to "100000.0", "1E5" to "100000.0", "1e+5" to "100000.0", "1.0e5" to "100000.0", "0.5e1" to "5.0", "2e0" to "2.0", "1e-0" to "1.0",
                "0.0001" to "0.0001", "1e-4" to "0.0001", "0.001" to "0.001", "1e-3" to "0.001", "0.000123" to "0.000123", "0.0009999" to "0.0009999",
                "0.00001" to "1e-05", "1e-5" to "1e-05", "1.5e-7" to "1.5e-07", "2.5e-5" to "2.5e-05", "12345.6789e-10" to "1.23456789e-06",
                "1e15" to "1000000000000000.0", "1e16" to "1e+16", "1e17" to "1e+17", "1e21" to "1e+21", "1e22" to "1e+22", "123e18" to "1.23e+20",
                "10000000000000000000000.0" to "1e+22", "1e308" to "1e+308", "1.5e300" to "1.5e+300",
                "1.7976931348623157e308" to "1.7976931348623157e+308", "2.2250738585072014e-308" to "2.2250738585072014e-308",
                "1e-999" to "0.0",
                "123456789012345" to "123456789012345", "9007199254740993" to "9007199254740993", "123456789012345678" to "123456789012345678",
                "9223372036854775807" to "9223372036854775807", "-9223372036854775808" to "-9223372036854775808",
                "9223372036854775808" to "9223372036854775808", "18446744073709551615" to "18446744073709551615",
                "18446744073709551616" to "1.8446744073709552e+19", "12345678901234567890123" to "1.2345678901234568e+22",
                "-9223372036854775809" to "-9.223372036854776e+18",
            )

        for ((literal, expected) in swift) {
            val shaped = shape("{\"n\": $literal, \"pad\": \"${"x".repeat(1_300)}\"}", 1_000)

            assertEquals("for $literal", "{\"n\":$expected,\"pad\":\"${"x".repeat(320)}…\"}", shaped)
        }
    }

    @Test
    fun a_top_level_array_is_bounded_the_same_way() {
        val list = (0 until 40).map { mapOf("id" to it, "name" to "person number $it", "notes" to "n".repeat(400)) }
        val shaped = shape(pretty(list), 1024)

        assertWithin(1024, shaped)

        val parsed = parseArray(shaped)

        assertTrue("closing note", parsed.getString(parsed.length() - 1).contains("more results omitted"))
        assertEquals("person number 0", parsed.getJSONObject(0).getString("name"))
    }

    @Test
    fun every_string_is_capped_so_one_long_message_cannot_take_the_budget() {
        val shaped = shape(pretty(mapOf("content" to "word ".repeat(2_000), "id" to "abc")), 2048)

        assertWithin(2048, shaped)

        val parsed = parseObject(shaped)
        val content = parsed.getString("content")

        assertTrue("long string cut and marked", content.endsWith("…"))
        assertEquals("320 characters, and the mark is one more", 321, content.length)
        assertEquals("short string untouched", "abc", parsed.getString("id"))
    }

    @Test
    fun text_that_is_not_json_is_cut_at_the_budget_on_a_character_boundary_and_says_so() {
        val shaped = shape("plain words. ".repeat(400), 300)

        assertWithin(300, shaped)
        assertTrue("ends in the marker", shaped.endsWith(marker))
        assertTrue("keeps the start", shaped.startsWith("plain words. plain words."))
        assertEquals("fills the budget", 300, utf8(shaped))

        val cjk = "記憶の検索結果".repeat(200)
        val cjkShaped = shape(cjk, 301)

        assertWithin(301, cjkShaped)
        assertWholeCharacters(cjkShaped)
        assertTrue(cjk.startsWith(cjkShaped.removeSuffix(marker)))

        // Four bytes a character and a surrogate pair in UTF-16: the cut falls between pairs, never inside one.
        for (budget in 280..300) {
            val emoji = shape(smile.repeat(200), budget)

            assertWithin(budget, emoji)
            assertWholeCharacters(emoji)
            assertEquals(smile.repeat((budget - utf8(marker)) / 4), emoji.removeSuffix(marker))
        }
    }

    @Test
    fun json_a_serializer_cannot_write_back_never_crashes_the_turn() {
        // 1e999 is more than a double holds. JSON has no form for it, so the list cannot be written back, there is no
        // compact text to cut either, and the text itself is cut: shaping must notice that, not throw, and still fit.
        val raw = "{\"items\":[" + "1e999,".repeat(200) + "1]}"
        val shaped = shape(raw, 256)

        assertWithin(256, shaped)
        assertTrue(shaped.endsWith(marker))
        assertTrue(shaped.startsWith("{\"items\":[1e999,"))

        val negative = shape("{\"items\":[" + "-1e999,".repeat(200) + "1]}", 256)

        assertWithin(256, negative)
        assertTrue(negative.endsWith(marker))
    }

    @Test
    fun a_budget_too_small_to_hold_the_markers_is_raised_not_trusted() {
        val shaped = shape("x".repeat(1_000), 3)

        assertTrue("bounded by the floor (${utf8(shaped)})", utf8(shaped) <= ToolResultShaper.MINIMUM_BUDGET_BYTES)
        assertTrue("still says it was cut", shaped.endsWith(marker))

        assertEquals("a negative budget is the floor too", shape("x".repeat(1_000), 64), shape("x".repeat(1_000), -5))
        assertEquals(shape("x".repeat(1_000), 64), shape("x".repeat(1_000), 0))
    }

    // ---- pruning, rule by rule ---------------------------------------------------------------------------

    /** [members] and a long `content`, so that the result is over any budget used here and has to be shaped. */
    private fun shapedKeys(members: Map<String, Any?>, budget: Int = 700): Set<String> = keysOf(parseObject(shape(pretty(members + mapOf("content" to "c".repeat(1200))), budget))).toSet()

    @Test
    fun a_bare_uuid_is_dropped_wherever_it_is_a_value_whatever_its_case_and_written_any_other_way_it_is_kept() {
        val hit =
            mapOf(
                "type" to "note", "title" to "T",
                "threadId" to uuid, "userId" to uuid.uppercase(), "mixed" to "0199AAAA-bbbb-7CCC-9ddd-EEEEeeee0000", "nil" to "00000000-0000-0000-0000-000000000000",
                "braced" to "{$uuid}", "undashed" to uuid.replace("-", ""), "toolong" to uuid + "0", "tooshort" to uuid.dropLast(1), "misplaced" to "0199aaaab-bb-7ccc-9ddd-eeeeeeeeeeee", "nothex" to uuid.dropLast(1) + "g",
            )

        assertEquals(setOf("type", "title", "content", "braced", "undashed", "toolong", "tooshort", "misplaced", "nothex"), shapedKeys(hit))
    }

    /** How deep the containers of a parsed JSON value go (a scalar is 0). */
    private fun depthOf(value: Any?): Int =
        when (value) {
            is JSONArray -> 1 + (0 until value.length()).maxOfOrNull { depthOf(value.get(it)) }.let { it ?: 0 }
            is JSONObject -> 1 + value.keys().asSequence().maxOfOrNull { depthOf(value.get(it)) }.let { it ?: 0 }
            else -> 0
        }

    @Test
    fun a_container_nested_deeper_than_maximum_depth_is_dropped_and_the_shallow_part_is_untouched() {
        assertTrue("real results (a hit with its metadata) are never cut short by the cap", ToolResultShaper.MAXIMUM_DEPTH >= 8)

        // Written as text: building (and freeing) a map this deep is recursive itself.
        fun nest(levels: Int): String {
            val label = "y".repeat(40)
            val leaf = "{\"leaf\":\"the deepest value ${"x".repeat(50)}\"}"

            return "{\"type\":\"note\",\"link\":\"/notes/n\",\"title\":\"deep\",\"nest\":" +
                "{\"label\":\"$label\",\"level\":".repeat(levels) + leaf + "}".repeat(levels) + "}"
        }

        // A document of moderate depth is parsed, and what lies below the cap is dropped.
        val moderate = shape(nest(40), 1500)
        val parsed = parseOrNull(moderate) as? JSONObject

        assertNotNull("a 40-level document comes back as JSON", parsed)
        assertTrue("the deep member survives, trimmed rather than dropped whole", parsed!!.has("nest"))
        assertTrue("no deeper than the cap: ${depthOf(parsed)}", depthOf(parsed) <= ToolResultShaper.MAXIMUM_DEPTH + 1)
        assertEquals("the shallow part is untouched", "deep", parsed.getString("title"))
    }

    @Test
    fun an_id_is_the_address_only_when_nothing_else_is_so_it_goes_beside_a_link_and_stays_beside_anything_that_is_not_one() {
        val base = mapOf("type" to "note", "title" to "T", "content" to "c".repeat(1200))

        // What the hit's keys come to once pruned, for what sits beside the id.
        val cases =
            linkedMapOf(
                "no link" to (mapOf("id" to uuid) to setOf("type", "title", "content", "id")),
                "a link" to (mapOf("id" to uuid, "link" to "/notes/x") to setOf("type", "title", "content", "link")),
                "a link and an id that is not a UUID" to (mapOf("id" to "abc", "link" to "/notes/x") to setOf("type", "title", "content", "link")),
                "an empty link, which goes itself, while the id stays" to (mapOf("id" to uuid, "link" to "") to setOf("type", "title", "content", "id")),
                "a null link" to (mapOf("id" to uuid, "link" to null) to setOf("type", "title", "content", "id")),
                "a link that is a number" to (mapOf("id" to uuid, "link" to 5) to setOf("type", "title", "content", "id", "link")),
                "a link that is itself a UUID" to (mapOf("id" to uuid, "link" to uuid) to setOf("type", "title", "content", "link")),
                "a link and a number for an id" to (mapOf("id" to 12345, "link" to "/notes/12345") to setOf("type", "title", "content", "link")),
                "an id that is a number" to (mapOf("id" to 12345) to setOf("type", "title", "content", "id")),
            )

        for ((name, case) in cases) {
            val (extra, expected) = case

            assertEquals(name, expected, keysOf(parseObject(shape(pretty(base + extra), 700))).toSet())
        }
    }

    @Test
    fun a_uuid_in_an_array_is_dropped_and_what_is_left_keeps_its_order() {
        val shaped =
            parseObject(
                shape(
                    pretty(mapOf("type" to "note", "title" to "T", "content" to "c".repeat(1200), "tags" to listOf(uuid, "work", uuid.uppercase(), "home", "abc"), "ids" to listOf(uuid, uuid), "groups" to listOf(listOf(uuid), listOf(uuid, "x"), listOf(listOf("y", uuid))))),
                    700,
                ),
            )

        assertEquals(listOf("work", "home", "abc"), elementsOf(shaped.getJSONArray("tags")))
        assertFalse("an array of nothing else goes whole", shaped.has("ids"))
        assertEquals("pruned all the way down", "[[\"x\"],[[\"y\"]]]", shaped.getJSONArray("groups").toString())
    }

    @Test
    fun entityType_is_dropped_beside_a_type_and_kept_without_one() {
        val base = mapOf("title" to "T")

        assertEquals(setOf("type", "title", "content"), shapedKeys(base + mapOf("type" to "note", "entityType" to "note")))
        assertEquals(setOf("title", "content", "entityType"), shapedKeys(base + mapOf("entityType" to "note")))
        assertEquals(setOf("type", "title", "content"), shapedKeys(base + mapOf("type" to "photo", "entityType" to "content")))

        // A type that is there but null does not survive pruning itself, so it no longer makes entityType
        // redundant: only the null type goes, and the same for a type that is merely an empty string.
        assertEquals(setOf("title", "content", "entityType"), shapedKeys(base + mapOf("type" to null, "entityType" to "note")))
        assertEquals(setOf("title", "content", "entityType"), shapedKeys(base + mapOf("type" to "", "entityType" to "note")))

        val nested = parseObject(shape(pretty(base + mapOf("type" to "note", "content" to "c".repeat(1200), "owner" to mapOf("entityType" to "person", "name" to "P"))), 700))

        assertEquals("the rule looks at the object it is in: the owner has no type of its own, so its entityType stays", setOf("entityType", "name"), keysOf(nested.getJSONObject("owner")).toSet())
    }

    @Test
    fun what_is_empty_once_pruned_is_an_empty_array_if_it_was_an_array_and_an_empty_object_if_it_was_anything_else() {
        val spaces = " ".repeat(600)
        val expected =
            linkedMapOf(
                "[$spaces]" to "[]",
                "{$spaces}" to "{}",
                "[null, null, null$spaces]" to "[]",
                "[[], {}, [[]], [{}], {\"a\": []}$spaces]" to "[]",
                "{\"a\": null, \"b\": [], \"c\": {}, \"d\": false, \"e\": \"\"$spaces}" to "{}",
                "[\"$uuid\", \"$uuid\", \"$uuid\"]$spaces" to "[]",
                "[\"$uuid\", \"\", null, false, [], {}]$spaces" to "[]",
                "{\"a\": \"$uuid\", \"b\": \"$uuid\", \"id\": null}$spaces" to "{}",
                "\"\"$spaces" to "{}",
                "false$spaces" to "{}",
                "null$spaces" to "{}",
                "0$spaces" to "0",
                "$spaces true" to "true",
                "\"hello\"$spaces" to "\"hello\"",
                "$spaces-12.5e3$spaces" to "-12500.0",
            )

        for ((text, answer) in expected) assertEquals(text.trim(), answer, shape(text, 100))
    }

    @Test
    fun items_that_all_prune_away_leave_an_object_without_them() {
        val spaces = " ".repeat(600)

        assertEquals("{\"summary\":\"S\",\"limit\":25,\"truncated\":true}", shape("{\"summary\": \"S\", \"limit\": 25, \"truncated\": true, \"items\": [{\"a\": null}, {\"b\": []}]}$spaces", 300))
        assertEquals("{\"summary\":\"S\"}", shape("{\"summary\": \"S\", \"items\": [null, null, \"\"]}$spaces", 300))
        assertEquals("{}", shape("{\"summary\": \"\", \"items\": [[], {}, [null]]}$spaces", 300))

        // One survivor is not a list: it is a member, written whole, and nothing says anything was left out.
        assertEquals("{\"summary\":\"S\",\"items\":[{\"type\":\"note\",\"title\":\"T\"}]}", shape("{\"summary\": \"S\", \"items\": [null, {\"title\": \"T\", \"type\": \"note\"}, {}]}$spaces", 300))
    }

    // ---- ranking and shrinking ---------------------------------------------------------------------------

    private val ranked =
        linkedMapOf<String, Any?>(
            "zeta" to "z", "locationName" to "Fremont Smile Dental", "category" to "health", "status" to "confirmed", "tags" to listOf("a"),
            "sourceId" to "evt_0123456789", "id" to "abc", "updatedAt" to "2025-10-01T00:00:00.000Z", "metadata" to mapOf("htmlLink" to "https://example.com/e"),
            "importance" to 0.4, "priority" to 2, "sourceSystem" to "google_calendar", "confidenceScore" to 1, "isActive" to true,
            "notes" to "Bring the insurance card.", "description" to "Cleaning and exam.", "text" to "Dr. Nair", "content" to "Appointment at 2:30 PM.",
            "birthDate" to "1980-01-01", "takenAt" to "2025-10-09T20:00:00.000Z", "createdAt" to "2025-09-25T16:05:00.000Z", "date" to "2025-10-09",
            "dueDate" to "2025-10-09", "time" to "2025-10-09T21:00:00.000Z", "endTime" to "2025-10-09T22:30:00.000Z", "startTime" to "2025-10-09T21:30:00.000Z",
            "subject" to "Your appointment", "name" to "Fremont Smile Dental", "title" to "Dentist: Dr. Priya Nair", "link" to "/events/e1", "type" to "event", "summary" to "One event.",
        )

    /** The order [ranked] is written in: identity, when, what it says, the rest shortest value first, bookkeeping shortest first. `id` goes: there is a link. */
    private val rankedOrder =
        listOf(
            "summary", "type", "link", "title", "name", "subject",
            "startTime", "endTime", "time", "dueDate", "date", "createdAt", "takenAt", "birthDate",
            "content", "text", "description", "notes",
            "zeta", "tags", "category", "status", "locationName",
            "confidenceScore", "priority", "importance", "isActive", "sourceId", "sourceSystem", "updatedAt", "metadata",
        )

    @Test
    fun members_are_written_by_group_identity_then_time_then_body_then_the_rest_shortest_first_then_bookkeeping() {
        val raw = pretty(ranked)

        // The compact text is smaller than what the appliance sent, so every member fits and only the order is in question.
        assertEquals(rankedOrder, orderOf(shape(raw, utf8(raw) - 1)))
    }

    @Test
    fun a_hit_loses_members_from_the_end_of_that_order_never_keeping_fewer_than_three_and_never_the_middle() {
        val raw = pretty(ranked)
        val seen = LinkedHashSet<Int>()

        for (budget in 64 until utf8(raw)) {
            val shaped = shape(raw, budget)

            // Three members of this hit are 57 bytes, so it is JSON at every budget there is.
            val keys = orderOf(shaped)

            assertTrue("at least three members stay ($budget): $keys", keys.size >= 3)
            assertEquals("a prefix of the order at $budget", rankedOrder.take(keys.size), keys)

            seen.add(keys.size)
        }

        assertEquals("every number of members from three to all of them is met on the way", (3..rankedOrder.size).toList(), seen.sorted())
    }

    /** Compact JSON for [value], strings cut to [cap] characters and an ellipsis: written here, not by the shaper, to measure it by. */
    /** The time keys the shaper renders an instant under; `updatedAt` is bookkeeping and is written as it came. */
    private val renderedTimeKeys = setOf("startTime", "endTime", "time", "dueDate", "date", "createdAt", "takenAt", "birthDate")

    /** The shaper's rendering of an ISO instant, for an expected value: `2025-10-09T21:30:00.000Z` → `2025-10-09 21:30 UTC`. */
    private fun renderedInstant(value: String): String {
        val match = Regex("^(\\d{4}-\\d{2}-\\d{2})T(\\d{2}:\\d{2})(?::\\d{2}(?:\\.\\d+)?)?(Z|[+-]\\d{2}:?\\d{2})$").matchEntire(value) ?: return value
        val (date, clock, zone) = match.destructured

        return if (zone == "Z") "$date $clock UTC" else "$date $clock $zone"
    }

    private fun compact(value: Any?, cap: Int = Int.MAX_VALUE): String =
        when (value) {
            null -> "null"
            is String -> quote(if (value.codePointCount(0, value.length) > cap) value.substring(0, value.offsetByCodePoints(0, cap)) + "…" else value)
            is Map<*, *> -> value.entries.joinToString(",", "{", "}") { quote(it.key as String) + ":" + compact(it.value, cap) }
            is List<*> -> value.joinToString(",", "[", "]") { compact(it, cap) }
            else -> value.toString()
        }

    @Test
    fun a_hit_keeps_exactly_the_members_that_fit_and_one_byte_less_loses_the_last_of_them() {
        val raw = pretty(ranked)
        // An id beside a link is not sent, and an instant under a time key is sent rendered (date and minute).
        val sent = (ranked - "id").mapValues { (key, value) -> if (key in renderedTimeKeys && value is String) renderedInstant(value) else value }

        // From four members up to all but one: the whole object was the last of the shortening steps, which cut strings to 24.
        for (count in 4 until rankedOrder.size) {
            val size = utf8(rankedOrder.take(count).joinToString(",", "{", "}") { quote(it) + ":" + compact(sent[it], 24) })

            assertEquals("$count members fit in exactly $size bytes", count, orderOf(shape(raw, size)).size)
            assertEquals("one byte less is one member less", count - 1, orderOf(shape(raw, size - 1)).size)
        }
    }

    @Test
    fun a_hit_over_its_share_steps_its_strings_down_320_200_140_100_70_50_36_24_before_it_drops_a_member() {
        // `{"title":"T","content":"<n characters>…"}` is n + 29 bytes: the longest cap that leaves it within the budget is kept.
        val raw = pretty(mapOf("title" to "T", "content" to "a".repeat(500)))
        val steps = listOf(349 to 320, 348 to 200, 229 to 200, 228 to 140, 169 to 140, 168 to 100, 129 to 100, 128 to 70, 99 to 70, 98 to 50, 79 to 50, 78 to 36, 65 to 36, 64 to 24)

        for ((budget, characters) in steps) {
            val shaped = shape(raw, budget)
            val content = parseObject(shaped).getString("content")

            assertEquals("at $budget", characters + 1, content.length)
            assertTrue(content.endsWith("…"))
        }
    }

    @Test
    fun a_link_is_never_shortened_not_even_by_the_smallest_cap_and_not_when_a_whole_hit_is_cut_to_a_few_members() {
        for (length in listOf(60, 250, 900)) {
            val link = "/communications/" + "L".repeat(length)
            val hit = mapOf("type" to "communication", "link" to link, "title" to "T".repeat(100), "content" to "c".repeat(3000))

            for (budget in 120..700 step 4) {
                val alone = shape(pretty(hit), budget)
                val beside = shape(pretty(mapOf("summary" to "S", "items" to listOf(hit, hit + mapOf("title" to "2"), hit + mapOf("title" to "3")))), budget + 600)

                for (shaped in listOf(alone, beside)) {
                    if (parseOrNull(shaped) == null) continue

                    // Whichever hit is kept, if it has a link it has the whole link.
                    for (match in Regex("\"link\":\"(.*?)\"").findAll(shaped)) assertEquals("at $budget", link, match.groupValues[1])
                }
            }
        }
    }

    @Test
    fun the_header_of_an_object_with_lists_has_its_strings_capped_at_200_but_never_its_link() {
        val header = mapOf("summary" to "S".repeat(250), "note" to "n".repeat(250), "link" to "/l/" + "k".repeat(250), "tags" to listOf("t".repeat(250)))
        val items = (0 until 3).map { mapOf("type" to "note", "title" to "T$it", "content" to "word ".repeat(120)) }
        val obj = parseObject(shape(pretty(header + mapOf("items" to items)), 2600))

        assertEquals("S".repeat(200) + "…", obj.getString("summary"))
        assertEquals("n".repeat(200) + "…", obj.getString("note"))
        assertEquals("/l/" + "k".repeat(250), obj.getString("link"))
        assertEquals(listOf("t".repeat(200) + "…"), elementsOf(obj.getJSONArray("tags")))

        val hits = obj.getJSONArray("items")

        assertEquals("all three hits fit", 3, hits.length())
        assertEquals("a hit is held to the cap of its share, 320 characters, not the header's 200", 321, hits.getJSONObject(0).getString("content").length)
    }

    // ---- objects that carry lists ---------------------------------------------------------------------------

    private fun tiny(i: Int) = mapOf("type" to "note", "link" to "/notes/n$i", "title" to "T$i")

    @Test
    fun a_member_that_is_an_array_of_one_element_is_not_a_list_and_two_elements_are() {
        val one = shape(pretty(mapOf("summary" to "S", "items" to listOf(tiny(0)), "note" to "n".repeat(700))), 300)
        val two = shape(pretty(mapOf("summary" to "S", "items" to listOf(tiny(0), tiny(1)), "note" to "n".repeat(700))), 700)

        assertEquals("one element stays a member, in the order members are ranked", listOf("summary", "items", "note"), orderOf(one))
        assertEquals(1, parseObject(one).getJSONArray("items").length())
        assertEquals("a list is written after the members that are not lists", listOf("summary", "note", "items"), orderOf(two))
        assertEquals("and both of its hits are there, none said to be left out", 2, parseObject(two).getJSONArray("items").length())
    }

    @Test
    fun lists_are_written_items_first_then_in_the_order_members_are_ranked_then_by_name() {
        // Four small objects each, so that each array qualifies as a list (one holding only scalars is a plain
        // member instead, per isList) and so that six of these lists are over the budget below and each keeps a couple.
        fun listOf4(prefix: String) = (0 until 4).map { mapOf("v" to "$prefix$it" + "x".repeat(148)) }

        // `items` first, whatever its name sorts as; the rest the way `members` ranks them: identity, when, what it says, the unknown, bookkeeping.
        val ranked = mapOf("metadata" to listOf4("m"), "description" to listOf4("d"), "title" to listOf4("t"), "zeta" to listOf4("z"), "startTime" to listOf4("s"), "items" to listOf4("i"))

        assertEquals(listOf("items", "title", "startTime", "description", "zeta", "metadata"), orderOf(shape(pretty(ranked), 3000)))

        // Equal ranks go by name, in the order of the characters and not of the way a platform happens to sort a String.
        val named = mapOf("zeta" to listOf4("z"), "alpha" to listOf4("a"), "Alpha" to listOf4("A"), "beta" to listOf4("b"), "éclair" to listOf4("e"))

        assertEquals(listOf("Alpha", "alpha", "beta", "zeta", "éclair"), orderOf(shape(pretty(named), 3000)))

        // They are compared as the characters they stand for: an e with a combining accent is an é, which sorts after f.
        val decomposed = "e" + 0x301.toChar()

        assertEquals(listOf("f", decomposed), orderOf(shape(pretty(mapOf(decomposed to listOf4("e"), "f" to listOf4("f"))), 1000)))
    }

    @Test
    fun an_object_that_is_only_lists_has_no_header_and_each_list_gets_an_equal_share_of_what_there_is() {
        val shaped = shape(pretty(mapOf("a" to (0 until 12).map { mapOf("title" to "A$it", "content" to "x".repeat(200)) }, "b" to (0 until 12).map { mapOf("title" to "B$it", "content" to "y".repeat(200)) })), 1000)
        val obj = parseObject(shaped)

        assertTrue("it starts with the first list: ${shaped.take(40)}", shaped.startsWith("{\"a\":["))
        assertWithin(1000, shaped)

        val a = elementsOf(obj.getJSONArray("a"))
        val b = elementsOf(obj.getJSONArray("b"))

        assertTrue("both lists keep hits (${a.size}, ${b.size})", a.count { it is JSONObject } >= 1 && b.count { it is JSONObject } >= 1)
        assertTrue("the second list has about the room the first had, not what it left over (${utf8(JSONArray(a).toString())} and ${utf8(JSONArray(b).toString())})", utf8(JSONArray(b).toString()) > utf8(JSONArray(a).toString()) / 2)
    }

    @Test
    fun an_array_of_plain_values_is_one_member_of_an_object_not_a_list_the_object_still_loses_members() {
        // A single entity with tags: ["a","b"] used to count as a list carrier, so its other members were written
        // whole and the result was cut mid-JSON at every budget from 100 to 700.
        val entity = LinkedHashMap<String, Any?>()

        entity["type"] = "person"
        entity["link"] = "/people/maria"
        entity["name"] = "Maria Alvarez"
        entity["tags"] = listOf("friend", "baker")

        for (n in 0 until 28) entity["attribute$n"] = "value number $n " + "x".repeat(30)

        val raw = pretty(entity)
        val failures = mutableListOf<Int>()

        for (budget in 200..700) {
            val shaped = shape(raw, budget)

            if (utf8(shaped) > budget || parseOrNull(shaped) !is JSONObject) failures.add(budget)
        }

        assertTrue("valid JSON object within the budget at every budget from 200 to 700: ${failures.take(5)}", failures.isEmpty())

        val tight = parseObject(shape(raw, 300))

        assertEquals("what the entity is called survives", "Maria Alvarez", tight.getString("name"))
        assertEquals("and where it lives", "/people/maria", tight.getString("link"))
    }

    @Test
    fun a_list_that_loses_hits_closes_with_a_note_sized_exactly_for_what_it_ends_up_carrying() {
        fun tinyHit(i: Int) = mapOf("type" to "x", "title" to "T$i")

        val raw = pretty(List(40) { tinyHit(it) })

        for (budget in listOf(120, 180, 240, 300, 600, 1000, 1500)) {
            val shaped = shape(raw, budget)

            assertWithin(budget, shaped)

            val parsed = parseOrNull(shaped) as? JSONArray

            if (parsed == null) {
                // Only when not even a header-less single hit and a note fit together: still a cut that says so.
                assertTrue("a cut that is not JSON says so at $budget: ${shaped.take(80)}", shaped.endsWith(marker))

                continue
            }

            val elements = elementsOf(parsed)
            val hits = elements.filterIsInstance<JSONObject>()
            val note = elements.lastOrNull() as? String

            assertEquals("the hits are the leading ones, in order", (0 until hits.size).map { "T$it" }, hits.map { it.getString("title") })

            if (hits.size == 40) {
                assertNull("every hit fits, so there is no closing note to make room for ($budget)", note)
            } else {
                assertNotNull("some are left out, so the list says so ($budget)", note)
                assertEquals("the note counts exactly the hits left out, not a number guessed ahead of time", 40 - hits.size, omittedBy(note))
            }
        }
    }

    // ---- when nothing fits ----------------------------------------------------------------------------------------

    @Test
    fun an_object_that_has_to_lose_most_of_its_members_is_still_json_and_keeps_the_first_ones_in_order() {
        val flat = "{" + (0 until 300).joinToString(",") { "\"key${it.toString().padStart(4, '0')}\": $it" } + "}"
        val shaped = shape(flat, 400)

        assertWithin(400, shaped)

        val keys = orderOf(shaped)

        assertTrue("some of it is kept (${keys.size})", keys.size in 10..299)
        assertEquals("from the start, shortest value first", (0 until keys.size).map { "key${it.toString().padStart(4, '0')}" }, keys)
    }

    @Test
    fun an_object_of_tens_of_thousands_of_members_is_shaped_in_linear_time() {
        // Dropping members one at a time and measuring what is left each time is quadratic: 20,000 members took
        // a minute. Linear is a fraction of a second, so the bound has room for a slow machine.
        val text = "{" + (0 until 30_000).joinToString(",") { "\"k$it\":$it" } + "}"
        val started = System.nanoTime()
        val shaped = shape(text, 512)
        val seconds = (System.nanoTime() - started) / 1e9

        assertWithin(512, shaped)
        assertTrue("some of it is kept", orderOf(shaped).size > 20)
        assertTrue("took $seconds s: members must not be dropped by rebuilding the object once for each", seconds < 30)
    }

    @Test
    fun when_not_even_three_members_fit_what_is_cut_is_the_pruned_compact_text_not_the_pretty_one_the_appliance_sent() {
        val raw = pretty(mapOf("a" to "x".repeat(5000), "b" to "y".repeat(5000), "c" to "z".repeat(5000), "gone" to null, "alsoGone" to emptyList<Any>()))
        val shaped = shape(raw, 100)

        assertEquals(100, utf8(shaped))
        assertTrue(shaped.endsWith(marker))
        assertTrue("compact, and without the unset columns: ${shaped.take(40)}", shaped.startsWith("{\"a\":\"xxxx"))
        assertFalse("no whitespace but what is in the strings", shaped.contains('\n') || shaped.contains("  "))
        assertFalse(shaped.contains("gone"))
    }

    @Test
    fun and_when_there_is_no_compact_text_to_write_the_text_itself_is_cut() {
        // -1e999 has no JSON form, so nothing can be written back and the pruned text does not exist either.
        val raw = "{\n  \"a\": \"" + "x".repeat(5000) + "\",\n  \"n\": -1e999\n}"
        val shaped = shape(raw, 100)

        assertEquals(100, utf8(shaped))
        assertTrue(shaped.endsWith(marker))
        assertTrue("the start of the text as it was sent: ${shaped.take(40)}", shaped.startsWith("{\n  \"a\": \"xxxx"))
    }

    @Test
    fun a_header_larger_than_the_whole_budget_is_cut_as_compact_text_and_still_fits() {
        // 60 keys of 50 characters: too short for the string cap to touch, far too many for 800 bytes.
        val header = (0 until 60).joinToString(",") { "\"k${it.toString().padStart(3, '0')}\": \"${"v".repeat(50)}\"" }
        val shaped = shape("{$header, \"items\": [{\"id\": 1}, {\"id\": 2}]}", 800)

        assertEquals(800, utf8(shaped))
        assertTrue(shaped.endsWith(marker))
        assertTrue("compact: ${shaped.take(40)}", shaped.startsWith("{\"") && !shaped.contains('\n'))
    }

    // ---- reading JSON strictly: what this port does that iOS gets from JSONSerialization -------------------------------

    @Test
    fun text_that_org_json_would_take_for_json_is_cut_not_reshaped() {
        val pad = "x".repeat(600)
        val lenient =
            mapOf(
                "single quotes" to "{'a': '$pad'}",
                "an unquoted key" to "{a: \"$pad\"}",
                "an unquoted word" to "plain $pad",
                "a comment" to "/* note */ {\"a\": \"$pad\"}",
                "semicolons" to "{\"a\": 1; \"b\": \"$pad\"}",
                "equals signs" to "{\"a\" = 1, \"b\": \"$pad\"}",
                "a hex number" to "{\"a\": 0x10, \"b\": \"$pad\"}",
                "text after the value" to "{\"a\": \"$pad\"} and then some",
                "two values" to "{\"a\": \"$pad\"}{\"b\": 1}",
                "a missing comma" to "{\"a\": 1 \"b\": \"$pad\"}",
                "an array with holes" to "[1,, \"$pad\"]",
                "an unterminated object" to "{\"a\": \"$pad\"",
                "an unterminated string" to "{\"a\": \"$pad",
                "a raw newline in a string" to "{\"a\": \"one\ntwo $pad\"}",
                "an unknown escape" to "{\"a\": \"one\\qtwo $pad\"}",
                "a lone surrogate escape" to "{\"a\": \"\\ud800 $pad\"}",
                "a lone low surrogate escape" to "{\"a\": \"\\udc00 $pad\"}",
                "a short unicode escape" to "{\"a\": \"\\u12 $pad\"}",
                "a prose answer" to "No results found for that query. $pad",
                "markup" to "<html><body>$pad</body></html>",
                "only whitespace" to " ".repeat(1_000),
            )

        for ((name, raw) in lenient) {
            val shaped = shape(raw, 300)

            assertWithin(300, shaped)
            assertTrue("$name is cut as text: ${shaped.take(60)}", shaped.endsWith(marker))
            assertTrue("$name keeps the start of the text", raw.startsWith(shaped.removeSuffix(marker)))
        }
    }

    @Test
    fun org_json_would_have_taken_those_for_json_which_is_why_it_is_not_what_decides() {
        // Executable evidence for the reasoning in ToolResultShaper's comment. If org.json ever becomes strict,
        // this fails and the hand-written reader can be reconsidered.
        assertEquals("plain", JSONTokener("plain words. plain words.").nextValue())
        assertTrue(JSONTokener("{'a': 'b'}").nextValue() is JSONObject)
        assertTrue(JSONTokener("{a: 1}").nextValue() is JSONObject)
        assertTrue("trailing text is ignored", JSONTokener("{\"a\": 1} and then some").nextValue() is JSONObject)
        assertEquals("rounded past Long", 1.8446744073709552E19, JSONTokener("18446744073709551615").nextValue() as Double, 0.0)
    }

    @Test
    fun text_that_is_not_a_number_is_not_one() {
        for (literal in listOf("00", "01", "+1", ".5", "1.", "NaN", "Infinity", "-", "0x10", "1e", "1e+")) {
            val raw = "{\"n\": $literal, \"pad\": \"${"x".repeat(600)}\"}"
            val shaped = shape(raw, 300)

            assertWithin(300, shaped)
            assertTrue("$literal is not JSON, so the text is cut", shaped.endsWith(marker) && shaped.startsWith("{\"n\": $literal, "))
        }
    }

    @Test
    fun nesting_deeper_than_the_limit_is_cut_as_text_and_never_overflows_the_stack() {
        val deep = "[".repeat(600) + "]".repeat(600)
        val shaped = shape(deep, 256)

        assertWithin(256, shaped)
        assertTrue(shaped.endsWith(marker))

        // Nowhere near the end of it: a deep open-ended input must be refused as soon as it is too deep.
        val endless = shape("[".repeat(1_000_000), 256)

        assertWithin(256, endless)
        assertTrue(endless.endsWith(marker))

        // MAXIMUM_PARSE_DEPTH levels is the most that nests() lets through to the reader; one more is refused
        // before the reader (or anything after it) ever recurses once. (What comes back at the limit is pruned
        // down hard by MAXIMUM_DEPTH, which is a much shallower cap — that is still valid JSON, just a small one;
        // `a_container_nested_deeper_than_maximum_depth_is_dropped_and_the_shallow_part_is_untouched` is where
        // content surviving a depth under that cap is checked.)
        val limit = ToolResultShaper.MAXIMUM_PARSE_DEPTH
        val atLimit = "[".repeat(limit) + quote("x".repeat(500)) + "]".repeat(limit)
        val pastLimit = "[".repeat(limit + 1) + quote("x".repeat(500)) + "]".repeat(limit + 1)

        assertFalse("followed, and then bounded as JSON", shape(atLimit, 400).endsWith(marker))
        parse(shape(atLimit, 400))
        assertTrue("refused, and cut as text", shape(pastLimit, 400).endsWith(marker))
    }

    @Test
    fun a_repeated_key_keeps_its_first_value_as_it_does_on_ios() {
        val raw = "{\"a\": 1, \"a\": \"${"x".repeat(600)}\", \"b\": null, \"b\": 5, \"c\": 7, \"c\": null}"

        assertEquals("{\"a\":1,\"c\":7}", shape(raw, 300))
    }

    // ---- multi-byte text -----------------------------------------------------------------------------------------

    @Test
    fun multi_byte_text_is_budgeted_in_utf8_bytes_and_a_cut_never_splits_a_character() {
        val hit = mapOf("title" to "記憶$smile", "content" to smile.repeat(1_000), "type" to "note")
        val raw = pretty(mapOf("summary" to "Showing 2 hits $smile", "items" to listOf(hit, hit)))

        for (budget in listOf(300, 560, 700, 1_000, 2_500, 5_000)) {
            val shaped = shape(raw, budget)

            assertWithin(budget, shaped)
            assertWholeCharacters(shaped)
            assertFalse("written as itself, not as \\uXXXX escapes", shaped.contains("\\ud83d"))

            if (!shaped.endsWith(marker)) {
                val first = checkNotNull(shapedItems(shaped)) { "parses at $budget: $shaped" }.hits.first()

                assertEquals("記憶$smile", first.getString("title"))

                val content = first.optString("content")

                assertTrue("the content is cut to a cap of characters, not bytes ($budget): ${content.codePointCount(0, content.length)}", content.codePointCount(0, content.length) <= 321)
                assertTrue(content.isEmpty() || content.endsWith("…"))
            }
        }
    }

    @Test
    fun quotes_backslashes_controls_and_the_rest_are_written_the_short_valid_way() {
        val awkward =
            "quote\" backslash\\ slash/ nl\n cr\r tab\t bs\b ff\u000C nul\u0000 c01\u0001 c1f\u001F del\u007F " +
                "ls\u2028 ps\u2029 bom\uFEFF eé cjk記 emoji$smile nonchar\uFFFF"
        val shaped = shape("{\"a\": ${quote(awkward)}, \"pad\": \"${"x".repeat(4_200)}\"}", 4_000)

        // Slashes stay as they are, every control character is escaped (U+0000 and U+0001 as \u0000 and \u0001,
        // in lower case), and everything above them — DEL, U+2028, a BOM, emoji — is written as itself.
        assertTrue(
            shaped,
            shaped.startsWith(
                "{\"a\":\"quote\\\" backslash\\\\ slash/ nl\\n cr\\r tab\\t bs\\b ff\\f nul\\u0000 c01\\u0001 c1f\\u001f " +
                    "del\u007F ls\u2028 ps\u2029 bom\uFEFF eé cjk記 emoji$smile nonchar\uFFFF\",\"pad\":",
            ),
        )
        assertFalse("compact JSON has no raw control character", shaped.any { it < ' ' })
        assertEquals("and it reads back as what it was", awkward, parseObject(shaped).getString("a"))

        // The same in a key.
        val keyed = shape("{${quote(awkward)}: 1, \"pad\": \"${"x".repeat(4_200)}\"}", 4_000)

        assertEquals(1, parseObject(keyed).getInt(awkward))
    }

    @Test
    fun half_a_character_is_written_as_the_replacement_character_never_as_half_a_character() {
        // A lone surrogate has no UTF-8 form, and one in the answer would make the whole response unencodable.
        val half = 0xD83D.toChar()
        val replacement = 0xFFFD.toChar()
        val shaped = shape("{\"title\": \"before${half}after\", \"k$half\": \"v\", \"pad\": \"${"x".repeat(900)}\"}", 700)

        assertWithin(700, shaped)
        assertEquals("encodable", shaped, String(shaped.toByteArray(Charsets.UTF_8), Charsets.UTF_8))
        assertTrue("in a value: ${shaped.take(120)}", shaped.contains("\"title\":\"before${replacement}after\""))
        assertTrue("in a key: ${shaped.take(120)}", shaped.contains("\"k$replacement\":\"v\""))
    }

    @Test
    fun a_json_scalar_may_stand_alone() {
        assertEquals("\"" + "q".repeat(320) + "…\"", shape(quote("q".repeat(2_000)), 2_000))
        assertEquals("12345", shape(" ".repeat(500) + "12345" + " ".repeat(500), 300))
        assertEquals("true", shape(" ".repeat(500) + "true" + "\n".repeat(500), 300))
        assertEquals("[]", shape("[" + " ".repeat(1_000) + "]", 300))
        assertEquals("{}", shape("{" + " ".repeat(1_000) + "}", 300))
    }

    // ---- ordering keys that tie -----------------------------------------------------------------------------------

    @Test
    fun keys_are_ordered_by_unicode_scalar_not_by_utf16_unit_and_a_decomposed_letter_sorts_as_its_composed_form() {
        // Same value size throughout, so only the key decides. U+FF5E is a single UTF-16 unit above the
        // surrogates, U+1F600 a pair that starts below them; by scalar the pair is the later one.
        val keys = listOf("😀", "～", "記", "é", "z", "A", "a")
        val raw = "{" + keys.joinToString(",") { quote(it) + ":1" } + ",\"pad\":\"" + "x".repeat(400) + "\"}"
        val written = Regex("\"(.*?)\":1").findAll(shape(raw, 400)).map { it.groupValues[1] }.toList()

        assertEquals(listOf("A", "a", "z", "é", "記", "～", "😀"), written)

        // "e" + combining acute is an e-acute: it sorts with the U+00E9 form (after "z"), not with the "e"s.
        val decomposed = "{" + listOf("e\u0301", "z", "a").joinToString(",") { quote(it) + ":1" } + ",\"pad\":\"" + "x".repeat(400) + "\"}"

        assertEquals(listOf("a", "z", "e\u0301"), Regex("\"(.*?)\":1").findAll(shape(decomposed, 400)).map { it.groupValues[1] }.toList())
    }

    @Test
    fun two_keys_that_are_canonically_equivalent_but_not_identical_are_ordered_by_raw_code_point_not_left_to_tie() {
        // "\u00e9" (precomposed, U+00E9) and "e" plus a combining acute (decomposed) are the same character but
        // different code points, and both normalise to the same NFC form, so the first tie-break (itself an
        // approximation of Swift's canonical `<`) cannot tell them apart. Swift's own `<` treats them as equal
        // too, so before this was fixed the order between them came from a Swift dictionary's random per-process
        // order; a plain stable sort here would instead have silently kept whichever one the input happened to
        // write first, which is a different wrong answer, not a right one. The raw, un-normalised code points
        // must decide, the same way Swift's `unicodeScalars.lexicographicallyPrecedes` now does, so the order
        // does not depend on which one the input wrote first.
        val precomposed = "\u00e9"
        val decomposed = "e" + 0x301.toChar()

        // The precomposed form is written first; by raw code points 'e' (U+0065) sorts before '\u00e9' (U+00E9), so if
        // the tie is broken correctly the decomposed form must come first regardless.
        val raw = "{" + quote(precomposed) + ":1," + quote(decomposed) + ":1,\"pad\":\"" + "x".repeat(400) + "\"}"

        assertEquals(listOf(decomposed, precomposed), Regex("\"(.*?)\":1").findAll(shape(raw, 400)).map { it.groupValues[1] }.toList())
    }

    // ---- the pieces ------------------------------------------------------------------------------------------------

    @Test
    fun utf8_length_is_what_the_jdk_encoder_says_for_text_it_can_encode() {
        val family = "👨\u200D👩\u200D👧\u200D👦"
        val samples = listOf("", "abc", "é", "記", smile, "a${smile}é記", family, "\u0000\u007F\u0080\u07FF\u0800\uFFFF", smile.repeat(10))

        for (sample in samples) {
            assertEquals(sample.toByteArray(Charsets.UTF_8).size, ToolResultShaper.utf8Length(sample))
        }

        // A half with no partner has no UTF-8 form; it is counted as the 3 bytes it could at most take.
        assertEquals(3, ToolResultShaper.utf8Length("\uD83D"))
        assertEquals(3, ToolResultShaper.utf8Length("\uDE00"))
        assertEquals(3 + 4, ToolResultShaper.utf8Length("\uDE00$smile"))
    }

    @Test
    fun truncated_keeps_whole_characters_and_ends_in_the_marker() {
        assertEquals("short", ToolResultShaper.truncated("short", 100))
        assertEquals("exactly", ToolResultShaper.truncated("exactly", 7))

        // 30 bytes: 16 for the text and 14 for the marker.
        assertEquals("a".repeat(16) + marker, ToolResultShaper.truncated("a".repeat(100), 30))
        assertEquals(30, utf8("a".repeat(16) + marker))

        assertEquals("$smile$smile$smile$smile$marker", ToolResultShaper.truncated(smile.repeat(50), 30))
        assertEquals("$smile$smile$smile$marker", ToolResultShaper.truncated(smile.repeat(50), 29))
        assertEquals("記".repeat(95) + marker, ToolResultShaper.truncated("記".repeat(200), 301))

        // The marker is the least that is ever written, even when the budget is smaller than it.
        assertEquals(marker, ToolResultShaper.truncated("x".repeat(100), 5))
        assertEquals(marker, ToolResultShaper.truncated("x".repeat(100), 0))
        assertEquals(14, utf8(marker))
    }

    @Test
    fun characters_are_counted_as_a_reader_sees_them_a_flag_a_family_an_accent_and_a_crlf_are_one_each() {
        val family = "👨\u200D👩\u200D👧\u200D👦"
        val flag = "🇺🇸"

        for ((name, character) in mapOf("flag" to flag, "family" to family, "accented e" to "e\u0301", "crlf" to "\r\n", "cjk" to "記", "emoji" to smile)) {
            assertEquals("$name: the first three of five", character.repeat(3), Characters.take(character.repeat(5), 3))
            assertEquals("$name: all of them when there are no more", character.repeat(5), Characters.take(character.repeat(5), 5))
            assertEquals("$name: and when there are fewer", character.repeat(2), Characters.take(character.repeat(2), 9))
        }

        assertEquals("", Characters.take("abc", 0))
        assertEquals("", Characters.take("abc", -1))
        assertEquals("ab", Characters.take("abc", 2))
    }
}
