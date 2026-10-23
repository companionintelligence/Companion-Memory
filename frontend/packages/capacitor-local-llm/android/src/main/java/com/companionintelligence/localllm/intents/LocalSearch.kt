package com.companionintelligence.localllm.intents

import org.json.JSONArray
import org.json.JSONObject
import java.time.LocalDate
import java.time.OffsetDateTime
import java.time.format.DateTimeParseException

/**
 * `knowledge.search` answered from the phone's own synced replica — the search documents PowerSync
 * keeps in `ci-powersyncSQLite.db` (`ci_search.mobile_search_documents` on the appliance; the raw
 * table and its FTS5 index the web app builds in `api/powersync/searchIndex.ts`).
 *
 * Same lean parameters as the appliance's local-tier form of the intent (`DatabaseSearchTool.ts`,
 * `schema.local`), same result envelope (`SearchToolResult`: `summary`, `totalMatches`,
 * `truncated`, `limit`, `mode`, `items`), so the model, the system instruction and the result
 * shaper see one tool whichever side answers. What differs is the hit: the appliance hydrates a
 * whole entity, the phone holds a title, a text and a few display fields (`detail`), and says so
 * with `mode: "local"`.
 *
 * The SQL is the web app's offline list (`api/powersync/localList.ts`) in Kotlin, with the same
 * planner steering that was measured there on a 589k-row replica: a text query must drive through
 * the FTS index (the unary plus keeps the type term off the type index — 15 s per query without
 * it), a broad time-ordered scope walks the time index the same way, and a narrow one takes its
 * own `(entity_type, occurred_at)` range.
 */

/** The arguments the model may pass, as the lean schema names them. */
data class LocalSearchArgs(
    val query: String = "",
    val entityTypes: List<String> = emptyList(),
    val since: String? = null,
    val until: String? = null,
    val sort: String? = null,
    val countOnly: Boolean = false,
) {
    companion object {
        fun fromJson(json: JSONObject): LocalSearchArgs =
            LocalSearchArgs(
                query = json.optString("query", ""),
                entityTypes =
                    json.optJSONArray("entityTypes")?.let { array ->
                        (0 until array.length()).mapNotNull { array.optString(it).takeIf { s -> s.isNotEmpty() } }
                    } ?: emptyList(),
                since = json.optString("since").takeIf { it.isNotEmpty() },
                until = json.optString("until").takeIf { it.isNotEmpty() },
                sort = json.optString("sort").takeIf { it.isNotEmpty() },
                countOnly = json.optBoolean("countOnly", false),
            )
    }
}

/** A row of the replica's search documents, as [LocalSearchSource] reads it. */
data class LocalSearchRow(
    val entityType: String,
    val entityId: String,
    val title: String?,
    val body: String?,
    val occurredAt: String?,
    /** The `detail` JSON text, or null. */
    val detail: String?,
)

/** What the tool reads from: the replica, or a fake in a test. */
interface LocalSearchSource {
    /** Whether there is a replica to read right now (the file exists and its key can be read). */
    fun isAvailable(): Boolean

    fun rows(sql: String, params: List<String>): List<LocalSearchRow>

    fun count(sql: String, params: List<String>): Int
}

/** The SQL for one search, and the result envelope built from what it returns. */
object LocalSearch {
    const val TABLE = "mobile_search_documents"
    const val FTS_TABLE = "mobile_search_documents_fts"

    /** The default page, the appliance's (`limit: 25` on every page it answers). */
    const val PAGE_LIMIT = 25

    /** The replica file, as the Capacitor SQLite plugin names it: its `dbName` + `SQLite.db`. */
    const val DEFAULT_DATABASE_FILE = "ci-powersyncSQLite.db"

    /**
     * The kinds the lean schema lets the model pick from — `LEAN_ENTITY_TYPES` in `DatabaseSearchTool.ts`,
     * and the scope a call without `entityTypes` searches. Every one is a type the device record table holds.
     */
    val LEAN_ENTITY_TYPES: List<String> =
        listOf("communication", "content", "file", "event", "note", "person", "place", "receipt", "task")

    /** The types that are nearly all the rows; see `localList.ts` for the measurements behind the hint. */
    private val BULK_TYPES = setOf("communication", "event", "content")

