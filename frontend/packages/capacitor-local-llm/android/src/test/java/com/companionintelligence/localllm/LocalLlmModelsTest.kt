package com.companionintelligence.localllm

import org.junit.Assert.assertEquals
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
    fun an_unknown_model_id_is_rejected_rather_than_falling_back_to_the_only_entry() {
        assertSame(LocalLlmModels.QWEN3_0_6B_INT4, LocalLlmModels.find("qwen3-0.6b-int4"))

        // A silent fallback here would be a real failure mode rather than a hypothetical: the
        // catalog used to be `gemma3-1b-it-int4`, so a stale JS bundle really does ask for ids
        // this build no longer ships. Every caller (getModelStatus/downloadModel/loadModel)
        // rejects on null; returning "the one model we have" would download and load something
        // the caller did not ask for.
        assertNull(LocalLlmModels.find("gemma3-1b-it-int4"))
        assertNull(LocalLlmModels.find(""))
        assertNull(LocalLlmModels.find("QWEN3-0.6B-INT4"))
    }

    /**
     * The catalog is split across two languages that never see each other: JS owns the
     * download `url` (it is what `downloadModel` is called with), native owns the on-disk
     * `fileName` the bytes are written under and the `sizeBytes` the worker verifies. Nothing
     * checks that the file named in the URL and the file written to disk are the same file.
     *
     * A mismatch is close to undebuggable from the symptom: the right bytes arrive, get stored
     * under the wrong name, and `Engine.load()` opens a bundle whose contents are some other
     * model — or, if the sizes also disagree, every download fails on its last byte with
     * "did not match expected size" and no hint about which half is wrong.
     *
     * So the assertion is against `src/definitions.ts` itself rather than against the literals
     * twenty lines above in [LocalLlmModels]: restating those would only detect an edit to the
     * thing being restated, which is what an intentional model swap looks like too.
     */
    @Test
    fun the_typescript_catalogue_and_this_one_name_the_same_bundle_at_the_same_size() {
        val definitions = RepoFiles.read(LOCAL_LLM_DEFINITIONS)
        val info = LocalLlmModels.QWEN3_0_6B_INT4

        val entry = typescriptModelEntry(definitions, info.modelId)
        val url = requireNotNull(stringField(entry, "url")) {
            "LOCAL_LLM_MODELS['${info.modelId}'] in $LOCAL_LLM_DEFINITIONS declares no url"
        }

        // The basename of the Hugging Face `resolve` link, minus its `?download=true`.
        val downloadedFileName = url.substringBefore('?').substringAfterLast('/')
        assertEquals(
            "The JS catalogue downloads $downloadedFileName but the native catalogue writes and " +
                "loads ${info.fileName}. modelFile()/deleteModel()/Engine.load() all use the native " +
                "name, so the wrong bundle would sit under the right one.",
            info.fileName,
            downloadedFileName,
        )

        // `.litertlm` is LiteRT-LM's own bundle format and nothing checks it at compile time —
        // Engine.load() simply fails on a `.task` or a `.gguf`, after the whole file has been
        // fetched over the user's connection.
        assertTrue("the bundle must be a LiteRT-LM one: ${info.fileName}", info.fileName.endsWith(".litertlm"))

        assertEquals(
            "sizeBytes disagrees across the bridge. The worker's final length check uses the " +
                "native value, so a JS-side edit alone makes every download fail on its last byte.",
            info.sizeBytes,
            numberField(entry, "sizeBytes"),
        )
    }

    /**
     * The reverse direction: a model added to `LOCAL_LLM_MODELS` in TypeScript but not to
     * [LocalLlmModels] compiles, ships, and reaches `downloadModel` — which rejects the id at
     * runtime, on the user's device, as if the model did not exist. Android is the only platform
     * that consumes this catalogue, so nothing else would catch the omission.
     */
    @Test
    fun every_model_the_typescript_catalogue_offers_is_one_this_build_can_resolve() {
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
    }

    private companion object {
        const val LOCAL_LLM_DEFINITIONS = "frontend/packages/capacitor-local-llm/src/definitions.ts"

        /** The body of `LOCAL_LLM_MODELS`, from the opening brace to the `} as const;`. */
        fun localLlmModelsBlock(definitions: String): String {
            val start = definitions.indexOf("export const LOCAL_LLM_MODELS")
            check(start >= 0) { "LOCAL_LLM_MODELS is gone from $LOCAL_LLM_DEFINITIONS" }
            val end = definitions.indexOf("} as const;", start)
            check(end >= 0) { "LOCAL_LLM_MODELS in $LOCAL_LLM_DEFINITIONS no longer closes with `} as const;`" }
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
            val raw = Regex("""\b$field:\s*([0-9_]+)""").find(entry)?.groupValues?.get(1)
            return requireNotNull(raw) { "no numeric `$field` in $entry" }.replace("_", "").toLong()
        }
    }
}
