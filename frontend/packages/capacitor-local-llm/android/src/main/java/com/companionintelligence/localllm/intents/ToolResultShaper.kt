package com.companionintelligence.localllm.intents

import java.math.BigDecimal
import java.text.Normalizer

/**
 * Bounds a tool's result before it goes back into the model's context window.
 *
 * The appliance answers a tool call with the whole result, pretty-printed — 25 hydrated entities from
 * `knowledge.search` is ~40 KB of JSON, which its own chat harness measured and now bounds with
 * `boundToolResultForPrompt` (`backend/apps/api/src/domains/llm/toolResultBudget.ts`). On the phone that text
 * went straight into a window that is a few thousand tokens at best, so it has to be cut. What survives the cut is
 * what the model reads, and measured on a device (`frontend/apps/ios/tests/local-llm-device`) the way it is cut
 * decides whether the answer is grounded. This is a function-for-function port of iOS's `ToolResultShaper`
 * (`LocalLLMPolicy.swift`): the two give the same text for the same input, so a change to one is a change to
 * the other, and to `src/test/resources/tool-result-swift-parity.json`, which
 * `scripts/regenerate-swift-parity.sh` rewrites from the Swift side. The design is theirs, and so are its reasons:
 *
 * - **An unset column is most of a hit.** The appliance writes every column of an entity, so a typical hit is
 *   `null`, `false`, `[]`, `{}` and foreign-key UUIDs around a few readable fields. They cost bytes and tell the
 *   model nothing, so they go first ([prune]).
 * - **What is left is written answer-first.** Identity (`type`, `link`, `title`…), then when, then what it says,
 *   then everything else shortest-first, then bookkeeping (`sourceId`, scores…). A hit that has to lose members
 *   loses them from the end, so the cut takes bookkeeping before the date.
 * - **The first few hits share the room.** One long hit gives the model one fact; three short ones give it three.
 *   Each of the first [MAXIMUM_BREADTH] hits is held to an equal share, shortening its strings a step at a time and
 *   only then dropping members.
 * - **Every list is bounded, not only `items`.** An object that carries lists keeps its other members (strings
 *   capped at 200) and gives each list an equal share of what is left ([lists]): `memory.recall`'s
 *   `{nodes, edges}` graph is two, and a few edges beside a few nodes say more about how people relate than every
 *   node and no edge. A list is an array of more than one element.
 * - **Never JSON inside a string.** The first version fell back to the hit's JSON *as a string* when it did not
 *   fit. A string result is written into the chat template escaped, and that one was escaped three times over:
 *   `\\\"type\\\"`. A hit stays an object, however few members it keeps.
 *
 * Through all of it the guarantees hold:
 *
 * - a result that already fits is returned untouched;
 * - the output is never longer than the budget, in UTF-8 bytes (those are what a token budget is estimated from),
 *   and a budget under [MINIMUM_BUDGET_BYTES] is raised to it;
 * - JSON in is JSON out — valid, never cut mid-token — from a budget big enough for a header, one hit and the
 *   closing note (about 340 bytes on the realistic results; the tests hold 400). A search envelope keeps its header
 *   and closes its list with an element that says how many results were left out, so the model knows the list was
 *   cut rather than exhaustive. The note's own size is held back exactly, for the count it will actually carry
 *   ([bound], [omissionNote]), not guessed at as a share of the budget, so it can no longer itself be the reason a
 *   budget that should have been enough was not;
 * - anything that is not JSON — or is nested deeper than [MAXIMUM_PARSE_DEPTH], which this port's own reader cannot
 *   be trusted with on a small stack any more than `JSONSerialization` can on iOS's — is cut at the budget on a
 *   character boundary and says so, as is JSON under that budget (a header too big for its own object, or a list
 *   whose first hit cannot be made to fit).
 *
 * **Why JSON is read and written here instead of by `org.json`.** Writing: `JSONObject.toString()` escapes
 * every `/` (a byte apiece in every link), keeps keys in insertion order where this puts what identifies an
 * object first, and throws on a non-finite number. Reading: Android's `JSONTokener` is lenient on purpose — its
 * own documentation says "a successful parse does not indicate that the input string was valid JSON". It takes
 * unquoted words and `'single quotes'`, skips comments, and stops after the first value without looking at
 * what follows, so `plain words` would "parse" as the string `plain` and the not-JSON fallback above could
 * never be reached. iOS's `JSONSerialization` is strict, so this reads strict JSON (RFC 8259) too. It also
 * keeps integers exact where `org.json` turns every one past `Long` into a rounded `Double`.
 *
 * **Where the two platforms can still differ.** Measured against a Swift build of the same shaper over ~150,000
 * inputs, which agreed byte for byte on all but 0.1%, and every difference was one of these:
 * - what counts as one character, which both platforms take from their Unicode tables and the JDK's are older:
 *   a code point it leaves unassigned is not joined to the mark after it, a Devanagari conjunct is not one
 *   character, and a double ZWJ inside an emoji sequence is joined where UAX #29 and Swift break;
 * - the last digit of a 17-digit double, which Foundation sometimes reads one step off, and a subnormal such as
 *   `5e-324`, which Java only writes with two digits;
 * - two things `JSONSerialization` forgives that the strict reader here does not, so that text is cut as text:
 *   a trailing comma and a byte-order mark;
 * - a number that overflows a double (`1e999`), which has no JSON form: iOS cuts the text as it was sent, here
 *   the hits before the first one that holds such a number are written and the list is closed as usual.
 *
 * Two keys that are canonically equivalent but not identical (a precomposed and a decomposed accented letter) used
 * to be a third way the platforms could differ: Swift's own `<` treats them as equal, so the order between them
 * fell through to a Swift dictionary's random per-process order, which this port could never reproduce. [members]
 * now breaks that tie the same way Swift does, on the raw (not normalised) code points of the key, so the two
 * platforms agree on it deterministically instead of only on average.
 *
 * One thing is only here, and changes no answer iOS could give: a `StackOverflowError` from a result nested deeper
 * than this port's own reader can safely recurse through is answered with a cut of the text, not thrown. In
 * practice nothing reaches that far — [nests] refuses anything nested past [MAXIMUM_PARSE_DEPTH] before the reader
 * ever sees it — but the catch stays as the backstop for a JVM whose stack margins turn out smaller than measured.
 */