    /** `bm25()` weights in FTS column order: title, body, then the three id columns the Who filter indexes. */
    private const val RANK_WEIGHTS = "10.0, 1.0, 0.0, 0.0, 0.0"

    data class Statement(val sql: String, val params: List<String>)

    /** The scope a call asks for: the lean kinds it names, else every lean kind. */
    fun scope(args: LocalSearchArgs): List<String> {
        val asked = args.entityTypes.map { it.trim().lowercase() }.filter { it in LEAN_ENTITY_TYPES }

        return if (asked.isEmpty()) LEAN_ENTITY_TYPES else asked.distinct()
    }

    /**
     * The FTS5 MATCH for a free-text query: each word a quoted prefix term, OR-joined, scoped to the text
     * columns — the same expression as `localSearch.ts`'s `ftsMatchExpression`. Null when nothing is left.
     */
    fun matchExpression(query: String): String? {
        val terms = query.lowercase().split(Regex("[^\\p{L}\\p{N}]+")).filter { it.isNotEmpty() }

        if (terms.isEmpty()) return null

        return "{title body}: (" + terms.joinToString(" OR ") { "\"$it\"*" } + ")"
    }

    /**
     * A date (`YYYY-MM-DD`) or instant as a bound on the stored `occurred_at`, which is Postgres text
     * (`YYYY-MM-DD HH:MM:SS[.f]Z`, a space, not a `T`). The lower bound is the day's first second, inclusive;
     * the upper bound is the NEXT day's first second, exclusive, so "until Tuesday" includes all of Tuesday.
     * Null for text that is not a date.
     */
    fun occurredAtBound(text: String, edge: Edge): String? {
        val date =
            try {
                LocalDate.parse(text.take(10))
            } catch (e: DateTimeParseException) {
                try {
                    OffsetDateTime.parse(text).toLocalDate()
                } catch (e2: DateTimeParseException) {
                    return null
                }
            }
        val day = if (edge == Edge.UPPER) date.plusDays(1) else date

        return "$day 00:00:00"
    }

    enum class Edge { LOWER, UPPER }

    private class Clauses(val from: String, val where: List<String>, val params: List<String>, val hasQuery: Boolean)

    private fun clauses(args: LocalSearchArgs, ordered: Boolean): Clauses? {
        val types = scope(args)
        val match = matchExpression(args.query)
        val hasQuery = args.query.isNotBlank()

        if (hasQuery && match == null) return null

        val where = ArrayList<String>()
        val params = ArrayList<String>()
        val from =
            if (match != null) {
                where += "$FTS_TABLE MATCH ?"
                params += match
                "FROM $FTS_TABLE JOIN $TABLE d ON d.rowid = $FTS_TABLE.rowid"
            } else {
                "FROM $TABLE d"
            }

        val timeOrdered = ordered && (hasQuery.not() || args.sort == "recent")
        val broad = types.size > 1 && types.any { it in BULK_TYPES }
        val typeTerm = if (hasQuery || (timeOrdered && broad)) "+d.entity_type" else "d.entity_type"

        where += "$typeTerm IN (${types.joinToString(", ") { "?" }})"
        params += types

        args.since?.let { occurredAtBound(it, Edge.LOWER) }?.let {
            where += "d.occurred_at >= ?"
            params += it
        }
        args.until?.let { occurredAtBound(it, Edge.UPPER) }?.let {
            where += "d.occurred_at < ?"
            params += it
        }

        return Clauses(from, where, params, hasQuery)
    }

    /** The page statement, or null when nothing can match. */
    fun pageStatement(args: LocalSearchArgs, limit: Int = PAGE_LIMIT): Statement? {
        val c = clauses(args, ordered = true) ?: return null
        val order =
            if (c.hasQuery && args.sort != "recent") {
                "ORDER BY bm25($FTS_TABLE, $RANK_WEIGHTS), d.id"
            } else {
                "ORDER BY d.occurred_at DESC NULLS LAST, d.id"
            }

        return Statement(
            "SELECT d.entity_type, d.entity_id, d.title, d.body, d.occurred_at, d.detail " +
                "${c.from} WHERE ${c.where.joinToString(" AND ")} $order LIMIT ?",
            c.params + limit.toString(),
        )
    }

