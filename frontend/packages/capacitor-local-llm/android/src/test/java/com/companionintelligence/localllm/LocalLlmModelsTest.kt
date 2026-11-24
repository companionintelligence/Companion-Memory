package com.companionintelligence.localllm

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Plain JUnit — no Robolectric. [LocalLlmModels] touches no Android type, and it compiles to
 * its own class distinct from the `Context`-using `LocalLlmModelsKt`, so nothing on this path
 * needs a sandbox.
 */
class LocalLlmModelsTest {

    @Test
    fun an_unknown_model_id_is_rejected_rather_than_falling_back_to_a_known_entry() {
        assertSame(LocalLlmModels.GEMMA_4_E4B_IT, LocalLlmModels.find("gemma-4-e4b-it"))
        assertSame(LocalLlmModels.GEMMA_4_E2B_IT, LocalLlmModels.find("gemma-4-e2b-it"))

        // A silent fallback here would be a real failure mode rather than a hypothetical: the
        // catalog used to be `gemma3-1b-it-int4`, so a stale JS bundle really does ask for ids
        // this build no longer ships. Every caller (getModelStatus/downloadModel/loadModel)
        // rejects on null; returning "the one model we have" would download and load something
        // the caller did not ask for.
        assertNull(LocalLlmModels.find("gemma3-1b-it-int4"))
        assertNull(LocalLlmModels.find(""))
        assertNull(LocalLlmModels.find("GEMMA-4-E2B-IT"))
        assertNull(LocalLlmModels.find("qwen3-1.7b-int4"))
        // Dropped on 2026-10-13: the 0.6B could not hold the tool protocol, Qwen2.5 had no tool slot.
        assertNull(LocalLlmModels.find("qwen3-0.6b-int4"))
        assertNull(LocalLlmModels.find("qwen2.5-1.5b-instruct"))
    }

    // ---- catalog invariants ---------------------------------------------------------------

    @Test
    fun the_catalog_offers_exactly_the_two_models_in_the_v2_contract() {
        assertEquals(
            listOf("gemma-4-e2b-it", "gemma-4-e4b-it"),
            LocalLlmModels.ALL.map { it.modelId },
        )
    }

    @Test
    fun ids_and_file_names_are_unique_because_both_are_used_as_keys() {
        // modelId keys the WorkManager unique-work name and every find(); fileName is the path under
        // modelsDir(). Two entries sharing either would have one download overwrite or shadow the other.
        assertEquals(LocalLlmModels.ALL.size, LocalLlmModels.ALL.map { it.modelId }.toSet().size)
        assertEquals(LocalLlmModels.ALL.size, LocalLlmModels.ALL.map { it.fileName }.toSet().size)
        assertEquals(
            "a .part file for one model must not collide with another model's file",
            LocalLlmModels.ALL.size * 2,
            LocalLlmModels.ALL.flatMap { listOf(it.fileName, it.fileName + MODEL_TMP_SUFFIX) }.toSet().size,
        )
    }

    @Test
    fun every_entry_has_a_positive_size_a_real_commit_and_a_litertlm_bundle() {
        for (info in LocalLlmModels.ALL) {
            assertTrue("${info.modelId}: sizeBytes must be positive", info.sizeBytes > 0)
            assertTrue("${info.modelId}: minDeviceMemoryBytes must be positive", info.minDeviceMemoryBytes > 0)
            // 40 lowercase hex characters is a git commit id; anything else ("main", a tag, a short hash)
            // is a moving or ambiguous ref, which is exactly what the pinned size cannot tolerate.
            assertTrue(
                "${info.modelId}: commitHash must be a full 40-character git commit id, got '${info.commitHash}'",
                Regex("^[0-9a-f]{40}$").matches(info.commitHash),
            )
            assertTrue("${info.modelId}: not a LiteRT-LM bundle: ${info.fileName}", info.fileName.endsWith(".litertlm"))
            // The Hugging Face repository the native side builds the one allowed download url from.
            assertTrue(
                "${info.modelId}: hfRepo must be <owner>/<name>, got '${info.hfRepo}'",
                Regex("^[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._-]*$").matches(info.hfRepo),
            )
            assertTrue("${info.modelId}: maxTokens", info.defaultMaxTokens > 0)
            assertTrue("${info.modelId}: topK", info.defaultTopK > 0)
            assertTrue("${info.modelId}: topP", info.defaultTopP in 0.0..1.0)
            assertTrue("${info.modelId}: temperature", info.defaultTemperature >= 0.0)
        }
    }