object ToolResultShaper {
    /** Below this a budget cannot hold the markers, so it is raised to it. */
    const val MINIMUM_BUDGET_BYTES = 64

    const val TRUNCATION_MARKER = "…[truncated]"

    /**
     * The closing element of a list that lost hits, and its size: held back, exactly, so it cannot itself overflow.
     * Used to be guessed at as a share of the budget ([bound] sized a reserve of `min(96, budget / 6)` for it,
     * which a small list's note could still overshoot by a few bytes); now [bound] tries every hit first with
     * nothing held back, and only when some are left out does it reserve exactly this string's size, for the
     * count it will actually carry.
     */
    private fun omissionNote(omitted: Int): String = quoted("[$omitted more results omitted — refine the query to narrow them down]")

    /**
     * The deepest a value is kept. Real results are under ten levels deep; a nested object is written by
     * recursion, and a deep one overflowed a 512 KB stack (400 levels), which neither platform can catch cheaply
     * once it happens. Anything deeper is dropped, so nothing the shaper recurses into below [prune] is deeper
     * than this.
     */
    const val MAXIMUM_DEPTH = 16

    /** How many leading hits share the room at most, and the least one is given before fewer share it. */
    const val MAXIMUM_BREADTH = 3
    private const val MINIMUM_SHARE_BYTES = 220

    /** How long a string may be, longest first; a hit over its share steps down this list. */
    private val STRING_CAPS = listOf(320, 200, 140, 100, 70, 50, 36, 24)

    /** A hit that has to lose members keeps at least this many: what it is, where it lives, what it is called. */
    private const val MINIMUM_MEMBERS = 3

    /** The cap on the strings of an envelope's own header (its summary is one sentence). */
    private const val HEADER_STRING_CAP = 200

    /**
     * The deepest a document may be and still be handed to [StrictJsonReader]: the reader recurses, and so does
     * everything after it, so an unbounded depth is a `StackOverflowError` on the thread LiteRT-LM called the tool
     * from. [nests] refuses anything deeper than this, by a byte-level scan, before the reader (or anything after
     * it) ever recurses once — the same role iOS's guard plays ahead of `JSONSerialization`, which overflowed a
     * 512 KB stack at 512 levels of nesting (a 256 KB one at 400). A deeper document is cut as text, which is what
     * anything that is not JSON gets. Kept equal to iOS's own limit: both are generous margins above what a real
     * result nests (under ten levels), so there is no reason to measure a different number for the JVM.
     */
    const val MAXIMUM_PARSE_DEPTH = 64

    fun shape(text: String, budgetBytes: Int): String {
        val budget = maxOf(budgetBytes, MINIMUM_BUDGET_BYTES)

        if (utf8Length(text) <= budget) return text

        return try {
            shapeJson(text, budget)
        } catch (e: StackOverflowError) {
            // Nothing reaches this in practice: nests() below refuses anything nested past MAXIMUM_PARSE_DEPTH
            // before the reader (or prune, or the writer) ever recurses once. It stays as a backstop in case a
            // thread's stack margin turns out smaller than measured. An Error that nothing catches ends the
            // process; what cannot be shaped is cut like any other text.
            truncated(text, budget)
        }
    }

