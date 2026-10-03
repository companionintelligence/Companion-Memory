package com.companionintelligence.localllm.intents

import java.util.TreeSet
import java.util.regex.Pattern

/**
 * A strict JSON (RFC 8259) validator for the tests, written separately from the reader inside [ToolResultShaper]
 * so that what the shaper writes is not checked by the code that was written alongside it. It takes numbers and the
 * three words by grammar (regular expressions) where the shaper's reader walks characters, and refuses what
 * `org.json` forgives: unquoted words, single quotes, comments, trailing commas, a raw control character in a
 * string, text after the value.
 *
 * Strings are scanned by hand, not by regular expression: Java's regex engine recurses once per repetition of a
 * group, so a pattern for "a string" overflows the stack on a string of a few thousand characters, and the inputs
 * these tests check include strings of megabytes.
 */
internal object StrictJsonCheck {
    private val NUMBER: Pattern = Pattern.compile("""-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?""")
    private val LITERAL: Pattern = Pattern.compile("""true|false|null""")
    private const val MAX_DEPTH = 600

    /** Null when [text] is exactly one strict JSON value, else what is wrong with it and where. */
    fun problem(text: String): String? {
        val reader = Reader(text)

        return try {
            reader.skipWhitespace()
            reader.value(0)
            reader.skipWhitespace()

            if (reader.position == text.length) null else "text after the value at ${reader.position}"
        } catch (e: IllegalStateException) {
            e.message
        }
    }

    fun isValid(text: String): Boolean = problem(text) == null

    /** Every string value and every key in a document, as the characters they stand for. */
    class Collected(val strings: TreeSet<String>, val keys: Set<String>)

    /**
     * Every string and every key in [text], or null when it is not strict JSON. A repeated key is read each time it
     * is written, where `org.json` keeps the last and the shaper the first: what matters here is every string the
     * shaper could have been given.
     */
    fun collect(text: String): Collected? {
        val reader = Reader(text, collect = true)

        return try {
            reader.skipWhitespace()
            reader.value(0)
            reader.skipWhitespace()

            if (reader.position == text.length) Collected(reader.strings, reader.allKeys) else null
        } catch (e: IllegalStateException) {
            null
        }
    }

    /**
     * The keys of the top-level object in the order they are written, or null when [text] is not a strict JSON object.
     * For the tests that are about order: a `JSONObject` does not promise to keep one.
     */
    fun topLevelKeys(text: String): List<String>? {
        val reader = Reader(text, collectKeys = true)

        return try {
            reader.skipWhitespace()

            if (reader.position >= text.length || text[reader.position] != '{') return null

            reader.value(0)
            reader.skipWhitespace()

            if (reader.position == text.length) reader.keys else null
        } catch (e: IllegalStateException) {
            null
        }
    }

    private class Reader(private val text: String, private val collectKeys: Boolean = false, private val collect: Boolean = false) {
        var position = 0

        /** The keys of the object at depth 0, in order, when [collectKeys]. */
        val keys = ArrayList<String>()

        /** Every string value, and every key at any depth, when [collect]. */
        val strings = TreeSet<String>()
        val allKeys = HashSet<String>()

        fun skipWhitespace() {
            while (position < text.length && text[position] in " \t\n\r") position++
        }

        fun value(depth: Int) {
            check(depth <= MAX_DEPTH) { "nested deeper than $MAX_DEPTH" }
            check(position < text.length) { "the text ends where a value was expected" }

            when (text[position]) {
                '{' -> obj(depth)
                '[' -> array(depth)
                '"' -> {
                    val literal = string()

                    if (collect) strings.add(unescape(literal))
                }
                else -> {
                    if (!token(NUMBER) && !token(LITERAL)) error("not a JSON value at $position: ${text.substring(position, minOf(position + 20, text.length))}")
                }
            }
        }

        private fun obj(depth: Int) {
            position++
            skipWhitespace()

            if (peek() == '}') {
                position++

                return
            }

            while (true) {
                skipWhitespace()
                check(peek() == '"') { "an object key must be a quoted string at $position" }

                val key = string()

                if (collectKeys && depth == 0) keys.add(unescape(key))
                if (collect) allKeys.add(unescape(key))

                skipWhitespace()
                check(peek() == ':') { "no colon after a key at $position" }
                position++
                skipWhitespace()
                value(depth + 1)
                skipWhitespace()

                when (peek()) {
                    ',' -> position++
                    '}' -> {
                        position++

                        return
                    }
                    else -> error("expected , or } at $position")
                }
            }
        }

        private fun array(depth: Int) {
            position++
            skipWhitespace()

            if (peek() == ']') {
                position++

                return
            }

            while (true) {
                skipWhitespace()
                value(depth + 1)
                skipWhitespace()

                when (peek()) {
                    ',' -> position++
                    ']' -> {
                        position++

                        return
                    }
                    else -> error("expected , or ] at $position")
                }
            }
        }

        /** Reads one string literal and returns it as written, quotes included. */
        private fun string(): String {
            val start = position

            check(peek() == '"') { "a string was expected at $position" }
            position++

            while (true) {
                check(position < text.length) { "an unterminated string at $start" }

                val unit = text[position++]

                when {
                    unit == '"' -> return text.substring(start, position)
                    unit < ' ' -> error("a raw control character in a string at ${position - 1}")
                    unit == '\\' -> escape(start)
                }
            }
        }

        /** The rest of an escape, after its backslash. A surrogate written as an escape is refused: nothing here writes one. */
        private fun escape(start: Int) {
            check(position < text.length) { "an unterminated escape in the string at $start" }

            when (val kind = text[position++]) {
                '"', '\\', '/', 'b', 'f', 'n', 'r', 't' -> Unit
                'u' -> {
                    check(position + 4 <= text.length && (0 until 4).all { text[position + it] in HEX_DIGITS }) { "a malformed \\u escape at ${position - 2}" }

                    val code = text.substring(position, position + 4).toInt(16)

                    check(code !in 0xD800..0xDFFF) { "a surrogate written as an escape at ${position - 2}" }

                    position += 4
                }
                else -> error("an unknown escape \\$kind at ${position - 2}")
            }
        }

        /** The text a string literal stands for. */
        private fun unescape(literal: String): String {
            val out = StringBuilder()
            var index = 1

            while (index < literal.length - 1) {
                val unit = literal[index++]

                if (unit != '\\') {
                    out.append(unit)

                    continue
                }

                when (val kind = literal[index++]) {
                    'b' -> out.append(0x08.toChar())
                    'f' -> out.append(0x0C.toChar())
                    'n' -> out.append('\n')
                    'r' -> out.append('\r')
                    't' -> out.append('\t')
                    'u' -> {
                        out.append(literal.substring(index, index + 4).toInt(16).toChar())
                        index += 4
                    }
                    else -> out.append(kind) // a quote, a backslash or a slash stands for itself
                }
            }

            return out.toString()
        }

        private fun token(pattern: Pattern): Boolean {
            val matcher = pattern.matcher(text).region(position, text.length)

            if (!matcher.lookingAt()) return false

            position = matcher.end()

            return true
        }

        /** The next unit, or NUL at the end: no JSON syntax is NUL, and a string cannot hold a raw one. */
        private fun peek(): Char = if (position < text.length) text[position] else 0.toChar()
    }

    private const val HEX_DIGITS = "0123456789abcdefABCDEF"
}
