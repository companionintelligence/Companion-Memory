package com.companionintelligence.localllm.intents

import com.companionintelligence.localllm.intents.ToolResultFixtures.quote
import com.companionintelligence.localllm.intents.ToolResultFixtures.utf8
import java.util.Locale
import java.util.Random
import java.util.TreeSet
import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * What must be true of [ToolResultShaper]'s answer for ANY input, checked on thousands of generated ones with no
 * oracle: random documents of every shape the appliance returns (and several it does not), written three ways, at
 * budgets that include the awkward ones (0, 1, 63, 64, 65, 96, 97, 255, 256), plus the same documents damaged.
 * [ToolResultShaperTest] pins the answers for chosen inputs and [SwiftParityTest] compares them with iOS's; this
 * is for the inputs nobody chose.
 *
 * For every input and budget:
 * - shaping never throws;
 * - the answer is at most `max(budget, 64)` bytes of UTF-8, and is encodable (no character cut in half);
 * - an input that fits comes back untouched, and shaping an answer again changes nothing;
 * - text that is not strict JSON comes back as a cut of itself that ends in the marker;
 * - JSON comes back as JSON that a strict parser reads, or as a cut that ends in the marker. Nothing in between;
 * - and JSON that comes back as JSON has the shape the design promises: it is the same kind of value (an object
 *   stays an object), no `null`, `false`, empty string, empty list or empty object is left below the top, no bare
 *   UUID is left anywhere but under `id` and `link`, and every string and key in it is the input's own, or one of
 *   the input's cut short with an ellipsis, or the closing note of a list. That last one is what "nothing is
 *   escaped twice" and "a hit never becomes a string of JSON" come to once a result is read back.
 *
 * Plain documents use no quote, backslash or control character, so there the stronger form holds: the answer
 * contains no backslash at all.
 */
@RunWith(RobolectricTestRunner::class)
class ToolResultShaperInvariantsTest {
    private val marker = ToolResultShaper.TRUNCATION_MARKER
    private val closingNote = Regex("""\[\d+ more results omitted — refine the query to narrow them down]""")
    private val uuid = Regex("""[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}""")

    // ---- the properties ---------------------------------------------------------------------------

    /** An input and what is known about it: its strings and keys, when it is JSON. */
    private class Subject(val text: String, val label: String, val plain: Boolean, val strings: TreeSet<String>?, val keys: Set<String>?)

    /** What is in the input comes from [StrictJsonCheck], not `org.json`: that one refuses `1e999`, and keeps the last of a repeated key where the shaper keeps the first. */
    private fun subject(text: String, label: String, plain: Boolean): Subject {
        val collected = StrictJsonCheck.collect(text) ?: return Subject(text, label, plain, null, null)

        return Subject(text, label, plain, collected.strings, collected.keys)
    }

    private fun check(subject: Subject, budget: Int): String {
        val limit = maxOf(budget, ToolResultShaper.MINIMUM_BUDGET_BYTES)
        val where = "${subject.label} at a budget of $budget"
        val shaped =
            try {
                ToolResultShaper.shape(subject.text, budget)
            } catch (e: Throwable) {
                throw AssertionError("$where: shaping threw $e", e)
            }

        assertTrue("$where: ${utf8(shaped)} bytes is over $limit", utf8(shaped) <= limit)
        assertEquals("$where: not encodable as UTF-8, so a character was cut in half", shaped, String(shaped.toByteArray(Charsets.UTF_8), Charsets.UTF_8))

        if (utf8(subject.text) <= limit) {
            assertEquals("$where: an input that fits is passed on untouched", subject.text, shaped)

            return shaped
        }

        assertEquals("$where: shaping an answer again changes it", shaped, ToolResultShaper.shape(shaped, budget))

        if (subject.plain && !subject.text.contains('\\')) {
            assertFalse("$where: no plain text needs a backslash, so this was escaped twice: ${shaped.take(200)}", shaped.contains('\\'))
        }

        val strings = subject.strings

        if (strings == null) {
            assertTrue("$where: text that is not JSON is cut and says so: ${shaped.takeLast(40)}", shaped.endsWith(marker))
            assertTrue("$where: what is kept of it is its start", subject.text.startsWith(shaped.removeSuffix(marker)))

            return shaped
        }

        val problem = StrictJsonCheck.problem(shaped)

        if (problem != null) {
            assertTrue("$where: JSON in must be JSON out or a cut that says so, and this is neither ($problem): ${shaped.take(200)}", shaped.endsWith(marker))

            return shaped
        }

        val value = JSONTokener(shaped).nextValue()
        val first = subject.text.trimStart(' ', '\t', '\n', '\r').first()

        if (first == '{') assertTrue("$where: an object stays an object", value is JSONObject)
        if (first == '[') assertTrue("$where: an array stays an array", value is JSONArray)

        audit(value, null, true, subject, strings, where)

        return shaped
    }