    private fun shapeJson(text: String, budget: Int): String {
        if (!nests(text, MAXIMUM_PARSE_DEPTH)) return truncated(text, budget)

        val document = StrictJsonReader(text).readDocument() ?: return truncated(text, budget)
        val pruned = prune(document.value)

        val shaped: String? =
            when (pruned) {
                is ParsedArray -> bound(pruned.elements, "[", "]", budget)
                is ParsedObject -> lists(pruned, budget)
                null -> if (document.value is ParsedArray) "[]" else "{}"
                else -> json(capStrings(pruned, STRING_CAPS[0]))
            }

        // A capped-but-broken tail beats an overflowed window, which loses the whole turn. What is cut is the
        // pruned, compact text where there is one: several times denser than what the appliance sent.
        if (shaped == null) return truncated(pruned?.let { json(it) } ?: text, budget)

        return if (utf8Length(shaped) <= budget) shaped else truncated(shaped, budget)
    }

    /**
     * Whether the brackets of [text] nest no deeper than [limit], counted without parsing: a string's contents
     * (and an escaped quote in it) are skipped, everything else that opens or closes a container is counted. A
     * flat scan, so it cannot itself overflow a stack however deep (or long) the text actually is — unlike asking
     * the reader to find out, which is what it stands guard in front of.
     */
    private fun nests(text: String, limit: Int): Boolean {
        var depth = 0
        var inString = false
        var escaped = false

        for (unit in text) {
            if (inString) {
                when {
                    escaped -> escaped = false
                    unit == '\\' -> escaped = true
                    unit == '"' -> inString = false
                }

                continue
            }

            when (unit) {
                '"' -> inString = true
                '{', '[' -> {
                    depth++

                    if (depth > limit) return false
                }
                '}', ']' -> depth--
            }
        }

        return true
    }

    /** Cuts [text] to [budget] bytes, at a character boundary, ending in [TRUNCATION_MARKER]. */
    fun truncated(text: String, budget: Int): String {
        if (utf8Length(text) <= budget) return text

        val room = maxOf(0, budget - utf8Length(TRUNCATION_MARKER))
        var used = 0
        var end = 0

        while (end < text.length) {
            val codePoint = text.codePointAt(end)
            val width = utf8Width(codePoint)

            if (used + width > room) break

            used += width
            end += Character.charCount(codePoint)
        }

        return text.substring(0, end) + TRUNCATION_MARKER
    }

    /**
     * The size of [text] encoded as UTF-8, which is what a budget is spent in. A lone surrogate has no UTF-8
     * form; it counts as the three bytes it could at most take.
     */
    internal fun utf8Length(text: String): Int {
        var bytes = 0
        var index = 0

        while (index < text.length) {
            val unit = text[index]

            bytes +=
                when {
                    unit.code < 0x80 -> 1
                    unit.code < 0x800 -> 2
                    Character.isHighSurrogate(unit) && index + 1 < text.length && Character.isLowSurrogate(text[index + 1]) -> {
                        index++
                        4
                    }
                    else -> 3
                }
            index++
        }

        return bytes
    }

    private fun utf8Width(codePoint: Int): Int =
        when {
            codePoint < 0x80 -> 1
            codePoint < 0x800 -> 2
            codePoint < 0x10000 -> 3
            else -> 4
        }

    // ---- pruning ------------------------------------------------------------------------------

    /**
     * Removes what tells the model nothing, recursively; null when nothing is left.
     *
     * - `null`, `""`, `false`, `[]` and `{}`: an unset column.
     * - a string that is a bare UUID, except an `id` that is the hit's only address: a foreign key (`threadId`,
     *   `connectionId`, `userId`…). The model cannot read one and no tool it has takes an id.
     * - `id` when the hit has a `link`, which already carries it, and `entityType` next to a `type`.
     *
     * Numbers, `true` and every non-empty string stay, and so does the order of an array. A container deeper
     * than [MAXIMUM_DEPTH] goes.
     */
    private fun prune(value: Any?, depth: Int = 0): Any? =
        when (value) {
            is String -> if (value.isEmpty()) null else value
            is ParsedArray -> pruneArray(value, depth)
            is ParsedObject -> pruneObject(value, depth)
            is Boolean -> if (value) value else null
            else -> value
        }

    private fun pruneArray(array: ParsedArray, depth: Int): ParsedArray? {
        if (depth >= MAXIMUM_DEPTH) return null

        val kept = ArrayList<Any?>()

        for (element in array.elements) {
            if (element is String && isUuid(element)) continue

            kept.add(prune(element, depth + 1) ?: continue)
        }

        return if (kept.isEmpty()) null else ParsedArray(kept)
    }

    private fun pruneObject(obj: ParsedObject, depth: Int): ParsedObject? {
        if (depth >= MAXIMUM_DEPTH) return null

        val members = obj.members

        // Only a link and a type that survive make the id and the entityType redundant: an empty `link` and a
        // null `type` are pruned themselves, and dropping the id or entityType beside them left nothing at all.
        val linked = (members["link"] as? String)?.isNotEmpty() ?: false
        val typed = members["type"]?.let { prune(it, depth + 1) } != null
        val kept = LinkedHashMap<String, Any?>()

        for ((key, member) in members) {
            if (key == "entityType" && typed) continue
            if (key == "id" && linked) continue
            if (member is String && key != "id" && key != "link" && isUuid(member)) continue

            kept[key] = (if (key in TIME_KEYS && member is String) renderedTime(member) else prune(member, depth + 1)) ?: continue
        }

        return if (kept.isEmpty()) null else ParsedObject(kept)
    }