    /** The exact match count for the same filters, or null when nothing can match. */
    fun countStatement(args: LocalSearchArgs): Statement? {
        val c = clauses(args, ordered = false) ?: return null

        return Statement("SELECT count(*) ${c.from} WHERE ${c.where.joinToString(" AND ")}", c.params)
    }

    /**
     * Runs one call against [source] and writes the appliance's envelope. A call with nothing searchable
     * (a query of punctuation) answers like a search that found nothing rather than failing.
     */
    fun run(source: LocalSearchSource, args: LocalSearchArgs, limit: Int = PAGE_LIMIT): String {
        val scope = scope(args)
        val count = countStatement(args)
        val total = if (count == null) 0 else source.count(count.sql, count.params)
        val query = args.query.trim().takeIf { it.isNotEmpty() }

        if (args.countOnly) {
            return envelope(
                summary = describeCount(total, query, scope),
                totalMatches = total,
                truncated = false,
                limit = 0,
                mode = "count",
                items = JSONArray(),
            ).toString()
        }

        val page = pageStatement(args, limit)
        val rows = if (page == null) emptyList() else source.rows(page.sql, page.params)
        val newestFirst = args.sort == "recent" || query == null
        val items = JSONArray().also { array -> rows.forEach { array.put(item(it)) } }

        return envelope(
            summary = describePage(total, rows.size, newestFirst),
            totalMatches = total,
            truncated = rows.size < total,
            limit = limit,
            mode = "local",
            items = items,
        ).toString()
    }

    private fun envelope(summary: String, totalMatches: Int, truncated: Boolean, limit: Int, mode: String, items: JSONArray) =
        JSONObject()
            .put("summary", summary)
            .put("totalMatches", totalMatches)
            .put("truncated", truncated)
            .put("limit", limit)
            .put("mode", mode)
            .put("items", items)

    /**
     * One hit as the model reads it: what it is first, then when, then what it says, then the display
     * fields — the order the result shaper keeps when it has to cut. The link is the offline record
     * page, which opens whether or not the appliance answers.
     */
    fun item(row: LocalSearchRow): JSONObject {
        val item =
            JSONObject()
                .put("id", row.entityId)
                .put("type", row.entityType)
                .put("title", row.title?.takeIf { it.isNotEmpty() } ?: JSONObject.NULL)
                .put("link", "/memory/saved/${row.entityType}/${row.entityId}")
                .put("time", row.occurredAt ?: JSONObject.NULL)
                .put("content", row.body?.takeIf { it.isNotEmpty() } ?: JSONObject.NULL)

        row.detail?.let { text ->
            try {
                val detail = JSONObject(text)
                for (key in detail.keys()) {
                    // The ids the explorer's filters use say nothing to a model; the rest are display fields.
                    if (key in HIDDEN_DETAIL_KEYS) continue
                    item.put(key, detail.get(key))
                }
            } catch (e: Exception) {
                // Not JSON: leave the hit as the five fields above.
            }
        }

        return item
    }

    private val HIDDEN_DETAIL_KEYS = setOf("from_id", "to_ids", "people", "location_id", "participants_truncated")

    private fun scopeLabel(scope: List<String>): String =
        if (scope.toSet() == LEAN_ENTITY_TYPES.toSet()) "entries" else scope.joinToString(", ") { plural(it) }

    private fun plural(type: String): String =
        when (type) {
            "communication" -> "messages"
            "person" -> "people"
            else -> "${type}s"
        }

    /** `describeCount` in `DatabaseSearchTool.ts`, for the phone's exact count. */
    fun describeCount(total: Int, query: String?, scope: List<String>): String {
        val what = if (query != null) "$total ${scopeLabel(scope)} match \"$query\"" else "$total ${scopeLabel(scope)} on this phone"

        return "$what (exact count from the phone's search index; no items returned)."
    }

    /** `describePage` in `DatabaseSearchTool.ts`: the phone's count is always exact. */
    fun describePage(total: Int, shown: Int, newestFirst: Boolean): String {
        val order = if (newestFirst) ", newest first" else ""

        if (total <= shown) return "$total matches; all shown$order."

        return "Showing the ${if (newestFirst) "newest" else "top"} $shown of $total matches (exact count)$order. " +
            "Report the total, not the number shown."
    }
}