    /** [key] is the name this value is the member of, or null for an element of an array and for the top. */
    private fun audit(value: Any?, key: String?, top: Boolean, subject: Subject, strings: TreeSet<String>, where: String) {
        when {
            value == null || value === JSONObject.NULL -> fail("$where: a null is in the answer, and an unset column is never sent")
            value is Boolean -> assertTrue("$where: a false is in the answer (under ${key ?: "an array"})", value)
            value is String -> {
                assertTrue("$where: an empty string is in the answer (under ${key ?: "an array"})", value.isNotEmpty())
                assertFalse("$where: a bare UUID is in the answer under ${key ?: "an array"}: $value", uuid.matches(value) && key != "id" && key != "link")
                assertTrue("$where: a string that is not the input's: ${value.take(120)}", derived(value, strings))
            }
            value is JSONObject -> {
                assertTrue("$where: an empty object is in the answer, below the top", top || value.length() > 0)

                for (name in value.keys()) {
                    assertTrue("$where: a key that is not the input's: $name", name in subject.keys!!)

                    audit(value.get(name), name, false, subject, strings, where)
                }
            }
            value is JSONArray -> {
                assertTrue("$where: an empty list is in the answer, below the top", top || value.length() > 0)

                for (index in 0 until value.length()) audit(value.get(index), null, false, subject, strings, where)
            }
        }
    }

    /** Whether [string] is one of [inputs], or one of them cut short and ended with an ellipsis, or the note that closes a list. */
    private fun derived(string: String, inputs: TreeSet<String>): Boolean {
        if (string in inputs || closingNote.matches(string)) return true
        if (!string.endsWith("…")) return false

        // Every string that starts with `head` sorts at or after it, and the first of those is the least of them all.
        val head = string.dropLast(1)

        return inputs.ceiling(head)?.startsWith(head) == true
    }

    // ---- the generator ----------------------------------------------------------------------------

    /** A number written exactly as it is here, for the ones a double would print differently. */
    private class Raw(val text: String)

    private class Documents(seed: Long, private val exotic: Boolean) {
        val random = Random(seed)

        fun int(bound: Int): Int = random.nextInt(bound)

        fun chance(percent: Int): Boolean = random.nextInt(100) < percent

        fun range(low: Int, high: Int): Int = low + random.nextInt(high - low + 1)

        fun <T> pick(items: List<T>): T = items[random.nextInt(items.size)]

        private fun codePoints(vararg codes: Int): String = String(codes, 0, codes.size)

        private val words =
            listOf(
                "heron", "Lake Merritt", "dentist", "Dr. Priya Nair", "Fremont Smile Dental", "hello", "ok", "x", "see you at 6", "invoice 2025-10", "KNOWS",
                "FRIEND_OF", "Maria Alvarez", "takeout", "résumé", "café au lait", "https://example.com/path?x=1&y=2", "a/b/c", "100% sure",
                "<tag>&amp;</tag>", "it's fine",
            ) + codePoints(0x8A18, 0x61B6, 0x306E, 0x691C, 0x7D22)