    @Test
    fun the_default_accelerator_is_the_first_listed_one_and_is_one_the_model_supports() {
        for (info in LocalLlmModels.ALL) {
            assertEquals(info.accelerators.first(), info.defaultAccelerator.wire)
            assertTrue(info.supportsAccelerator(info.defaultAccelerator))
            assertEquals("${info.modelId}: an accelerator listed twice", info.accelerators.size, info.accelerators.toSet().size)
            // Every model must be able to fall back to the CPU — it is what a failed GPU init retries on.
            assertTrue("${info.modelId} must run on the CPU", info.supportsAccelerator(LocalLlmAccelerator.CPU))
        }
        // The CPU: the GPU backend corrupts digits read from tool responses with Gemma 4 on this runtime.
        assertEquals(LocalLlmAccelerator.CPU, LocalLlmModels.GEMMA_4_E2B_IT.defaultAccelerator)
        assertEquals(LocalLlmAccelerator.CPU, LocalLlmModels.GEMMA_4_E4B_IT.defaultAccelerator)
    }

    @Test
    fun capabilities_are_what_each_model_can_actually_do() {
        // Load-bearing, not decorative: loadModel binds tools only when `tools` is listed, generate
        // sends enable_thinking=true only when `thinking` is, and images are refused without `vision`.
        assertEquals(setOf("thinking", "vision", "tools"), LocalLlmModels.GEMMA_4_E2B_IT.capabilities)
        assertEquals(setOf("thinking", "vision", "tools"), LocalLlmModels.GEMMA_4_E4B_IT.capabilities)

        assertTrue(LocalLlmModels.GEMMA_4_E4B_IT.supportsVision)
        assertTrue(LocalLlmModels.GEMMA_4_E2B_IT.supportsVision)
        assertTrue(LocalLlmModels.GEMMA_4_E2B_IT.supportsThinking)
        // Every model in the catalog can call tools: a phone that cannot hold one of these has no offline chat.
        for (info in LocalLlmModels.ALL) {
            assertTrue(info.modelId, info.supportsTools)
        }
    }

    @Test
    fun only_the_gemma_models_fix_their_thinking_mode_at_the_first_turn() {
        // Measured on Gemma 4 E2B (LiteRT-LM 0.14.0): a conversation that began without thinking never
        // thinks on a later turn, so the engine starts a fresh one when the mode changes. Qwen3 honours
        // the flag every turn, and must not pay for a new conversation (lost history) to toggle it.
        assertTrue(LocalLlmModels.GEMMA_4_E2B_IT.thinkingFixedPerConversation)
        assertTrue(LocalLlmModels.GEMMA_4_E4B_IT.thinkingFixedPerConversation)
        // Only meaningful for a model that can think at all.
        for (info in LocalLlmModels.ALL.filter { it.thinkingFixedPerConversation }) {
            assertTrue(info.modelId, info.supportsThinking)
        }
    }

    @Test
    fun the_availability_floor_is_the_smallest_models_ram_requirement() {
        // 6 GB: Gemma 4 E2B on the CPU (its GPU needs 8 GB, see gpuMinDeviceMemoryBytes). Below that a phone is
        // refused on-device chat outright rather than offered a model that cannot follow the tool protocol
        // (Qwen3-0.6B) or that does not fit (Qwen3-1.7B), both dropped 2026-10-13.
        assertEquals(6L * 1024 * 1024 * 1024, LocalLlmModels.smallestMinDeviceMemoryBytes)
        assertEquals(LocalLlmModels.GEMMA_4_E2B_IT.minDeviceMemoryBytes, LocalLlmModels.smallestMinDeviceMemoryBytes)
        // The GPU floors: E2B's is above its own floor, E4B's equals it (12 GB holds it either way).
        assertEquals(8L * 1024 * 1024 * 1024, LocalLlmModels.GEMMA_4_E2B_IT.gpuMinDeviceMemoryBytes)
        assertEquals(LocalLlmModels.GEMMA_4_E4B_IT.minDeviceMemoryBytes, LocalLlmModels.GEMMA_4_E4B_IT.gpuMinDeviceMemoryBytes)
        for (info in LocalLlmModels.ALL) {
            assertTrue("${info.modelId}: GPU floor under the model's floor", info.gpuMinDeviceMemoryBytes >= info.minDeviceMemoryBytes)
        }
    }

