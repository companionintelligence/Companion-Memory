package com.companionintelligence.localllm.intents

import java.text.BreakIterator
import java.util.Locale

/**
 * Text counted in characters as a reader sees them: extended grapheme clusters, so a flag, a family emoji, a
 * letter with its accent and a CR LF pair are one each and are never cut through. That is what Swift's
 * `String.count` and `String.prefix` work in, which is what the iOS side of [ToolResultShaper] and its HTTP error
 * detail are written in; [String.length] counts UTF-16 units, and a code point is not what a reader sees either.
 */
internal object Characters {
    /**
     * `BreakIterator` keeps a position and is not thread-safe, so each thread that asks gets its own. Built lazily:
     * most strings are short enough that nobody has to ask. (`ThreadLocal.withInitial` needs API 26; this app's
     * floor is 23.)
     */
    private val iterator =
        object : ThreadLocal<BreakIterator>() {
            override fun initialValue(): BreakIterator = BreakIterator.getCharacterInstance(Locale.ROOT)
        }

    /** The first [count] characters of [string], or all of it when it has no more. */
    fun take(string: String, count: Int): String {
        if (count <= 0) return ""

        // At most `count` UTF-16 units is at most `count` characters, however they cluster.
        if (string.length <= count) return string

        val characters = checkNotNull(iterator.get())

        characters.setText(string)

        var end = 0

        repeat(count) {
            end = characters.next()

            if (end == BreakIterator.DONE) return string
        }

        return string.substring(0, end)
    }
}