    /** The canonical `8-4-4-4-12` hex form, in either case: what `UUID(uuidString:)` reads on iOS. */
    private fun isUuid(string: String): Boolean {
        if (string.length != 36) return false

        for (index in 0 until 36) {
            val unit = string[index]

            if (index == 8 || index == 13 || index == 18 || index == 23) {
                if (unit != '-') return false
            } else if (unit !in '0'..'9' && unit !in 'a'..'f' && unit !in 'A'..'F') {
                return false
            }
        }

        return true
    }

    // ---- fitting ------------------------------------------------------------------------------

    /**
     * An object that carries lists: the members that are not lists whole (strings capped, `summary` first — the one
     * sentence a small model reads reliably), then each list bounded to an equal share of what the rest left. A search
     * envelope (`{summary, …, items:[…]}`) is the one-list case; `memory.recall`'s graph (`{nodes:[…], edges:[…]}`) is
     * two, and keeping a few edges beside a few nodes beats keeping every node and no edge, because the edges are
     * what says how the people relate. An object with no list is [fit].
     *
     * A list is an array of two or more things with parts of their own — hits, nodes, edges. An array of plain
     * values (`tags`, `labels`) is one member of the object it is in, and is dropped like one when the object has
     * to lose members ([isList]): treating it as a list left the object's other members written whole.
     */
    private fun lists(obj: ParsedObject, budget: Int): String? {
        // `items` first, then the rest by the order `members` writes them in, then by name.
        val listKeys =
            obj.members
                .filter { isList(it.value) }
                .keys
                .sortedWith { lhs, rhs ->
                    val left = if (lhs == "items") -1 else rank(lhs)
                    val right = if (rhs == "items") -1 else rank(rhs)

                    if (left != right) {
                        left.compareTo(right)
                    } else {
                        compareCodePoints(Normalizer.normalize(lhs, Normalizer.Form.NFC), Normalizer.normalize(rhs, Normalizer.Form.NFC))
                    }
                }

        if (listKeys.isEmpty()) return fit(obj, budget)

        val header = ParsedObject(obj.members - listKeys.toSet())
        val capped = capStrings(header, HEADER_STRING_CAP) as ParsedObject
        val written = if (header.members.isEmpty()) emptyList() else members(capped) ?: return null

        val text = StringBuilder("{")

        for (member in written) text.append(member).append(',')

        var room = budget - utf8Length(text.toString()) - 1 // the closing brace

        for ((index, key) in listKeys.withIndex()) {
            val items = obj.members[key] as? ParsedArray ?: return null
            val share = room / (listKeys.size - index)
            val list = bound(items.elements, quoted(key) + ":[", "]", share) ?: return null

            text.append(list)

            if (index < listKeys.size - 1) text.append(',')

            room -= utf8Length(list) + 1
        }

        return text.append('}').toString()
    }

    /**
     * A list is an array of more than one element where at least one of them is itself an object: hits, nodes,
     * edges have parts of their own. An array of plain values (`tags: ["a","b"]`) is not — it stays an ordinary
     * member of its parent object, written whole by [json]/[members], and is subject to member-dropping like any
     * other member when the parent object has to lose some.
     */
    private fun isList(value: Any?): Boolean {
        val array = value as? ParsedArray ?: return false

        if (array.elements.size <= 1) return false

        return array.elements.any { it is ParsedObject }
    }

    /**
     * Leading hits written in `lead … tail`, each held to an equal share of the room (the first
     * [MAXIMUM_BREADTH] of them; the rest take what is left), then a closing element saying how many were left
     * out. Null when not even the first hit can be made to fit. [lead] and [tail] are the list's own text, brackets
     * included: `[` and `]` for a bare list, `"items":[` and `]` inside an object.
     */
    private fun bound(items: List<Any?>, lead: String, tail: String, budget: Int): String? {
        val frame = utf8Length(lead) + utf8Length(tail)

        // First every hit, with nothing held back: when all of them fit there is no note to make room for.
        val everything = take(items, budget - frame)

        if (everything.size == items.size) return lead + everything.joinToString(",") + tail

        // Otherwise some are left out, and the closing note has to fit as well: room for it (and the comma
        // before it) is held back, sized for the largest count it could carry, so it cannot overflow.
        val note = omissionNote(items.size)
        val kept = take(items, budget - frame - utf8Length(note) - 1)

        if (kept.isEmpty() && items.isNotEmpty()) return null
        if (items.size <= kept.size) return lead + kept.joinToString(",") + tail

        val closing = omissionNote(items.size - kept.size)

        return lead + (kept + closing).joinToString(",") + tail
    }