        /** What a plain document never has: quotes, backslashes, controls, and the characters that join or split. */
        private val odd =
            listOf(
                "say \"hi\"", "back\\slash", "tab\there", "two\nlines", "cr\rlf", "nul" + codePoints(0) + "byte", "bell" + codePoints(7), "del" + codePoints(0x7F),
                "ls" + codePoints(0x2028) + "ps" + codePoints(0x2029), "bom" + codePoints(0xFEFF) + "mark", codePoints(0x1F600) + " emoji", "e" + codePoints(0x301) + " accent",
                codePoints(0x1F1FA, 0x1F1F8) + " flag", "family " + codePoints(0x1F468, 0x200D, 0x1F469, 0x200D, 0x1F467, 0x200D, 0x1F466), "{\"looks\":\"like json\"}",
                "[1,2,3]", "…", "…[truncated]", "[3 more results omitted — refine the query to narrow them down]", "\\\"already escaped\\\"",
                "\\u0041 is not an escape here", "-- migrate:up",
            )

        private val keys = listOf("id", "type", "link", "title", "name", "summary", "content", "text", "time", "tags", "items", "nodes", "edges", "stats", "status", "category", "metadata", "x", "y", "count")

        private val oddKeys = listOf("quote\"key", "back\\slash", "é", "e" + codePoints(0x301), codePoints(0x8A18), codePoints(0x1F600), "", "a b", "a/b")

        private val types = listOf("note", "communication", "photo", "event", "person", "place", "concept", "organization")

        private val relations = listOf("KNOWS", "FRIEND_OF", "WORKS_AT", "LIVES_IN", "MARRIED_TO")

        private val columns =
            listOf(
                "id", "type", "entityType", "link", "title", "name", "subject", "content", "text", "description", "notes", "time", "startTime", "endTime", "createdAt", "updatedAt",
                "takenAt", "sourceId", "sourceSystem", "importanceScore", "score", "tags", "metadata", "threadId", "fromEntityId", "toEntityIds", "attachments", "isArchived",
                "isActive", "locationName", "category", "status", "extraOne", "extraTwo",
            )

        fun uuid(): String {
            val hex = "0123456789abcdef"
            val text = StringBuilder()

            for (index in 0 until 36) text.append(if (index == 8 || index == 13 || index == 18 || index == 23) '-' else hex[random.nextInt(16)])

            return if (exotic && chance(30)) text.toString().uppercase(Locale.ROOT) else text.toString()
        }

        fun word(): String = pick(if (exotic) words + odd else words)

        fun key(): String = pick(if (exotic && chance(30)) oddKeys else keys)

        /** Words up to [characters] characters long, cut between code points: a lone surrogate is not text anything sends. */
        fun text(characters: Int): String {
            val out = StringBuilder()

            while (out.codePointCount(0, out.length) < characters) out.append(word()).append(' ')

            return out.substring(0, out.offsetByCodePoints(0, minOf(characters, out.codePointCount(0, out.length))))
        }

        fun number(): Any =
            when (int(10)) {
                0 -> int(1000).toLong()
                1 -> -int(1000).toLong()
                2 -> random.nextDouble()
                3 -> Raw(pick(listOf("0.10", "1E-7", "1e5", "-0", "12345678901234567890", "0.000001", "2.5e-5", "1e308", "100.0", "-1.5E+3", "123456789012345678901234567890")))
                4 -> 0L
                5 -> random.nextInt().toLong()
                6 -> random.nextGaussian() * 1e6
                7 -> if (chance(8)) Raw(pick(listOf("1e999", "-1e999"))) else int(10) / 10.0
                else -> int(100) / 10.0
            }

        fun scalar(): Any? =
            when (int(11)) {
                0 -> null
                1 -> true
                2 -> false
                3 -> ""
                4 -> uuid()
                5, 6 -> number()
                7 -> text(range(1, 30))
                8 -> text(int(400))
                else -> word()
            }

        private fun date(): String = String.format(Locale.US, "2025-%02d-%02dT%02d:%02d:00.000Z", range(1, 12), range(1, 28), int(24), int(60))