    @Test
    fun an_unknown_capability_or_accelerator_fails_loudly_at_construction() {
        val base = LocalLlmModels.GEMMA_4_E2B_IT
        assertThrows { base.copy(capabilities = setOf("telepathy")) }
        assertThrows { base.copy(accelerators = listOf("npu")) }
        assertThrows { base.copy(accelerators = emptyList()) }
    }

    // ---- the Kotlin source literals the web-side contract test parses -------------------------

    /**
     * A contract test in the web suite regex-parses `LocalLlmModels.kt` and compares it to
     * `definitions.ts`. It only sees the plain `field = literal` form, so an entry rewritten as
     * `4L * GIB` would drop out of that check without failing anything. This holds the source to the
     * form the parser reads, and pins each parsed value to the catalog the runtime actually uses.
     */
    @Test
    fun the_kotlin_source_keeps_the_literal_forms_the_web_contract_test_parses() {
        val source = RepoFiles.read(LOCAL_LLM_MODELS_KT)

        fun literals(pattern: String): List<String> =
            Regex(pattern, RegexOption.MULTILINE).findAll(source).map { it.groupValues[1] }.toList()

        assertEquals(LocalLlmModels.ALL.map { it.modelId }, literals("""^\s+modelId = "([^"]+)",$"""))
        assertEquals(LocalLlmModels.ALL.map { it.commitHash }, literals("""^\s+commitHash = "([^"]+)",$"""))
        assertEquals(LocalLlmModels.ALL.map { it.hfRepo }, literals("""^\s+hfRepo = "([^"]+)",$"""))
        assertEquals(
            LocalLlmModels.ALL.map { it.sizeBytes },
            literals("""^\s+sizeBytes = ([0-9_]+)L,$""").map { it.replace("_", "").toLong() },
        )
        assertEquals(
            LocalLlmModels.ALL.map { it.minDeviceMemoryBytes },
            literals("""^\s+minDeviceMemoryBytes = ([0-9_]+)L,$""").map { it.replace("_", "").toLong() },
        )
        assertEquals(
            LocalLlmModels.ALL.map { it.gpuMinDeviceMemoryBytes },
            literals("""^\s+gpuMinDeviceMemoryBytes = ([0-9_]+)L,$""").map { it.replace("_", "").toLong() },
        )
        assertEquals(LocalLlmModels.ALL.map { it.fileName }, literals("""^\s+fileName = "([^"]+)",$"""))
    }

    // ---- the cross-language contract with definitions.ts --------------------------------------