    /** The leading hits that fit in [room], each as JSON, the first [MAXIMUM_BREADTH] held to an equal share. */
    private fun take(items: List<Any?>, room: Int): List<String> {
        var remaining = room
        val breadth = breadth(items.size, remaining)
        val kept = ArrayList<String>()

        for ((index, item) in items.withIndex()) {
            val separator = if (kept.isEmpty()) 0 else 1
            val share = if (index < breadth) remaining / (breadth - index) else remaining

            val text = fit(item, share - separator) ?: break

            kept.add(text)
            remaining -= utf8Length(text) + separator
        }

        return kept
    }

    /**
     * How many hits share [room]: [MAXIMUM_BREADTH], fewer when a share would be under [MINIMUM_SHARE_BYTES] — two
     * readable hits beat three that are only addresses.
     */
    private fun breadth(count: Int, room: Int): Int {
        var breadth = minOf(MAXIMUM_BREADTH, maxOf(count, 1))

        while (breadth > 1 && room / breadth < MINIMUM_SHARE_BYTES) breadth--

        return breadth
    }

    /**
     * [item] as compact JSON in at most [limit] bytes: whole if it fits, else with its strings shortened a step
     * at a time, else with members dropped from the end of its order, never below [MINIMUM_MEMBERS]. A string
     * element becomes a quoted string, so every hit is a JSON value.
     */
    private fun fit(item: Any?, limit: Int): String? {
        if (limit <= 0) return null

        for (cap in STRING_CAPS) {
            val text = json(capStrings(item, cap)) ?: return null

            if (utf8Length(text) <= limit) return text
        }

        val obj = item as? ParsedObject ?: return null
        val ordered = members(capStrings(obj, STRING_CAPS.last()) as ParsedObject) ?: return null

        // The longest run of leading members that fits, in one pass: measuring every prefix afresh is quadratic,
        // and 8,000 members took 45 seconds. `ordered.size` itself is never the answer (the whole object, at this
        // same string cap, was already tried and failed above), but letting the loop run over it costs nothing
        // and keeps this the same shape as the Swift it is ported from.
        var size = 2 // the braces
        var keep = 0

        for ((index, member) in ordered.withIndex()) {
            size += utf8Length(member) + (if (index > 0) 1 else 0)

            if (size > limit) break

            keep = index + 1
        }

        if (keep < MINIMUM_MEMBERS) return null

        return ordered.subList(0, keep).joinToString(",", "{", "}")
    }

    /**
     * Caps every string in [value] at [cap] characters. A communication's `content` is unbounded; the model needs
     * the gist and the identifiers, not the transcript. A `link` is only useful whole, and it is short: it is never
     * shortened.
     *
     * A character is what a reader sees as one — an extended grapheme cluster, so a flag, a family emoji, a
     * letter with its accent or a CR LF pair counts once and is never cut through — which is what Swift's
     * `String.count` counts on the iOS side.
     */
    private fun capStrings(value: Any?, cap: Int): Any? =
        when (value) {
            is String -> {
                val head = Characters.take(value, cap)

                if (head.length < value.length) "$head…" else value
            }
            is ParsedArray -> ParsedArray(value.elements.map { capStrings(it, cap) })
            is ParsedObject ->
                ParsedObject(
                    value.members.mapValues { (key, member) -> if (key == "link" && member is String) member else capStrings(member, cap) },
                )
            else -> value
        }

    // ---- writing JSON -------------------------------------------------------------------------

    /**
     * Compact JSON for a parsed value, or null when it has none (a non-finite number).
     *
     * Written out here instead of through `JSONObject.toString()` — see the type's comment — so that [members]
     * decides the order of an object's keys: what identifies an object first, so a cut that has to lose something
     * loses bookkeeping before the identifiers.
     */
    private fun json(value: Any?): String? =
        when (value) {
            null -> "null"
            is String -> quoted(value)
            is Boolean -> if (value) "true" else "false"
            is ParsedNumber -> value.text
            is ParsedArray -> elements(value)
            is ParsedObject -> members(value)?.joinToString(",", "{", "}")
            else -> null
        }

    private fun elements(array: ParsedArray): String? {
        val written = ArrayList<String>(array.elements.size)

        for (element in array.elements) {
            written.add(json(element) ?: return null)
        }

        return written.joinToString(",", "[", "]")
    }

    /**
     * Keys written ahead of every other, in this order. `summary` is the search envelope's one sentence, which a
     * small model reads reliably; `type` and `link` are on every search hit (the appliance adds them) and `link`
     * is the only address the model may hand the user; `title`, `name` and `subject` are what the entities call
     * themselves.
     */
    private val IDENTITY_KEYS = listOf("summary", "type", "link", "title", "name", "subject")

    /** When it happened, then what it says: the two things a question about the user's own memory asks. */
    private val TIME_KEYS = listOf("startTime", "endTime", "time", "dueDate", "date", "createdAt", "takenAt", "birthDate")
    /**
     * An ISO 8601 instant as the appliance writes one (`2022-11-28T06:45:59.000Z`, with or without fractional
     * seconds, `Z` or an offset), captured as the date, the hour-and-minute and the offset part.
     */
    private val ISO_INSTANT = Regex("^(\\d{4}-\\d{2}-\\d{2})T(\\d{2}:\\d{2})(?::\\d{2}(?:\\.\\d+)?)?(Z|[+-]\\d{2}:?\\d{2})$")