        private fun valueFor(column: String): Any? =
            when (column) {
                "id" -> if (chance(60)) uuid() else "id-${int(1000)}"
                "type", "entityType" -> pick(types)
                "link" ->
                    when (int(10)) {
                        0 -> ""
                        1 -> null
                        2 -> int(100).toLong()
                        else -> "/things/" + uuid()
                    }
                "title", "name", "subject" -> text(range(1, 60)).trim().ifEmpty { "x" }
                "content", "text", "description", "notes" -> text(pick(listOf(0, 20, 200, 800, 3000)))
                "time", "startTime", "endTime", "createdAt", "updatedAt", "takenAt" -> date()
                "sourceId", "sourceSystem", "category", "locationName", "status" -> word()
                "importanceScore", "score" -> number()
                "tags" -> List(int(5)) { if (chance(25)) uuid() else word() }
                "metadata" -> map(1, 4)
                "threadId", "fromEntityId" -> if (chance(20)) null else uuid()
                "toEntityIds" -> List(int(4)) { uuid() }
                "attachments" -> List(int(3)) { mapOf("name" to word(), "size" to int(10_000).toLong()) }
                "isArchived", "isActive" -> chance(30)
                else -> scalar()
            }

        /** One hydrated entity: a random half of the columns the appliance writes, in a random order. [titled] gives it a title no other has. */
        fun hit(index: Int, titled: Boolean = false): Map<String, Any?> {
            val hit = LinkedHashMap<String, Any?>()

            for (column in columns.shuffled(random)) if (chance(55)) hit[column] = valueFor(column)

            if (titled) hit["title"] = "T$index"

            return hit
        }

        fun map(depth: Int, most: Int = 6): Map<String, Any?> {
            val map = LinkedHashMap<String, Any?>()

            repeat(int(most + 1)) { map[key()] = nested(depth) }

            return map
        }

        fun list(depth: Int, most: Int = 6): List<Any?> = List(int(most + 1)) { nested(depth) }

        fun nested(depth: Int): Any? =
            if (depth <= 0) {
                scalar()
            } else {
                when (int(6)) {
                    1 -> list(depth - 1)
                    2, 3 -> map(depth - 1)
                    4 -> hit(int(100))
                    else -> scalar()
                }
            }

        /** What `knowledge.search` returns. [titled] hits are told apart by title. */
        fun envelope(titled: Boolean = false, count: Int = int(41)): Map<String, Any?> {
            val members = ArrayList<Pair<String, Any?>>()

            members.add("summary" to "Showing the top $count of at least $count matches.")

            if (chance(70)) members.add("totalMatches" to if (chance(50)) null else int(500).toLong())
            if (chance(70)) members.add("truncated" to chance(50))
            if (chance(70)) members.add("limit" to 25L)
            if (chance(70)) members.add("mode" to "hybrid")
            if (chance(15)) members.add("query" to text(range(1, 300)))

            members.add("items" to List(count) { hit(it, titled) })

            return LinkedHashMap<String, Any?>().also { map -> members.shuffled(random).forEach { map[it.first] = it.second } }
        }

        /** What `memory.recall` returns. */
        fun graph(): Map<String, Any?> =
            linkedMapOf(
                "nodes" to List(int(31)) { mapOf("id" to uuid(), "name" to text(range(1, 30)), "type" to pick(types), "note" to text(pick(listOf(0, 50, 300)))) },
                "edges" to
                    List(int(41)) {
                        mapOf("id" to uuid(), "type" to pick(relations), "from" to mapOf("id" to uuid(), "name" to word()), "to" to mapOf("id" to uuid(), "name" to word()))
                    },
                "stats" to mapOf("nodeCount" to int(100).toLong(), "edgeCount" to int(100).toLong()),
                "seedEntityIds" to List(int(4)) { uuid() },
            )

        /** Several lists of different lengths beside a few members. */
        fun lists(): Map<String, Any?> {
            val map = LinkedHashMap<String, Any?>()

            repeat(range(1, 4)) { map[key()] = List(int(31)) { if (chance(70)) hit(it) else scalar() } }
            repeat(int(4)) { map[key()] = scalar() }

            return map
        }

        fun flat(): Map<String, Any?> {
            val map = LinkedHashMap<String, Any?>()

            repeat(int(81)) { map[key() + int(1000)] = scalar() }

            return map
        }

        /** [levels] of nesting around one long string. */
        fun chain(levels: Int): Any? {
            var value: Any? = text(2000)

            repeat(levels) { value = if (chance(50)) mapOf(key() to value, "x" to word()) else listOf(value, scalar()) }

            return value
        }

