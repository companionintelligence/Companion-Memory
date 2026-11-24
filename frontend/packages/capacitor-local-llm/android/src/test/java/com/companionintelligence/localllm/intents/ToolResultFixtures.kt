package com.companionintelligence.localllm.intents

import java.util.Locale

/**
 * The results the tool-result tests shape, built in plain Kotlin — not with `org.json` — so that what goes
 * *into* the shaper is not made by the library the tests then use to check what comes *out*.
 *
 * The same fixtures iOS's `tests/local-llm-pure/main.swift` uses, with the same values, so the two platforms'
 * tests are about the same inputs.
 */
internal object ToolResultFixtures {
    /**
     * What the appliance's `knowledge.search` sends back through MCP: `JSON.stringify(result, null, 2)` of a
     * header — `summary` first — and up to 25 hydrated entities, each with a long `content`. Each hit is
     * pretty-printed on its own and joined, exactly as the Swift fixture does.
     */
    fun searchResult(items: Int, contentLength: Int = 900): String =
        "{\n  \"summary\": \"Showing the top $items of at least $items matches.\",\n" +
            "  \"totalMatches\": null,\n  \"truncated\": true,\n  \"limit\": 25,\n  \"mode\": \"hybrid\",\n" +
            "  \"items\": [\n" + (0 until items).joinToString(",\n") { pretty(hit(it, contentLength)) } + "\n  ]\n}"

    /** One hydrated entity, with the fields the appliance puts on a search hit. */
    fun hit(n: Int, contentLength: Int = 900): Map<String, Any?> {
        val id = "0198a3f2-7c1e-7b3a-9d41-" + String.format(Locale.US, "%012d", n)

        return mapOf(
            "id" to id,
            "type" to "communication",
            "link" to "/communications/$id",
            "title" to "Zephyr marmalade note $n",
            "content" to "zephyr marmalade ".repeat(contentLength / 17),
            "time" to "2026-09-2${n % 10}T10:00:00.000Z",
            "createdAt" to "2026-09-2${n % 10}T10:00:01.000Z",
            "updatedAt" to "2026-09-2${n % 10}T10:00:02.000Z",
            "metadata" to mapOf("source" to "takeout", "labels" to listOf("a", "b", "c"), "score" to 0.8123),
        )
    }

    /** `JSON.stringify(value, null, 2)` with the keys sorted and `/` left alone — like the Swift fixtures'. */
    fun pretty(value: Any?, indent: String = ""): String =
        when (value) {
            null -> "null"
            is String -> quote(value)
            is Boolean, is Int, is Long, is Double -> value.toString()
            is Map<*, *> ->
                if (value.isEmpty()) {
                    "{}"
                } else {
                    value.entries
                        .sortedBy { it.key as String }
                        .joinToString(",\n", "{\n", "\n$indent}") { "$indent  ${quote(it.key as String)}: ${pretty(it.value, "$indent  ")}" }
                }
            is List<*> ->
                if (value.isEmpty()) {
                    "[]"
                } else {
                    value.joinToString(",\n", "[\n", "\n$indent]") { "$indent  ${pretty(it, "$indent  ")}" }
                }
            else -> throw IllegalArgumentException("no JSON form for ${value::class}")
        }

    /** A JSON string literal, written the way a JavaScript engine writes one. */
    fun quote(string: String): String {
        val out = StringBuilder("\"")

        for (c in string) {
            when {
                c == '"' -> out.append("\\\"")
                c == '\\' -> out.append("\\\\")
                c == '\n' -> out.append("\\n")
                c == '\r' -> out.append("\\r")
                c == '\t' -> out.append("\\t")
                c < ' ' -> out.append(String.format(Locale.US, "\\u%04x", c.code))
                else -> out.append(c)
            }
        }

        return out.append('"').toString()
    }

    /** The size of [text] encoded as UTF-8, taken from the JDK's encoder rather than from the code under test. */
    fun utf8(text: String): Int = text.toByteArray(Charsets.UTF_8).size
}