    /**
     * A time key's value as the model should read it: `2022-11-28 06:45 UTC` for an instant, a date (`1980-01-01`)
     * untouched, anything else as it came. On a device a 2B model copying the 24-character instant wrote
     * `20202-1-128T06:5:59.00Z` and `2022-9-2519:4:1.0.0Z`; it copies a 16-character date-and-minute. Seconds and
     * milliseconds answer no question a chat asks. The instant is NOT converted to local time: both platforms
     * must shape identically wherever the phone is, and an offset is written out as it came so nothing is lost.
     */
    private fun renderedTime(value: String): String? {
        if (value.isEmpty()) return null

        val match = ISO_INSTANT.matchEntire(value) ?: return value
        val (date, clock, zone) = match.destructured

        return if (zone == "Z") "$date $clock UTC" else "$date $clock $zone"
    }
    private val BODY_KEYS = listOf("content", "text", "description", "notes")

    /**
     * What the appliance stores with every row and a question never asks about. Written last, so a hit that has
     * to lose members loses these first. They stay in when there is room: nothing here is wrong, only rarely the
     * answer.
     */
    private val BOOKKEEPING_KEYS =
        setOf(
            "id", "updatedAt", "sourceId", "sourceType", "sourceSystem", "externalId", "externalIdKind",
            "timeSource", "timePrecision", "sentimentScore", "importanceScore", "urgencyScore",
            "energyLevel", "confidenceScore", "isInferred", "isPredicted", "inferenceSources", "metadata",
            "searchContent", "preview", "isActive", "isSelf", "mimeCategory", "mimetype", "priority",
            "communicationType", "importance",
        )

    /**
     * Where a key sorts: identity (0), then time (1), then body (2), then everything unknown (3), then bookkeeping
     * (4) — the group in the hundreds, the place within a listed group in the units.
     */
    private fun rank(key: String): Int {
        val identity = IDENTITY_KEYS.indexOf(key)
        if (identity >= 0) return identity

        val time = TIME_KEYS.indexOf(key)
        if (time >= 0) return 100 + time

        val body = BODY_KEYS.indexOf(key)
        if (body >= 0) return 200 + body

        return if (key in BOOKKEEPING_KEYS) 400 else 300
    }

    /**
     * An object's members as `"key":value` text in the order of [rank]; within a group the shortest value first
     * (ties by key). Null when any value has no JSON form.
     */
    private fun members(obj: ParsedObject): List<String>? {
        class Entry(val key: String, val order: String, val size: Int, val member: String)

        val entries = ArrayList<Entry>(obj.members.size)

        for ((key, value) in obj.members) {
            val text = json(value) ?: return null

            entries.add(Entry(key, Normalizer.normalize(key, Normalizer.Form.NFC), utf8Length(text), "${quoted(key)}:$text"))
        }

        entries.sortWith { lhs, rhs ->
            when {
                rank(lhs.key) != rank(rhs.key) -> rank(lhs.key).compareTo(rank(rhs.key))
                lhs.size != rhs.size -> lhs.size.compareTo(rhs.size)
                else -> {
                    // Swift's `<` is canonical: a precomposed and a decomposed form of the same letter compare
                    // equal under it (so the NFC-normalised compare below, this port's approximation of that,
                    // also reports them equal) and the order between them used to fall through to a Swift
                    // dictionary's random per-process iteration order. A second, raw (not normalised) code-point
                    // compare breaks that tie the same way Swift now does, so the two platforms agree
                    // deterministically instead of only on average.
                    val canonical = compareCodePoints(lhs.order, rhs.order)

                    if (canonical != 0) canonical else compareCodePoints(lhs.key, rhs.key)
                }
            }
        }

        return entries.map { it.member }
    }

    /**
     * Keys are ordered by their Unicode scalars after normalisation (see `Entry.order`), which is how Swift's
     * `String <` orders them — not by UTF-16 units, which would put U+FF5E after U+1F600, and not as written,
     * which would put a decomposed `é` before `m`.
     */
    private fun compareCodePoints(lhs: String, rhs: String): Int {
        var left = 0
        var right = 0

        while (left < lhs.length && right < rhs.length) {
            val a = lhs.codePointAt(left)
            val b = rhs.codePointAt(right)

            if (a != b) return a.compareTo(b)

            left += Character.charCount(a)
            right += Character.charCount(b)
        }

        return (lhs.length - left).compareTo(rhs.length - right)
    }