    /**
     * The catalog is split across two languages that never see each other: JS owns the
     * download `url` (it is what `downloadModel` is called with), native owns the on-disk
     * `fileName` the bytes are written under and the `sizeBytes` the worker verifies. Nothing
     * checks that the file named in the URL and the file written to disk are the same file.
     *
     * A mismatch is close to undebuggable from the symptom: the right bytes arrive, get stored
     * under the wrong name, and `Engine.load()` opens a bundle whose contents are some other
     * model — or, if the sizes also disagree, every download fails on its last byte with
     * "did not match expected size" and no hint about which half is wrong. That is not a
     * hypothetical: it is how every Qwen3 download failed once `resolve/main` grew from
     * 344,437,808 to 344,671,744 bytes (and that newer file no longer loads on LiteRT-LM 0.14.0 at all).
     *
     * So the assertion is against `src/definitions.ts` itself rather than against the literals in
     * [LocalLlmModels]: restating those would only detect an edit to the thing being restated,
     * which is what an intentional model swap looks like too.
     */
    @Test
    fun the_typescript_catalogue_and_this_one_agree_on_every_model_field_by_field() {
        val definitions = RepoFiles.read(LOCAL_LLM_DEFINITIONS)

        for (info in LocalLlmModels.ALL) {
            val entry = typescriptModelEntry(definitions, info.modelId)
            val url = requireNotNull(stringField(entry, "url")) {
                "LOCAL_LLM_MODELS['${info.modelId}'] in $LOCAL_LLM_DEFINITIONS declares no url"
            }

            // The basename of the Hugging Face `resolve` link, minus its `?download=true`.
            val downloadedFileName = url.substringBefore('?').substringAfterLast('/')
            assertEquals(
                "${info.modelId}: the JS catalogue downloads $downloadedFileName but the native catalogue " +
                    "writes and loads ${info.fileName}. modelFile()/deleteModel()/Engine.load() all use the " +
                    "native name, so the wrong bundle would sit under the right one.",
                info.fileName,
                downloadedFileName,
            )

            // Pinned: `<repo>/resolve/<40-hex commit>/<file>`, never `resolve/main`.
            assertFalse("${info.modelId}: the url follows a moving ref: $url", url.contains("/resolve/main/"))
            assertEquals(
                "${info.modelId}: commitHash disagrees across the bridge",
                info.commitHash,
                requireNotNull(stringField(entry, "commitHash")),
            )
            assertTrue(
                "${info.modelId}: url is not pinned to commit ${info.commitHash}: $url",
                url.contains("/resolve/${info.commitHash}/"),
            )
            // The whole path, not just the commit: the native side derives the one url it will fetch from
            // hfRepo + commitHash + fileName, so the JS catalogue's url must start with exactly that.
            val derivedPrefix = "https://huggingface.co/${info.hfRepo}/resolve/${info.commitHash}/${info.fileName}"
            assertTrue(
                "${info.modelId}: the JS url ($url) must start with the url the native side derives ($derivedPrefix)",
                url.startsWith(derivedPrefix),
            )

            assertEquals(
                "${info.modelId}: sizeBytes disagrees across the bridge. The worker's final length check " +
                    "uses the native value, so a JS-side edit alone makes every download fail on its last byte.",
                info.sizeBytes,
                numberField(entry, "sizeBytes"),
            )
            assertEquals("${info.modelId}: minDeviceMemoryBytes", info.minDeviceMemoryBytes, gibField(entry, "minDeviceMemoryBytes"))
            assertEquals("${info.modelId}: gpuMinDeviceMemoryBytes", info.gpuMinDeviceMemoryBytes, gibField(entry, "gpuMinDeviceMemoryBytes"))

            assertEquals("${info.modelId}: capabilities", info.capabilities, stringListField(entry, "capabilities").toSet())
            assertEquals("${info.modelId}: accelerators (order is the default)", info.accelerators, stringListField(entry, "accelerators"))
            assertTrue(
                "${info.modelId}: every model in this catalog ships on Android",
                "android" in stringListField(entry, "platforms"),
            )

            val config = defaultConfig(entry)
            assertEquals("${info.modelId}: defaultConfig.topK", info.defaultTopK.toDouble(), config.getValue("topK"), 0.0)
            assertEquals("${info.modelId}: defaultConfig.topP", info.defaultTopP, config.getValue("topP"), 0.0)
            assertEquals("${info.modelId}: defaultConfig.temperature", info.defaultTemperature, config.getValue("temperature"), 0.0)
            assertEquals("${info.modelId}: defaultConfig.maxTokens", info.defaultMaxTokens.toDouble(), config.getValue("maxTokens"), 0.0)

            // And the url the JS catalogue will hand to downloadModel is one the native policy accepts.
            assertNull(
                "${info.modelId}: the native download-url check rejects the JS catalogue's own url",
                LocalLlmPolicy.downloadUrlProblem(info, url),
            )
        }
    }

    /**
     * The reverse direction: a model added to `LOCAL_LLM_MODELS` in TypeScript but not to
     * [LocalLlmModels] compiles, ships, and reaches `downloadModel` — which rejects the id at
     * runtime, on the user's device, as if the model did not exist. Android is the only platform
     * that consumes this catalogue in full, so nothing else would catch the omission.
     */
    @Test
    fun every_model_the_typescript_catalogue_offers_is_one_this_build_can_resolve_and_vice_versa() {
        val definitions = RepoFiles.read(LOCAL_LLM_DEFINITIONS)
        val declaredIds = typescriptModelIds(definitions)

        assertTrue("found no LOCAL_LLM_MODELS entries in $LOCAL_LLM_DEFINITIONS — has it moved?", declaredIds.isNotEmpty())
        for (modelId in declaredIds) {
            assertNotNull(
                "$LOCAL_LLM_DEFINITIONS offers '$modelId' but LocalLlmModels.find() does not know it; " +
                    "downloadModel/loadModel would reject it at runtime.",
                LocalLlmModels.find(modelId),
            )
        }
        assertEquals(
            "LocalLlmModels ships a model that $LOCAL_LLM_DEFINITIONS does not offer",
            declaredIds.toSet(),
            LocalLlmModels.ALL.map { it.modelId }.toSet(),
        )
    }

