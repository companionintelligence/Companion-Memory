package com.companionintelligence.localllm.intents

import com.companionintelligence.localllm.RepoFiles
import java.io.File
import java.security.MessageDigest
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * [ToolResultShaper] against iOS's own, over [ToolResultCases]: `tool-result-swift-parity.json` holds what
 * `ToolResultShaper` in `LocalLLMPolicy.swift` answered for each case, so a difference here is a difference
 * between the two platforms — in the design, in a constant that was tuned on one of them, or in how a platform
 * counts a character.
 *
 * When the Swift shaper is changed on purpose, change the Kotlin one to match and run
 * `frontend/packages/capacitor-local-llm/android/scripts/regenerate-swift-parity.sh`, which asks the Swift shaper
 * again (it needs `swiftc`). A test that then fails is a case on which the two still differ. Until that is done
 * [the_recorded_answers_are_those_of_the_swift_shaper_that_is_in_the_repo] fails, so a change to one shaper cannot be
 * made without the other one noticing.
 */
@RunWith(RobolectricTestRunner::class)
class SwiftParityTest {
    private fun resource(name: String): String =
        checkNotNull(javaClass.classLoader?.getResourceAsStream(name)) { "no test resource $name" }.use { String(it.readBytes(), Charsets.UTF_8) }

    private fun cases(): List<ParityCase> = ToolResultCases.all { resource("synthetic-tool-results/$it") }

    @Test
    fun the_shaper_answers_every_case_as_the_swift_shaper_did() {
        val expected = JSONObject(resource("tool-result-swift-parity.json"))
        val cases = cases()
        val differing = ArrayList<String>()

        for (case in cases) {
            assertTrue("no answer from iOS recorded for ${case.name}: regenerate the file", expected.has(case.name))

            val answer = ToolResultShaper.shape(case.input, case.budget)

            if (answer != expected.getString(case.name)) differing.add(case.name)
        }

        assertEquals("cases whose answer differs from iOS's, of ${cases.size}", emptyList<String>(), differing)
    }

    @Test
    fun the_recorded_answers_are_for_exactly_these_cases() {
        val expected = JSONObject(resource("tool-result-swift-parity.json"))
        val recorded = expected.keys().asSequence().filter { !it.startsWith("_") }.toSet()
        val names = cases().map { it.name }

        assertEquals("a case name is used twice", names.size, names.toSet().size)
        assertEquals("answers recorded for cases that no longer exist", emptySet<String>(), recorded - names.toSet())
        assertEquals("cases with no answer recorded", emptySet<String>(), names.toSet() - recorded)
        assertTrue("the file says which Swift file it came from", expected.has("_source"))
    }

    @Test
    fun the_recorded_answers_are_those_of_the_swift_shaper_that_is_in_the_repo() {
        val swift = RepoFiles.read("frontend/apps/ios/ios/App/App/LocalLLM/LocalLLMPolicy.swift")
        val start = swift.indexOf("\n// MARK: - Tool results\n")

        assertTrue("LocalLLMPolicy.swift has no `// MARK: - Tool results` section: the shaper moved, and this test and the regeneration script look for it there", start >= 0)

        // The shaper's code: from its MARK to the end of the file, minus comment-only and blank lines, so that a comment can be reworded.
        val code = swift.substring(start + 1).split("\n").filter { it.isNotBlank() && !it.trimStart().startsWith("//") }.joinToString("\n")
        val actual = MessageDigest.getInstance("SHA-256").digest(code.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
        val recorded = JSONObject(resource("tool-result-swift-parity.json")).getString("_shaper_sha256")

        assertEquals(
            "ToolResultShaper in LocalLLMPolicy.swift is not the one the answers were recorded from. Port the change to ToolResultShaper.kt, " +
                "then run frontend/packages/capacitor-local-llm/android/scripts/regenerate-swift-parity.sh.",
            recorded,
            actual,
        )
    }

    /**
     * Not a check: with `SWIFT_PARITY_DUMP_DIR` set, writes every case as `NNNNN.in` / `.budget` / `.name` for
     * `scripts/regenerate-swift-parity.sh` to feed to the Swift shaper. Skipped otherwise.
     */
    @Test
    fun write_the_cases_out_for_the_swift_shaper_when_asked() {
        val directory = System.getenv("SWIFT_PARITY_DUMP_DIR")

        assumeTrue("only for scripts/regenerate-swift-parity.sh", directory != null)

        val target = File(directory!!)

        assertTrue(target.isDirectory || target.mkdirs())

        for ((index, case) in cases().withIndex()) {
            val base = File(target, index.toString().padStart(5, '0'))

            File("$base.in").writeBytes(case.input.toByteArray(Charsets.UTF_8))
            File("$base.budget").writeText(case.budget.toString())
            File("$base.name").writeText(case.name)
        }

        assertNotNull(target.list())
    }
}