        fun document(): Any? =
            when (int(16)) {
                0, 1, 2 -> envelope()
                3, 4 -> graph()
                5, 6 -> hit(0)
                7 -> List(int(30)) { hit(it) }
                8 -> nested(range(2, 7))
                9 -> scalar()
                10 -> flat()
                11 -> lists()
                12 -> chain(range(1, 80))
                13 -> mapOf(key() to text(range(1000, 6000)))
                14 -> List(int(300)) { scalar() }
                else -> envelope(count = int(4))
            }
    }

    private enum class Style { PRETTY, COMPACT, SPACED }

    private fun write(value: Any?, style: Style, random: Random): String = StringBuilder().also { writeValue(it, value, style, random, 0) }.toString()

    private fun gap(out: StringBuilder, style: Style, random: Random, depth: Int) {
        when (style) {
            Style.PRETTY -> {
                out.append('\n')
                repeat(depth) { out.append("  ") }
            }
            Style.COMPACT -> Unit
            Style.SPACED -> out.append(listOf("", " ", "\n", "\t", "\r\n", "  ")[random.nextInt(6)])
        }
    }

    private fun writeValue(out: StringBuilder, value: Any?, style: Style, random: Random, depth: Int) {
        when (value) {
            null -> out.append("null")
            is String -> out.append(quote(value))
            is Boolean, is Int, is Long, is Double -> out.append(value.toString())
            is Raw -> out.append(value.text)
            is Map<*, *> -> {
                if (value.isEmpty()) {
                    out.append("{}")

                    return
                }

                out.append('{')

                var separator = ""

                for ((key, member) in value) {
                    out.append(separator)
                    gap(out, style, random, depth + 1)
                    out.append(quote(key as String)).append(':')

                    if (style != Style.COMPACT) out.append(' ')

                    writeValue(out, member, style, random, depth + 1)

                    separator = ","
                }

                gap(out, style, random, depth)
                out.append('}')
            }
            is List<*> -> {
                if (value.isEmpty()) {
                    out.append("[]")

                    return
                }

                out.append('[')

                var separator = ""

                for (element in value) {
                    out.append(separator)
                    gap(out, style, random, depth + 1)
                    writeValue(out, element, style, random, depth + 1)

                    separator = ","
                }

                gap(out, style, random, depth)
                out.append(']')
            }
            else -> throw IllegalArgumentException("no JSON form for ${value::class}")
        }
    }

    /** What a damaged transfer or a different server does to a result, one way at a time. Cuts fall between code points. */
    private fun damage(text: String, docs: Documents): String {
        if (text.isEmpty()) return text

        fun snap(index: Int): Int = if (index in 1 until text.length && Character.isLowSurrogate(text[index]) && Character.isHighSurrogate(text[index - 1])) index - 1 else index

        val at = snap(docs.int(text.length))

        return when (docs.int(9)) {
            0 -> text.substring(0, at)
            1 -> text.removeRange(at, at + Character.charCount(text.codePointAt(at)))
            2 -> text.replaceFirst('"', '\'')
            3 -> text + docs.pick(listOf(" and then some", ", 1", "}", "]", "\n\nDone."))
            4 -> docs.pick(listOf("\uFEFF", ")]}'\n", "Here is the result: ", "{\"error\": ")) + text
            5 -> text.dropLast(1)
            6 -> text.replaceFirst("}", ",}").replaceFirst("]", ",]")
            7 -> text.replaceFirst(':', '=')
            else -> text.replaceFirst("\"", "\\")
        }
    }

    private fun budgetsFor(docs: Documents, size: Int): List<Int> =
        listOf(docs.pick(EDGE_BUDGETS), docs.pick(USUAL_BUDGETS), docs.pick(USUAL_BUDGETS), 64 + docs.int(3000), maxOf(0, size - docs.int(40)), size, size + 1)

    private fun resource(name: String): String =
        checkNotNull(javaClass.classLoader?.getResourceAsStream("synthetic-tool-results/$name")) { "no test resource $name" }
            .use { String(it.readBytes(), Charsets.UTF_8) }

    // ---- the tests --------------------------------------------------------------------------------