    /**
     * A string as a JSON literal. Slashes stay as they are: `\/` costs a byte apiece in every link. Everything
     * outside the ASCII control range is written as it is, not as `\uXXXX`.
     */
    private fun quoted(string: String): String {
        val out = StringBuilder(string.length + 2)

        out.append('"')

        var index = 0

        while (index < string.length) {
            val unit = string[index]

            when {
                unit == '"' -> out.append("\\\"")
                unit == '\\' -> out.append("\\\\")
                unit == '\n' -> out.append("\\n")
                unit == '\r' -> out.append("\\r")
                unit == '\t' -> out.append("\\t")
                unit == '\b' -> out.append("\\b")
                unit == '\u000C' -> out.append("\\f")
                unit < ' ' -> out.append("\\u00").append(HEX[unit.code shr 4]).append(HEX[unit.code and 0xF])
                Character.isHighSurrogate(unit) && index + 1 < string.length && Character.isLowSurrogate(string[index + 1]) -> {
                    out.append(unit).append(string[index + 1])
                    index++
                }
                // A half with no partner has no UTF-8 form; it is not worth a malformed response.
                Character.isSurrogate(unit) -> out.append('\uFFFD')
                else -> out.append(unit)
            }
            index++
        }

        return out.append('"').toString()
    }

    private const val HEX = "0123456789abcdef"

    /** 2^53: the largest magnitude Swift writes without an exponent. */
    private const val MAX_PLAIN_DOUBLE = 9007199254740992.0

    /**
     * Swift's `Double.description`, which is what iOS writes a number as: the shortest digits that read back
     * (so 0.8123, never 0.81230000000000002), `1.0` for a whole number, and an exponent (`1e-05`, `9.5e+15`)
     * below 0.0001 and above 2^53. Java supplies the digits; only the layout is Swift's.
     */
    private fun shortest(value: Double): String {
        if (value == 0.0) return if (1.0 / value < 0) "-0.0" else "0.0"

        val decimal = BigDecimal(java.lang.Double.toString(Math.abs(value))).stripTrailingZeros()
        val digits = decimal.unscaledValue().toString()
        val exponent = digits.length - decimal.scale() // value = 0.<digits> × 10^exponent
        val sign = if (value < 0) "-" else ""

        if (exponent >= -3 && Math.abs(value) <= MAX_PLAIN_DOUBLE) {
            return sign +
                when {
                    exponent <= 0 -> "0." + "0".repeat(-exponent) + digits
                    exponent < digits.length -> digits.substring(0, exponent) + "." + digits.substring(exponent)
                    else -> digits + "0".repeat(exponent - digits.length) + ".0"
                }
        }

        val mantissa = if (digits.length == 1) digits else "${digits[0]}.${digits.substring(1)}"
        val power = exponent - 1

        return sign + mantissa + "e" + (if (power < 0) "-" else "+") + Math.abs(power).toString().padStart(2, '0')
    }

    // ---- reading JSON -------------------------------------------------------------------------

    /**
     * What the reader produces, so that nothing outside this file handles `org.json`'s sentinels: `null` for JSON
     * `null`, [String], [Boolean], [ParsedNumber], [ParsedArray] and [ParsedObject].
     */
    private class ParsedDocument(val value: Any?)

    private class ParsedArray(val elements: List<Any?>)

    /** In document order; a repeated key keeps its first value. */
    private class ParsedObject(val members: Map<String, Any?>)

    /** A number as it is written back: its [text], or null when JSON has no form for it (it overflows a double). */
    private class ParsedNumber(val text: String?)

    /** Thrown by the reader at the first thing that is not strict JSON. Control flow, not a diagnostic. */
    private object NotJson : RuntimeException() {
        // Nothing reads the trace, and this is thrown for every result that is not JSON.
        override fun fillInStackTrace(): Throwable = this
    }

    /**
     * A strict JSON reader (RFC 8259): no comments, no trailing commas, no unquoted keys or words, nothing after
     * the value but whitespace, no lone surrogate escapes, and nesting no deeper than [MAXIMUM_PARSE_DEPTH]. Any
     * scalar may stand alone, as `JSONSerialization` with `.fragmentsAllowed` reads it on iOS.
     *
     * [shapeJson] never lets this reader see anything nested past [MAXIMUM_PARSE_DEPTH] in the first place
     * ([nests] refuses it first), so the check below is a second, redundant guard — in case the two ever drift,
     * recursing to the limit a byte-level scan already ruled out is still cheap.
     *
     * An integer that fits `Long` — or, if it is not negative, an unsigned 64-bit one — is kept as written, and
     * anything else goes through a `Double`; this is how `NSNumber` holds them on iOS, which is why a number
     * comes out the way Swift prints it ([shortest]).
     */
    private class StrictJsonReader(private val text: String) {
        private var position = 0

        /** The whole text as one value, or null when it is not strict JSON. */
        fun readDocument(): ParsedDocument? =
            try {
                skipWhitespace()

                val value = readValue(0)

                skipWhitespace()

                if (position == text.length) ParsedDocument(value) else null
            } catch (e: NotJson) {
                null
            }

        /** [depth] is how many containers enclose the value; one more than [MAXIMUM_PARSE_DEPTH] deep is refused. */
        private fun readValue(depth: Int): Any? {
            if (depth > MAXIMUM_PARSE_DEPTH || position >= text.length) throw NotJson

            return when (text[position]) {
                '{' -> readObject(depth)
                '[' -> readArray(depth)
                '"' -> readString()
                't' -> readWord("true", true)
                'f' -> readWord("false", false)
                'n' -> readWord("null", null)
                else -> readNumber()
            }
        }

