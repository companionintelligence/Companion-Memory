package com.companionintelligence.localllm.intents

import com.companionintelligence.localllm.intents.ToolResultFixtures.pretty

/** One input to the shaper and the budget it is shaped to; [name] says which behaviour the case is there for. */
internal class ParityCase(val name: String, val budget: Int, val input: String)

/**
 * The inputs the shaper's answers are compared with iOS's on (`tool-result-swift-parity.json`, which holds what
 * `ToolResultShaper` in `LocalLLMPolicy.swift` answered for each).
 *
 * The cases are chosen to reach every decision the shaper makes, and the budgets to sit on either side of the
 * places where one decision turns into another: a hit stops being kept whole, three hits stop sharing the room and
 * two start to, a closing note stops fitting. Each name is `<behaviour> @ <budget>`.
 *
 * Everything here is synthetic. The three realistic results come from the bench corpus
 * (`frontend/apps/ios/tests/local-llm-device/Sources/Fixtures.swift`: a made-up person's notes, messages, photos,
 * calendar and contacts, in the real hit shape) and were written out by it into `src/test/resources`.
 */
internal object ToolResultCases {
    private const val UUID = "0199aaaa-bbbb-7ccc-9ddd-eeeeeeeeeeee"
    private val PAD = mapOf("content" to "c".repeat(1200))