    @Test
    fun plain_documents_at_any_budget_hold_every_invariant_and_nothing_is_escaped() {
        runDocuments(exotic = false, damaged = false)
    }

    @Test
    fun exotic_documents_at_any_budget_hold_every_invariant() {
        runDocuments(exotic = true, damaged = false)
    }

    @Test
    fun damaged_plain_results_are_cut_as_text_or_shaped_as_json_never_something_between() {
        runDocuments(exotic = false, damaged = true)
    }

    @Test
    fun damaged_exotic_results_are_cut_as_text_or_shaped_as_json_never_something_between() {
        runDocuments(exotic = true, damaged = true)
    }

    private fun runDocuments(exotic: Boolean, damaged: Boolean) {
        var shapedJson = 0
        var cuts = 0

        for (index in 0 until DOCUMENTS) {
            val seed = SEED_BASE + index * 4L + (if (exotic) 2 else 0) + (if (damaged) 1 else 0)
            val docs = Documents(seed, exotic)
            val style = docs.pick(Style.values().toList())
            val written = write(docs.document(), style, docs.random)
            val text = if (damaged) damage(written, docs) else written
            val label = "document #$index (${if (exotic) "exotic" else "plain"}, $style${if (damaged) ", damaged" else ""}, seed $seed, ${utf8(text)} bytes)"
            val subject = subject(text, label, plain = !exotic)

            for (budget in budgetsFor(docs, utf8(text))) {
                val shaped = check(subject, budget)

                if (utf8(text) > maxOf(budget, ToolResultShaper.MINIMUM_BUDGET_BYTES) && subject.strings != null) {
                    if (StrictJsonCheck.isValid(shaped)) shapedJson++ else cuts++
                }
            }
        }

        // The run must have exercised the shaping, not only passed documents that fit or text that is not JSON. A
        // damaged document is mostly not JSON any more, so it asks for less.
        assertTrue("only $shapedJson results were shaped as JSON out of $DOCUMENTS documents", shapedJson > if (damaged) DOCUMENTS / 10 else DOCUMENTS / 2)

        if (!damaged) assertTrue("$cuts cuts: the last resort is for what nothing else can fit, not for most of what is sent", cuts < shapedJson)
    }

    @Test
    fun the_realistic_results_hold_every_invariant_at_every_budget() {
        val results =
            listOf(
                "heron" to resource("knowledge-search-heron.json"),
                "dentist" to resource("knowledge-search-dentist.json"),
                "graph" to resource("memory-recall-maria.json"),
            )

        for ((name, text) in results) {
            val subject = subject(text, "the synthetic $name result", plain = false)
            val budgets = (0..4_200 step 13).toList() + EDGE_BUDGETS + listOf(utf8(text) - 1, utf8(text), utf8(text) + 1)

            for (budget in budgets) check(subject, budget)
        }
    }

    @Test
    fun budgets_that_are_not_budgets_are_raised_to_the_least_one_never_trusted() {
        val budgets = listOf(Int.MIN_VALUE, -1_000_000, -1, 0, 1, 2, 63, 64, 65, 66, 95, 96, 97, 98, 255, 256, 257, 1 shl 20, Int.MAX_VALUE)

        for (index in 0 until 60) {
            val docs = Documents(SEED_BASE + 1_000_000 + index, exotic = index % 2 == 0)
            val text = write(docs.document(), docs.pick(Style.values().toList()), docs.random)
            val subject = subject(text, "document #$index (${utf8(text)} bytes)", plain = index % 2 == 1)

            for (budget in budgets) check(subject, budget)
        }

        val big = "x".repeat(1_000)

        assertEquals(ToolResultShaper.shape(big, ToolResultShaper.MINIMUM_BUDGET_BYTES), ToolResultShaper.shape(big, Int.MIN_VALUE))
        assertEquals(big, ToolResultShaper.shape(big, Int.MAX_VALUE))
    }