        private fun readWord(word: String, value: Any?): Any? {
            if (!text.startsWith(word, position)) throw NotJson

            position += word.length

            return value
        }

        private fun readObject(depth: Int): ParsedObject {
            position++ // {

            val members = LinkedHashMap<String, Any?>()

            skipWhitespace()

            if (peek() == '}') {
                position++

                return ParsedObject(members)
            }

            while (true) {
                skipWhitespace()

                if (peek() != '"') throw NotJson

                val key = readString()

                skipWhitespace()
                expect(':')
                skipWhitespace()

                val value = readValue(depth + 1)

                // The first of a repeated key wins, as in `JSONSerialization` on iOS.
                if (!members.containsKey(key)) members[key] = value

                skipWhitespace()

                when (next()) {
                    ',' -> continue
                    '}' -> return ParsedObject(members)
                    else -> throw NotJson
                }
            }
        }

        private fun readArray(depth: Int): ParsedArray {
            position++ // [

            val elements = ArrayList<Any?>()

            skipWhitespace()

            if (peek() == ']') {
                position++

                return ParsedArray(elements)
            }

            while (true) {
                skipWhitespace()

                elements.add(readValue(depth + 1))

                skipWhitespace()

                when (next()) {
                    ',' -> continue
                    ']' -> return ParsedArray(elements)
                    else -> throw NotJson
                }
            }
        }

        private fun readString(): String {
            position++ // the opening quote

            val out = StringBuilder()

            while (true) {
                if (position >= text.length) throw NotJson

                val unit = text[position++]

                when {
                    unit == '"' -> return out.toString()
                    unit == '\\' -> readEscape(out)
                    unit < ' ' -> throw NotJson
                    else -> out.append(unit)
                }
            }
        }

        private fun readEscape(out: StringBuilder) {
            when (next()) {
                '"' -> out.append('"')
                '\\' -> out.append('\\')
                '/' -> out.append('/')
                'b' -> out.append('\b')
                'f' -> out.append('\u000C')
                'n' -> out.append('\n')
                'r' -> out.append('\r')
                't' -> out.append('\t')
                'u' -> {
                    val unit = readHexUnit()

                    when {
                        Character.isHighSurrogate(unit) -> {
                            // Only half a character unless its other half follows as an escape of its own.
                            if (!text.startsWith("\\u", position)) throw NotJson

                            position += 2

                            val low = readHexUnit()

                            if (!Character.isLowSurrogate(low)) throw NotJson

                            out.append(unit).append(low)
                        }
                        Character.isLowSurrogate(unit) -> throw NotJson
                        else -> out.append(unit)
                    }
                }
                else -> throw NotJson
            }
        }

        private fun readHexUnit(): Char {
            if (position + 4 > text.length) throw NotJson

            var unit = 0

            repeat(4) {
                val digit =
                    when (val c = text[position++]) {
                        in '0'..'9' -> c - '0'
                        in 'a'..'f' -> c - 'a' + 10
                        in 'A'..'F' -> c - 'A' + 10
                        else -> throw NotJson
                    }

                unit = unit * 16 + digit
            }

            return unit.toChar()
        }

        private fun readNumber(): ParsedNumber {
            val start = position
            var integral = true

            if (peek() == '-') position++

            when (peek()) {
                '0' -> position++
                in '1'..'9' -> skipDigits()
                else -> throw NotJson
            }

            if (peek() == '.') {
                integral = false
                position++
                requireDigits()
            }

            if (peek() == 'e' || peek() == 'E') {
                integral = false
                position++

                if (peek() == '+' || peek() == '-') position++

                requireDigits()
            }

            return ParsedNumber(format(text.substring(start, position), integral))
        }

        private fun format(literal: String, integral: Boolean): String? {
            if (integral) {
                literal.toLongOrNull()?.let { return it.toString() }

                if (!literal.startsWith('-') && literal.toULongOrNull() != null) return literal
            }

            val value = literal.toDouble()

            return if (value.isFinite()) shortest(value) else null
        }

        private fun skipDigits() {
            while (peek() in '0'..'9') position++
        }

        private fun requireDigits() {
            if (peek() !in '0'..'9') throw NotJson

            skipDigits()
        }

        private fun skipWhitespace() {
            while (position < text.length) {
                when (text[position]) {
                    ' ', '\t', '\n', '\r' -> position++
                    else -> return
                }
            }
        }

        /** The next unit, or NUL at the end — no JSON syntax is NUL, and a string cannot hold a raw one. */
        private fun peek(): Char = if (position < text.length) text[position] else '\u0000'

        private fun next(): Char {
            if (position >= text.length) throw NotJson

            return text[position++]
        }

        private fun expect(unit: Char) {
            if (next() != unit) throw NotJson
        }
    }
}