    /** Every case, with [resource] giving the text of a file in `synthetic-tool-results`. */
    fun all(resource: (String) -> String): List<ParityCase> {
        val cases = ArrayList<ParityCase>()

        fun add(name: String, budget: Int, input: String) {
            cases.add(ParityCase("$name @ $budget", budget, input))
        }

        // ---- the realistic results, at the budgets a phone is given and the ones around them ----------------------------
        for ((name, file) in listOf("heron" to "knowledge-search-heron.json", "dentist" to "knowledge-search-dentist.json", "graph" to "memory-recall-maria.json")) {
            val text = resource(file)

            for (budget in listOf(256, 512, 1024, 2000)) add("realistic $name", budget, text)
        }

        // ---- pruning: what is an unset column and what is not ------------------------------------------------------------
        val prune =
            linkedMapOf<String, Map<String, Any?>>(
                "a foreign key is dropped" to mapOf("type" to "note", "title" to "T", "threadId" to UUID, "userId" to UUID),
                "upper case is a UUID too" to mapOf("type" to "note", "title" to "T", "threadId" to UUID.uppercase()),
                "a mixed case one as well" to mapOf("type" to "note", "title" to "T", "threadId" to "0199AAAA-bbbb-7CCC-9ddd-EEEEeeee0000"),
                "braces make it a string again" to mapOf("type" to "note", "title" to "T", "threadId" to "{$UUID}"),
                "so does having no dashes" to mapOf("type" to "note", "title" to "T", "threadId" to UUID.replace("-", "")),
                "dashes in the wrong places" to mapOf("type" to "note", "title" to "T", "threadId" to "0199aaaab-bb-7ccc-9ddd-eeeeeeeeeeee"),
                "a letter past f" to mapOf("type" to "note", "title" to "T", "threadId" to "0199aaaa-bbbb-7ccc-9ddd-eeeeeeeeeeeg"),
                "one character too many" to mapOf("type" to "note", "title" to "T", "threadId" to UUID + "0"),
                "the nil UUID is one" to mapOf("type" to "note", "title" to "T", "threadId" to "00000000-0000-0000-0000-000000000000"),
                "a UUID as a title is a title" to mapOf("type" to "note", "title" to UUID, "name" to UUID, "summary" to UUID),
                "an id alone is the address" to mapOf("type" to "note", "title" to "T", "id" to UUID),
                "an id that is not a UUID" to mapOf("type" to "note", "title" to "T", "id" to "abc"),
                "an id beside a link is dropped" to mapOf("type" to "note", "title" to "T", "id" to UUID, "link" to "/notes/x"),
                "an id beside an empty link goes with it" to mapOf("type" to "note", "title" to "T", "id" to UUID, "link" to ""),
                "an id beside a null link stays" to mapOf("type" to "note", "title" to "T", "id" to UUID, "link" to null),
                "an id beside a numeric link stays" to mapOf("type" to "note", "title" to "T", "id" to UUID, "link" to 5),
                "a link that is a UUID stays" to mapOf("type" to "note", "title" to "T", "link" to UUID),
                "a numeric id stays" to mapOf("type" to "note", "title" to "T", "id" to 12345),
                "UUID elements of an array go" to mapOf("type" to "note", "title" to "T", "tags" to listOf(UUID, "work", UUID.uppercase(), "home", "abc")),
                "an array of nothing else goes whole" to mapOf("type" to "note", "title" to "T", "toEntityIds" to listOf(UUID, UUID)),
                "nested arrays are pruned too" to mapOf("type" to "note", "title" to "T", "groups" to listOf(listOf(UUID), listOf(UUID, "x"), listOf(listOf("y", UUID)))),
                "members of objects in an array" to mapOf("type" to "note", "title" to "T", "people" to listOf(mapOf("id" to UUID, "name" to "A"), mapOf("id" to UUID, "link" to "/p/1"), mapOf("entityId" to UUID))),
                "a nested object is pruned by the same rules" to mapOf("type" to "note", "title" to "T", "meta" to mapOf("threadId" to UUID, "id" to UUID, "link" to UUID, "name" to "N", "inner" to mapOf("id" to UUID, "x" to UUID))),
                "entityType beside a type is dropped" to mapOf("type" to "note", "entityType" to "note", "title" to "T"),
                "entityType without a type stays" to mapOf("entityType" to "note", "title" to "T"),
                "entityType beside a null type is dropped with it" to mapOf("type" to null, "entityType" to "note", "title" to "T"),
                "entityType beside a different type" to mapOf("type" to "photo", "entityType" to "content", "title" to "T"),
                "entityType in a nested object" to mapOf("type" to "note", "title" to "T", "owner" to mapOf("entityType" to "person", "name" to "P")),
                "everything unset leaves nothing" to mapOf("a" to null, "b" to "", "c" to false, "d" to emptyList<Any>(), "e" to emptyMap<String, Any>(), "f" to listOf(null, "", false, emptyList<Any>(), emptyMap<String, Any>())),
                "numbers and true stay, zero too" to mapOf("a" to 0, "b" to 0.0, "c" to -0.0, "d" to 1, "e" to true, "f" to listOf(0, false, true), "g" to mapOf("h" to 0), "title" to "T"),
                "whitespace is not empty" to mapOf("type" to "note", "title" to " ", "name" to "\t"),
            )
        for ((name, hit) in prune) {
            add("prune: $name", 700, pretty(hit + PAD))
        }
        for (name in listOf("an id beside a link is dropped", "an id beside an empty link goes with it", "UUID elements of an array go", "entityType beside a type is dropped", "everything unset leaves nothing", "a nested object is pruned by the same rules")) {
            val hit = prune.getValue(name)

            add("prune in a list: $name", 900, pretty(mapOf("summary" to "S", "totalMatches" to null, "items" to listOf(hit + PAD, hit + PAD + mapOf("title" to "second")))))
        }

        // ---- ranking: identity, then when, then what it says, then the rest, then bookkeeping -------------------------------
        val ranked =
            linkedMapOf<String, Any?>(
                "zeta" to "z", "locationName" to "Fremont Smile Dental", "category" to "health", "status" to "confirmed", "tags" to listOf("a", "b"),
                "sourceId" to "evt_0123456789", "id" to "abc", "updatedAt" to "2025-10-01T00:00:00.000Z", "metadata" to mapOf("htmlLink" to "https://example.com/e"),
                "importance" to 0.4, "priority" to 2, "sourceSystem" to "google_calendar", "confidenceScore" to 1, "isActive" to true,
                "notes" to "Bring the insurance card.", "description" to "Cleaning and exam.", "text" to "Dr. Nair", "content" to "Appointment at 2:30 PM.",
                "birthDate" to "1980-01-01", "takenAt" to "2025-10-09T20:00:00.000Z", "createdAt" to "2025-09-25T16:05:00.000Z", "date" to "2025-10-09",
                "dueDate" to "2025-10-09", "time" to "2025-10-09T21:00:00.000Z", "endTime" to "2025-10-09T22:30:00.000Z", "startTime" to "2025-10-09T21:30:00.000Z",
                "subject" to "Your appointment", "name" to "Fremont Smile Dental", "title" to "Dentist: Dr. Priya Nair", "link" to "/events/e1", "type" to "event", "summary" to "One event.",
            )
        for (budget in listOf(100, 130, 160, 190, 220, 260, 300, 360, 420, 520, 640, 800, 1200)) add("ranking", budget, pretty(ranked))
        for (budget in listOf(300, 900)) {
            add("ranking in a list", budget, pretty(mapOf("summary" to "Found some.", "limit" to 25, "items" to listOf(ranked, ranked + mapOf("title" to "second"), ranked + mapOf("title" to "third")))))
        }

        // ---- members are dropped from the end, down to three ----------------------------------------------------------------
        for (count in listOf(3, 4, 6, 9)) {
            val hit = (0 until count).associate { "k" + it.toString().padStart(2, '0') to "m".repeat(40) }

            for (budget in listOf(64, 90, 120, 150, 180, 230, 300)) add("a hit of $count members", budget, pretty(hit))
        }
        val keyed = mapOf("type" to "event", "link" to "/events/e1", "title" to "Dentist: Dr. Nair", "startTime" to "2025-10-09T21:30:00.000Z", "endTime" to "2025-10-09T22:30:00.000Z", "sourceId" to "evt_" + "x".repeat(40), "sourceSystem" to "google_calendar", "sentimentScore" to 0.4, "importanceScore" to 0.3, "confidenceScore" to 1, "metadata" to mapOf("htmlLink" to "https://calendar.example.com/event?eid=" + "q".repeat(60)), "locationName" to "Fremont Smile Dental, Fremont", "category" to "health")
        for (budget in listOf(64, 100, 150, 200, 230, 260, 300, 400, 500)) add("a calendar event that has to lose members", budget, pretty(keyed))

        // ---- links are never shortened --------------------------------------------------------------------------------------
        for (length in listOf(60, 250, 900)) {
            val hit = mapOf("type" to "communication", "link" to "/communications/" + "L".repeat(length), "title" to "T".repeat(100), "content" to "c".repeat(3000))

            for (budget in listOf(120, 200, 260, 330, 450, 600)) add("a $length character link", budget, pretty(hit))
            add("a $length character link among three hits", 1200, pretty(mapOf("summary" to "S", "items" to listOf(hit, hit + mapOf("title" to "2"), hit + mapOf("title" to "3")))))
        }
        add("a link that is not a string is shortened like the rest", 300, pretty(mapOf("type" to "x", "link" to 12345, "title" to "T".repeat(400))))
        add("a link inside an array is only a string", 300, pretty(mapOf("type" to "x", "links" to listOf("/a/" + "z".repeat(500), "/b/" + "y".repeat(500)), "title" to "T")))
        add("a link in a nested object is whole", 400, pretty(mapOf("type" to "x", "owner" to mapOf("link" to "/o/" + "z".repeat(500), "name" to "N".repeat(400)))))
        add("a link with quotes and backslashes", 400, pretty(mapOf("type" to "x", "link" to "/n/a\"b\\c/" + "z".repeat(100), "title" to "T".repeat(400))))

        // ---- the first hits share the room, and fewer share it when the share would be small --------------------------------
        fun tiny(i: Int) = mapOf("type" to "note", "link" to "/notes/n$i", "title" to "T$i")

        fun mid(i: Int) = mapOf("type" to "note", "link" to "/notes/n$i", "title" to "Title $i", "content" to "word ".repeat(16), "startTime" to "2026-01-0${1 + i % 9}T10:00:00.000Z")

        fun big(i: Int) = mapOf("type" to "communication", "link" to "/communications/c$i", "title" to "Subject $i", "content" to "long message ".repeat(150), "time" to "2026-02-0${1 + i % 9}T10:00:00.000Z")

        fun uneven(i: Int) = listOf(::tiny, ::big, ::mid, ::big, ::tiny, ::mid)[i % 6](i)

        val thresholds =
            listOf(
                Triple("tiny hits", ::tiny, listOf(165, 166, 207, 208, 212, 213, 254, 255, 260, 261, 302, 303, 619, 620)),
                Triple("mid hits", ::mid, listOf(296, 297, 329, 330, 349, 350, 551, 552, 746, 747, 931, 932)),
                Triple("big hits", ::big, listOf(218, 219, 220, 221, 518, 519, 799, 800)),
                Triple("uneven hits", ::uneven, listOf(159, 160, 266, 267, 480, 481, 488, 489, 552, 553, 629, 630)),
            )
        for ((name, maker, budgets) in thresholds) {
            val items = (0 until 12).map(maker)

            for (budget in budgets) {
                if (name == "tiny hits" || name == "big hits") {
                    add("twelve $name in an array", budget, pretty(items))
                } else {
                    add("twelve $name in an envelope", budget, pretty(mapOf("summary" to "Showing the top 12.", "items" to items)))
                }
            }
        }
        for (count in listOf(1, 2, 3)) {
            for (budget in listOf(150, 450, 900)) {
                add("$count mid hits in an envelope", budget, pretty(mapOf("summary" to "S", "items" to (0 until count).map(::mid))))
            }
        }

        // ---- the header: strings capped at 200, members written whole ------------------------------------------------------------
        for (length in listOf(199, 200, 201, 250, 1000)) {
            val header = mapOf("summary" to "S".repeat(length), "note" to "n".repeat(length), "link" to "/l/" + "k".repeat(length), "limit" to 25, "totalMatches" to null, "tags" to listOf("t".repeat(length)), "items" to (0 until 3).map(::mid))

            for (budget in listOf(800)) add("a header of $length characters", budget, pretty(header))
            if (length == 1000) add("a header of $length characters", 4000, pretty(header))
        }
        add("a header with unset columns and ids", 800, pretty(mapOf("summary" to "S", "threadId" to UUID, "id" to UUID, "meta" to mapOf("a" to null, "b" to emptyList<Any>()), "entityType" to "x", "type" to "y", "items" to (0 until 2).map(::mid))))
        add("a header too big for the budget", 800, pretty(mapOf("summary" to "S") + (0 until 80).associate { "key" + it.toString().padStart(3, '0') to "h".repeat(50) } + mapOf("items" to (0 until 2).map(::mid))))

        // ---- what is empty after pruning ------------------------------------------------------------------------------------------
        val spaces = " ".repeat(600)
        val empties =
            linkedMapOf(
                "an empty array" to "[$spaces]",
                "an empty object" to "{$spaces}",
                "nulls" to "[null, null, null$spaces]",
                "empties inside empties" to "[[], {}, [[]], [{}], {\"a\": []}$spaces]",
                "an object of unset columns" to "{\"a\": null, \"b\": [], \"c\": {}, \"d\": false, \"e\": \"\"$spaces}",
                "an empty string" to "\"\"$spaces",
                "false" to "false$spaces",
                "null" to "null$spaces",
                "true" to "$spaces true",
                "zero" to "0$spaces",
                "a number" to "$spaces-12.5e3$spaces",
                "a short string" to "\"hello\"$spaces",
                "an array of UUIDs" to "[\"$UUID\", \"$UUID\", \"$UUID\"]$spaces",
                "UUIDs and empties" to "[\"$UUID\", \"\", null, false, [], {}]$spaces",
                "an object of UUID members" to "{\"a\": \"$UUID\", \"b\": \"$UUID\", \"id\": null}$spaces",
                "items that are all null" to "{\"summary\": \"S\", \"items\": [null, null, \"\"]}$spaces",
                "items that are all empty" to "{\"summary\": \"S\", \"items\": [[], {}, [null]]}$spaces",
                "an empty items array" to "{\"summary\": \"S\", \"items\": []}$spaces",
                "items that are only UUIDs" to "{\"summary\": \"S\", \"items\": [\"$UUID\", \"$UUID\"]}$spaces",
                "items that are UUIDs and text" to "{\"summary\": \"S\", \"items\": [\"$UUID\", \"text\", \"$UUID\", \"more\"]}$spaces",
                "items that prune away but for one" to "{\"summary\": \"S\", \"items\": [null, {\"title\": \"T\", \"type\": \"note\"}, {}]}$spaces",
                "items that all prune away, beside a header" to "{\"summary\": \"S\", \"limit\": 25, \"truncated\": true, \"items\": [{\"a\": null}, {\"b\": []}]}$spaces",
                "items that is a string" to "{\"summary\": \"S\", \"items\": \"${"x".repeat(700)}\"}",
                "items that is an object" to "{\"summary\": \"S\", \"items\": {\"a\": 1, \"pad\": \"${"p".repeat(700)}\"}}",
                "items that is null" to "{\"summary\": \"S\", \"items\": null, \"pad\": \"${"p".repeat(700)}\"}",
            )
        for ((name, text) in empties) for (budget in listOf(64, 300)) add("empty after pruning: $name", budget, text)

        // ---- lists: every member that is an array of more than one element is bounded -------------------------------------------
        fun node(i: Int, size: Int = 1) = mapOf("id" to UUID, "type" to listOf("person", "organization", "place", "concept")[i % 4], "name" to "Name $i", "description" to "d".repeat(20 * size), "properties" to mapOf("k" to "v".repeat(5 * size)), "metadata" to mapOf("createdAt" to "2024-01-01T00:00:00.000Z", "linkedId" to UUID))

        fun edge(i: Int, size: Int = 1) = mapOf("id" to UUID, "type" to listOf("KNOWS", "WORKS_AT", "LIVES_IN", "FRIEND_OF")[i % 4], "from" to mapOf("id" to UUID, "name" to "A$i"), "to" to mapOf("id" to UUID, "name" to "B".repeat(3 * size)), "properties" to emptyMap<String, Any>(), "strength" to 0.1 * (i % 10 + 1), "bidirectional" to (i % 3 == 0))

        for ((nodes, edges) in listOf(2 to 0, 2 to 2, 5 to 12, 30 to 5, 30 to 40)) {
            val graph = mapOf("seedEntityIds" to listOf(UUID), "nodes" to (0 until nodes).map { node(it, 3) }, "edges" to (0 until edges).map { edge(it, 3) }, "stats" to mapOf("nodeCount" to nodes, "edgeCount" to edges))

            for (budget in listOf(120, 260, 560, 1024)) add("a graph of $nodes nodes and $edges edges", budget, pretty(graph))
        }
        val lists =
            linkedMapOf<String, Map<String, Any?>>(
                "one element is a member, not a list" to mapOf("summary" to "S", "items" to listOf(mid(0)), "note" to "n".repeat(100)),
                "two elements are a list" to mapOf("summary" to "S", "items" to listOf(mid(0), mid(1))),
                "items goes first whatever its name sorts as" to mapOf("zzz" to (0 until 4).map(::tiny), "items" to (0 until 4).map(::mid), "aaa" to (0 until 4).map(::tiny)),
                "the rest by where their names rank" to mapOf("metadata" to (0 until 4).map { "m$it" }, "description" to (0 until 4).map { "d$it" }, "title" to (0 until 4).map { "t$it" }, "zeta" to (0 until 4).map { "z$it" }, "startTime" to (0 until 4).map { "s$it" }),
                "then by name" to mapOf("zeta" to (0 until 4).map { "z$it".repeat(8) }, "alpha" to (0 until 4).map { "a$it".repeat(8) }, "Alpha" to (0 until 4).map { "A$it".repeat(8) }, "beta" to (0 until 4).map { "b$it".repeat(8) }),
                "a list with nothing but a header of unset columns" to mapOf("a" to null, "b" to emptyList<Any>(), "items" to (0 until 5).map(::mid)),
                "lists of scalars" to mapOf("tags" to (0 until 20).map { "tag-$it" }, "scores" to (0 until 20).map { it * 0.37 }),
                "lists that are UUIDs" to mapOf("ids" to listOf(UUID, UUID, UUID), "tags" to listOf("a", "b", "c")),
                "lists of lists" to mapOf("pairs" to (0 until 6).map { listOf(it, "x".repeat(10)) }, "rows" to (0 until 6).map { listOf(it, it + 1) }),
                "a list among members of every kind" to mapOf("summary" to "S".repeat(300), "limit" to 25, "stats" to mapOf("n" to 5), "link" to "/x/" + "k".repeat(250), "items" to (0 until 6).map(::mid), "events" to (0 until 6).map { mapOf("title" to "Event $it", "startTime" to "2026-01-0${1 + it}T10:00:00.000Z", "locationName" to "L".repeat(30)) }),
                "five lists" to mapOf("items" to (0 until 6).map(::mid), "results" to (0 until 6).map { mapOf("title" to "Result $it", "text" to "t".repeat(60)) }, "events" to (0 until 6).map(::tiny), "tags" to (0 until 6).map { "tag$it" }, "scores" to (0 until 6).map { it * 1.5 }),
            )
        for ((name, doc) in lists) for (budget in listOf(100, 300, 800)) add("lists: $name", budget, pretty(doc))

        // ---- the closing note's reserve is a share of a small budget ------------------------------------------------------------
        for (budget in listOf(64, 80, 100, 120, 150, 180, 220, 300, 400, 560, 700)) {
            add("five hits in an array", budget, pretty((0 until 5).map { mapOf("title" to "T$it", "type" to "x") }))
            add("five hits in an envelope", budget, pretty(mapOf("summary" to "S", "items" to (0 until 5).map { mapOf("title" to "T$it", "type" to "x") })))
        }

        // ---- the last resort: nothing fits, so the pruned compact text is cut --------------------------------------------------------
        val last =
            linkedMapOf<String, Map<String, Any?>>(
                "300 numbered members" to (0 until 300).associate { "key" + it.toString().padStart(4, '0') to it },
                "sixty strings" to (0 until 60).associate { "key" + it.toString().padStart(3, '0') to "v".repeat(40) },
                "mostly unset columns" to (0 until 60).associate { "key" + it.toString().padStart(3, '0') to null } + (0 until 20).associate { "k" + it.toString().padStart(3, '0') to "v".repeat(30) } + mapOf("id" to UUID),
                "a hit of three huge members" to mapOf("items" to listOf(mapOf("a" to "x".repeat(5000), "b" to "y".repeat(5000), "c" to "z".repeat(5000)), mapOf("a" to 1))),
                "a header bigger than the budget" to mapOf("summary" to "s") + (0 until 70).associate { "h" + it.toString().padStart(3, '0') to "H".repeat(50) } + mapOf("items" to listOf(mapOf("title" to "T"), mapOf("title" to "U"))),
                "a list inside a member" to mapOf("wrapper" to mapOf("items" to (0 until 10).map { mapOf("title" to "T$it") }), "note" to "n".repeat(100)),
                "a list that is only long strings" to mapOf("items" to listOf("z".repeat(3000), "y")),
            )
        for ((name, doc) in last) for (budget in listOf(64, 120, 250, 400)) add("nothing fits: $name", budget, pretty(doc))
        for (budget in listOf(100, 200, 300)) {
            add("a number JSON cannot carry in a hit", budget, "{\"items\":[{\"title\":\"T\",\"x\":-1e999},{\"title\":\"U\"}],\"pad\":\"${"p".repeat(400)}\"}")
            add("a number JSON cannot carry in a list", budget, "{\"nodes\":[1,2,-1e999,4],\"edges\":[{\"a\":1},{\"a\":2}],\"pad\":\"${"p".repeat(400)}\"}")
            add("a number JSON cannot carry in an array", budget, "[{\"a\":1},{\"a\":-1e999},\"${"p".repeat(400)}\"]")
            add("a number JSON cannot carry alone", budget, "-1e999$spaces")
        }

        // ---- strings and scalars on their own ---------------------------------------------------------------------------------------
        for (budget in listOf(64, 100, 330, 400, 1000)) {
            add("a long string", budget, "\"" + "s".repeat(2000) + "\"")
            add("a long string of accented letters", budget, "\"" + "e\u0301".repeat(800) + "\"")
        }

        return cases
    }
}