    @Test
    fun a_search_result_keeps_its_header_and_its_first_hits_in_order_and_counts_exactly_the_ones_it_left_out() {
        var shapedEnvelopes = 0

        for (index in 0 until ENVELOPES) {
            val docs = Documents(SEED_BASE + 2_000_000 + index, exotic = index % 2 == 0)
            val count = docs.range(2, 40)
            val envelope = docs.envelope(titled = true, count = count)
            val text = write(envelope, docs.pick(Style.values().toList()), docs.random)

            for (budget in budgetsFor(docs, utf8(text))) {
                val shaped = ToolResultShaper.shape(text, budget)

                if (utf8(text) <= maxOf(budget, ToolResultShaper.MINIMUM_BUDGET_BYTES) || !StrictJsonCheck.isValid(shaped)) continue

                val where = "envelope #$index of $count hits at a budget of $budget: ${shaped.take(160)}"
                val obj = JSONTokener(shaped).nextValue() as JSONObject
                val items = obj.getJSONArray("items")
                val last = items.get(items.length() - 1)
                val hits = (0 until items.length()).filter { items.get(it) is JSONObject }
                val omitted =
                    if (last is String) {
                        val note = closingNote.matchEntire(last)

                        assertNotNull("$where: what follows the hits is the closing note, not $last", note)

                        note!!.value.drop(1).takeWhile { it.isDigit() }.toInt()
                    } else {
                        0
                    }

                assertTrue("$where: the first hit is there", hits.isNotEmpty())
                assertEquals("$where: every element but a closing note is a hit", if (last is String) items.length() - 1 else items.length(), hits.size)
                assertEquals("$where: the hits are the first ones, in order", (0 until hits.size).map { "T$it" }, hits.map { items.getJSONObject(it).getString("title") })
                assertEquals("$where: the note counts exactly the hits that were left out", count, hits.size + omitted)
                assertEquals("$where: the header is kept", envelope["summary"], obj.getString("summary"))

                shapedEnvelopes++
            }
        }

        assertTrue("only $shapedEnvelopes envelopes were shaped", shapedEnvelopes > ENVELOPES)
    }

    @Test
    fun hostile_results_are_bounded_whatever_their_size_or_shape() {
        val megabyte = "x".repeat(1_000_000)
        val hostile =
            linkedMapOf(
                "one string of 1 MB" to quote(megabyte),
                "an object holding a string of 1 MB" to "{\"a\": ${quote(megabyte)}}",
                "an array of 20,000 small hits" to "[" + (0 until 20_000).joinToString(",") { "{\"type\":\"n\",\"title\":\"t$it\"}" } + "]",
                "an envelope of 10,000 hits" to "{\"summary\":\"s\",\"items\":[" + (0 until 10_000).joinToString(",") { "{\"type\":\"n\",\"title\":\"t$it\",\"content\":\"c$it\"}" } + "]}",
                "an object of 20,000 members" to "{" + (0 until 20_000).joinToString(",") { "\"k$it\":$it" } + "}",
                "an array of 100,000 numbers" to "[" + (0 until 100_000).joinToString(",") + "]",
                "a string of 100,000 escapes" to "\"" + "\\u0041".repeat(100_000) + "\"",
                "a list that never closes" to "[".repeat(1_000_000),
                "a list nested 513 deep" to "[".repeat(513) + quote(megabyte.take(2_000)) + "]".repeat(513),
                "an object nested 512 deep" to "{\"a\":".repeat(512) + quote(megabyte.take(2_000)) + "}".repeat(512),
            )

        for ((name, text) in hostile) {
            val subject = subject(text, name, plain = false)

            for (budget in listOf(0, 64, 512, 4_096)) check(subject, budget)
        }
    }