    private fun assertThrows(block: () -> Unit) {
        try {
            block()
        } catch (expected: IllegalArgumentException) {
            return
        }
        throw AssertionError("expected an IllegalArgumentException")
    }

    private companion object {
        const val LOCAL_LLM_DEFINITIONS = "frontend/packages/capacitor-local-llm/src/definitions.ts"
        const val LOCAL_LLM_MODELS_KT =
            "frontend/packages/capacitor-local-llm/android/src/main/java/com/companionintelligence/localllm/LocalLlmModels.kt"

        /** The body of `LOCAL_LLM_MODELS`, from the opening brace to the `} as const`. */
        fun localLlmModelsBlock(definitions: String): String {
            val start = definitions.indexOf("export const LOCAL_LLM_MODELS")
            check(start >= 0) { "LOCAL_LLM_MODELS is gone from $LOCAL_LLM_DEFINITIONS" }
            val end = definitions.indexOf("} as const", start)
            check(end >= 0) { "LOCAL_LLM_MODELS in $LOCAL_LLM_DEFINITIONS no longer closes with `} as const`" }
            return definitions.substring(start, end)
        }

        fun typescriptModelIds(definitions: String): List<String> =
            Regex("""^\s{2}'([^']+)':\s*\{""", RegexOption.MULTILINE)
                .findAll(localLlmModelsBlock(definitions))
                .map { it.groupValues[1] }
                .toList()

        /** The literal text of one model's object, so field lookups cannot stray into a sibling. */
        fun typescriptModelEntry(definitions: String, modelId: String): String {
            val block = localLlmModelsBlock(definitions)
            val start = block.indexOf("'$modelId': {")
            check(start >= 0) { "$LOCAL_LLM_DEFINITIONS no longer declares a '$modelId' model" }
            val end = block.indexOf("\n  },", start)
            return block.substring(start, if (end >= 0) end else block.length)
        }

        fun stringField(entry: String, field: String): String? =
            Regex("""\b$field:\s*'([^']*)'""").find(entry)?.groupValues?.get(1)

        /** TypeScript numeric separators (`344_437_808`) are not part of the value. */
        fun numberField(entry: String, field: String): Long {
            val raw = Regex("""\b$field:\s*([0-9_]+)\s*,""").find(entry)?.groupValues?.get(1)
            return requireNotNull(raw) { "no plain numeric `$field` in $entry" }.replace("_", "").toLong()
        }

        /** `minDeviceMemoryBytes: 4 * GIB` — a whole number of GiB. */
        fun gibField(entry: String, field: String): Long {
            val raw = Regex("""\b$field:\s*([0-9]+)\s*\*\s*GIB""").find(entry)?.groupValues?.get(1)
            return requireNotNull(raw) { "no `<n> * GIB` value for `$field` in $entry" }.toLong() * 1024L * 1024L * 1024L
        }

        fun stringListField(entry: String, field: String): List<String> {
            val body = Regex("""\b$field:\s*\[([^\]]*)\]""").find(entry)?.groupValues?.get(1)
            return requireNotNull(body) { "no `$field` list in $entry" }.let { list ->
                Regex("""'([^']*)'""").findAll(list).map { it.groupValues[1] }.toList()
            }
        }

        /** `defaultConfig: { topK: 64, topP: 0.95, temperature: 1.0, maxTokens: 1024 }` as name -> number. */
        fun defaultConfig(entry: String): Map<String, Double> {
            val body = Regex("""\bdefaultConfig:\s*\{([^}]*)\}""").find(entry)?.groupValues?.get(1)
            return requireNotNull(body) { "no `defaultConfig` in $entry" }.let { config ->
                Regex("""(\w+):\s*([0-9._]+)""").findAll(config).associate { it.groupValues[1] to it.groupValues[2].replace("_", "").toDouble() }
            }
        }
    }
}
