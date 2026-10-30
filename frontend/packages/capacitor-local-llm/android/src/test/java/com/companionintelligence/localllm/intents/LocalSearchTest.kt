package com.companionintelligence.localllm.intents

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/** The SQL the phone's search runs and the envelope it writes, against a scripted source. */
@RunWith(RobolectricTestRunner::class)
class LocalSearchTest {

    @Test
    fun a_text_query_drives_through_the_fts_index_scoped_to_the_text_columns_with_the_type_term_off_its_index() {
        val statement = LocalSearch.pageStatement(LocalSearchArgs(query = "harbour grill"))!!

        assertTrue(statement.sql.contains("FROM mobile_search_documents_fts JOIN mobile_search_documents d ON d.rowid = mobile_search_documents_fts.rowid"))
        assertTrue(statement.sql.contains("mobile_search_documents_fts MATCH ?"))
        assertTrue(statement.sql.contains("+d.entity_type IN (?, ?, ?, ?, ?, ?, ?, ?, ?)"))
        assertTrue(statement.sql.contains("ORDER BY bm25(mobile_search_documents_fts, 10.0, 1.0), d.id"))
        assertTrue(statement.sql.endsWith("LIMIT ?"))
        assertEquals("\"harbour\"* OR \"grill\"*", statement.params[0])
        assertEquals(LocalSearch.LEAN_ENTITY_TYPES, statement.params.subList(1, 10))
        assertEquals("25", statement.params.last())
    }

    @Test
    fun a_browse_or_a_recent_sort_orders_by_time_newest_first() {
        val browse = LocalSearch.pageStatement(LocalSearchArgs())!!
        assertTrue(browse.sql.contains("FROM mobile_search_documents d WHERE"))
        assertTrue(browse.sql.contains("ORDER BY d.occurred_at DESC NULLS LAST, d.id"))
        // Every lean kind in time order is a broad scope: the type term stays off the type index.
        assertTrue(browse.sql.contains("+d.entity_type IN ("))

        val recent = LocalSearch.pageStatement(LocalSearchArgs(query = "lunch", sort = "recent"))!!
        assertTrue(recent.sql.contains("MATCH ?"))
        assertTrue(recent.sql.contains("ORDER BY d.occurred_at DESC NULLS LAST, d.id"))

        // One narrow kind in time order takes its own (entity_type, occurred_at) range.
        val receipts = LocalSearch.pageStatement(LocalSearchArgs(entityTypes = listOf("receipt")))!!
        assertTrue(receipts.sql.contains(" d.entity_type IN (?)"))
        assertFalse(receipts.sql.contains("+d.entity_type"))
    }

    @Test
    fun the_scope_is_the_lean_kinds_the_call_names_and_nothing_else() {
        assertEquals(listOf("event", "person"), LocalSearch.scope(LocalSearchArgs(entityTypes = listOf("Event", "person", "answer", "event"))))
        assertEquals(LocalSearch.LEAN_ENTITY_TYPES, LocalSearch.scope(LocalSearchArgs(entityTypes = listOf("browser-activity"))))
    }

    @Test
    fun dates_bound_the_stored_text_form_a_day_at_a_time() {
        // The replica stores `YYYY-MM-DD HH:MM:SS[.f]Z` with a space; a lower bound at the day's first
        // second and an upper bound at the NEXT day's first second take the whole of both days.
        assertEquals("2024-01-01 00:00:00", LocalSearch.occurredAtBound("2024-01-01", LocalSearch.Edge.LOWER))
        assertEquals("2024-01-02 00:00:00", LocalSearch.occurredAtBound("2024-01-01", LocalSearch.Edge.UPPER))
        assertEquals("2024-03-08 00:00:00", LocalSearch.occurredAtBound("2024-03-08T17:42:00.000Z", LocalSearch.Edge.LOWER))
        assertNull(LocalSearch.occurredAtBound("last week", LocalSearch.Edge.LOWER))

        val statement = LocalSearch.pageStatement(LocalSearchArgs(query = "x", since = "2024-01-01", until = "2024-12-31"))!!
        assertTrue(statement.sql.contains("d.occurred_at >= ?"))
        assertTrue(statement.sql.contains("d.occurred_at < ?"))
        assertTrue(statement.params.contains("2024-01-01 00:00:00"))
        assertTrue(statement.params.contains("2025-01-01 00:00:00"))
    }