    @Test
    fun the_deepest_nesting_that_is_followed_never_overflows_the_stack_even_on_a_small_one() {
        val deep = "{\"a\":".repeat(512) + quote("x".repeat(3_000)) + "}".repeat(512)
        val subject = subject(deep, "512 nested objects", plain = false)

        // 512 levels of `{"a":` are 3,072 bytes before there is anything inside them: the budget must clear that.
        val budget = 5_000

        // 512 KB is about what the JVM needs for this (measured: 384 KB was not enough), so 128 KB overflows
        // inside the shaper, and the answer must be the plain cut, not an Error.
        for (kilobytes in listOf(128, 256, 4_096)) {
            var failure: Throwable? = null
            var shaped = ""

            // Only the shaping runs on the small stack: reading the answer back with org.json is recursive too.
            val thread =
                Thread(null, {
                    try {
                        shaped = ToolResultShaper.shape(deep, budget)
                    } catch (e: Throwable) {
                        failure = e
                    }
                }, "shape-on-a-${kilobytes}KB-stack", kilobytes * 1024L)

            thread.start()
            thread.join()

            assertNull("on a ${kilobytes}KB stack: $failure", failure)
            assertTrue("on a ${kilobytes}KB stack: within the budget (${utf8(shaped)} bytes)", utf8(shaped) <= budget)
            assertTrue("on a ${kilobytes}KB stack: JSON or a cut that says so", shaped.endsWith(marker) || StrictJsonCheck.isValid(shaped))

            if (kilobytes == 4_096) assertTrue("with room to spare it is shaped as JSON", StrictJsonCheck.isValid(shaped))
        }

        check(subject, budget)
    }

    // ---- the pieces, on text that is awkward ------------------------------------------------------

    private fun codePoints(vararg codes: Int): String = String(codes, 0, codes.size)

    /** Units that each read as ONE character, however they are made; separated by a space no unit can join. */
    private val characterUnits =
        listOf(
            "a", "é", "e" + codePoints(0x301), codePoints(0x8A18), codePoints(0x1F600), codePoints(0x1F1FA, 0x1F1F8),
            codePoints(0x1F468, 0x200D, 0x1F469, 0x200D, 0x1F467, 0x200D, 0x1F466), codePoints(0x1F44D, 0x1F3FD), "\r\n",
        )

    @Test
    fun characters_are_counted_as_a_reader_counts_them_and_a_cut_is_always_between_two_of_them() {
        val random = Random(SEED_BASE)

        for (round in 0 until 300) {
            val units = List(1 + random.nextInt(30)) { characterUnits[random.nextInt(characterUnits.size)] }
            val text = units.joinToString(" ")

            for (count in 0..(units.size * 2 + 1)) {
                // Unit, space, unit, space...: 2n - 1 characters hold n units.
                val whole = (count + 1) / 2
                val expected = if (count >= units.size * 2 - 1) text else units.take(whole).joinToString(" ") + if (count % 2 == 0 && count > 0) " " else ""

                assertEquals("the first $count characters of ${units.size} units", expected, Characters.take(text, count))
            }
        }
    }

    @Test
    fun a_cut_keeps_whole_characters_inside_the_budget_and_text_is_counted_as_utf8_would_count_it() {
        val random = Random(SEED_BASE + 1)

        for (round in 0 until 500) {
            val text = List(random.nextInt(60)) { characterUnits[random.nextInt(characterUnits.size)] }.joinToString(" ")

            assertEquals("the size of $text", text.toByteArray(Charsets.UTF_8).size, ToolResultShaper.utf8Length(text))

            for (budget in listOf(0, 1, 13, 14, 15, 16, 17, 20, 30, 64, 100, 300)) {
                val cut = ToolResultShaper.truncated(text, budget)

                if (utf8(text) <= budget) {
                    assertEquals(text, cut)
                } else {
                    assertTrue("a cut ends in the marker", cut.endsWith(marker))
                    assertTrue("a cut is the start of the text", text.startsWith(cut.removeSuffix(marker)))
                    assertTrue("a cut is within the budget or, below the marker's own size, is the marker alone (${utf8(cut)} of $budget)", utf8(cut) <= maxOf(budget, utf8(marker)))
                    assertEquals("no character is cut in half", cut, String(cut.toByteArray(Charsets.UTF_8), Charsets.UTF_8))
                }
            }
        }
    }

    private companion object {
        /** Documents per run of [runDocuments]; each is shaped at seven budgets. */
        const val DOCUMENTS = 250

        const val ENVELOPES = 120

        const val SEED_BASE = 20_261_003L

        /** The budgets that sit on an edge: the floor, either side of it, and where the reserve changes. */
        val EDGE_BUDGETS = listOf(0, 1, 63, 64, 65, 96, 97, 255, 256)

        val USUAL_BUDGETS = listOf(300, 400, 512, 700, 1024, 2048, 4096, 10_000)
    }
}