    @Test
    fun the_count_shares_the_page_s_filters_and_a_query_of_punctuation_matches_nothing() {
        val args = LocalSearchArgs(query = "harbour", entityTypes = listOf("event"))
        val page = LocalSearch.pageStatement(args)!!
        val count = LocalSearch.countStatement(args)!!

        assertTrue(count.sql.startsWith("SELECT count(*) FROM mobile_search_documents_fts"))
        assertFalse(count.sql.contains("ORDER BY"))
        assertEquals(page.params.dropLast(1), count.params)

        assertNull(LocalSearch.pageStatement(LocalSearchArgs(query = "!!!")))
        assertNull(LocalSearch.countStatement(LocalSearchArgs(query = "!!!")))
    }

    @Test
    fun the_envelope_is_the_appliance_s_with_the_phone_s_exact_count_and_a_lean_hit() {
        val source =
            ScriptedSource(
                total = 308,
                rows =
                    listOf(
                        LocalSearchRow(
                            entityType = "communication",
                            entityId = "c1",
                            title = "Lunch?",
                            body = "",
                            occurredAt = "2026-10-01 12:00:00Z",
                            detail = """{"direction": "inbound", "participants": {"from": "Ana", "to": ["Kyle"]}, "from_id": "p1", "to_ids": ["p2"], "source_system": "discord"}""",
                        ),
                    ),
            )

        val result = JSONObject(LocalSearch.run(source, LocalSearchArgs(query = "lunch")))

        assertEquals("Showing the top 1 of 308 matches (exact count). Report the total, not the number shown.", result.getString("summary"))
        assertEquals(308, result.getInt("totalMatches"))
        assertTrue(result.getBoolean("truncated"))
        assertEquals(25, result.getInt("limit"))
        assertEquals("local", result.getString("mode"))

        val hit = result.getJSONArray("items").getJSONObject(0)
        // What it is first, then where, when and what it says — the order the shaper keeps under a cut.
        assertEquals(listOf("id", "type", "title", "link", "time", "content"), hit.keys().asSequence().take(6).toList())
        assertEquals("c1", hit.getString("id"))
        assertEquals("communication", hit.getString("type"))
        assertEquals("/memory/saved/communication/c1", hit.getString("link"))
        assertTrue(hit.isNull("content"))
        // Display fields come along; the ids the explorer's filters use do not.
        assertEquals("inbound", hit.getString("direction"))
        assertEquals("discord", hit.getString("source_system"))
        assertEquals("Ana", hit.getJSONObject("participants").getString("from"))
        assertFalse(hit.has("from_id"))
        assertFalse(hit.has("to_ids"))
    }

    @Test
    fun a_count_only_call_returns_the_number_and_no_items_and_a_full_page_is_not_called_truncated() {
        val counted = JSONObject(LocalSearch.run(ScriptedSource(total = 1_424, rows = emptyList()), LocalSearchArgs(query = "order", entityTypes = listOf("event"), countOnly = true)))

        assertEquals("1424 events match \"order\" (exact count from the phone's search index; no items returned).", counted.getString("summary"))
        assertEquals(1_424, counted.getInt("totalMatches"))
        assertEquals(0, counted.getInt("limit"))
        assertEquals("count", counted.getString("mode"))
        assertEquals(0, counted.getJSONArray("items").length())

        val row = LocalSearchRow("note", "n1", "Groceries", "eggs", null, null)
        val all = JSONObject(LocalSearch.run(ScriptedSource(total = 2, rows = listOf(row, row.copy(entityId = "n2"))), LocalSearchArgs(sort = "recent")))

        assertEquals("2 matches; all shown, newest first.", all.getString("summary"))
        assertFalse(all.getBoolean("truncated"))
    }

    @Test
    fun arguments_are_read_the_way_the_lean_schema_names_them() {
        val args =
            LocalSearchArgs.fromJson(
                JSONObject("""{"query": "lunch", "entityTypes": ["event", "note"], "since": "2024-01-01", "sort": "recent", "countOnly": true}"""),
            )

        assertEquals("lunch", args.query)
        assertEquals(listOf("event", "note"), args.entityTypes)
        assertEquals("2024-01-01", args.since)
        assertNull(args.until)
        assertEquals("recent", args.sort)
        assertTrue(args.countOnly)
        assertEquals(LocalSearchArgs(), LocalSearchArgs.fromJson(JSONObject()))
    }

    /** A source that answers every page with [rows] and every count with [total]. */
    class ScriptedSource(private val total: Int, private val rows: List<LocalSearchRow>) : LocalSearchSource {
        val calls = ArrayList<Pair<String, List<String>>>()

        override fun isAvailable(): Boolean = true

        override fun rows(sql: String, params: List<String>): List<LocalSearchRow> {
            calls += sql to params
            return rows
        }

        override fun count(sql: String, params: List<String>): Int {
            calls += sql to params
            return total
        }
    }
}
