package com.companionintelligence.localllm

import android.content.Context
import java.io.File

/**
 * Static metadata for a downloadable on-device model. Mirrors (and must stay in sync
 * with) `LOCAL_LLM_MODELS` in `src/definitions.ts` — the JS side owns the download
 * `url` (Hugging Face `resolve` link) since that's what gets passed to `downloadModel`;
 * the native side owns everything needed to write, verify, and load the file.
 */
data class LocalLlmModelInfo(
    val modelId: String,
    /** File name written under {@link modelsDir}; also the LiteRT-LM bundle file name. */
    val fileName: String,
    val sizeBytes: Long,
    /** Approximate peak RSS while loaded, per the model card — used by isAvailable()'s RAM floor. */
    val estimatedPeakMemoryBytes: Long,
    val defaultMaxTokens: Int,
    val defaultTopK: Int,
    val defaultTopP: Double,
    val defaultTemperature: Double,
)

object LocalLlmModels {
    /**
     * litert-community/Qwen3-0.6B, `Qwen3-0.6B_dynamic_wi4b32_afp32.litertlm`. Only model
     * offered today — and, as of this catalog entry, the *same* model and file iOS ships
     * (`LocalLLMModels.swift`), not the `gemma3-1b-it-int4` this used to point at.
     *
     * That older entry sat on `litert-community/Gemma3-1B-IT`, which Hugging Face now
     * serves `gated: "auto"`: an anonymous in-app download got `401 GatedRepo` for every
     * user who had not already fetched the file by hand — every new install, with no
     * workaround short of hand-pushing the file. Qwen3-0.6B is ungated (re-verified before
     * this change: `curl -s .../api/models/litert-community/Qwen3-0.6B` → `"gated": false`;
     * a ranged download returns `206`/`accept-ranges: bytes`) and roughly a third the size.
     * `.litertlm` is the engine's own bundle format, not a platform split from `.task` — the
     * same repo publishes both for different models, and this loads via `Engine.load()`
     * exactly like the `.task` file this used to list.
     */
    val QWEN3_0_6B_INT4 = LocalLlmModelInfo(
        modelId = "qwen3-0.6b-int4",
        fileName = "Qwen3-0.6B_dynamic_wi4b32_afp32.litertlm",
        sizeBytes = 344_437_808L,
        estimatedPeakMemoryBytes = 2_147_483_648L,
        defaultMaxTokens = 1024,
        defaultTopK = 64,
        defaultTopP = 0.95,
        defaultTemperature = 1.0,
    )

    private val byId = listOf(QWEN3_0_6B_INT4).associateBy { it.modelId }

    fun find(modelId: String): LocalLlmModelInfo? = byId[modelId]
}

/**
 * Minimum *total* device RAM to consider the on-device model runnable at all (~4 GiB).
 *
 * Reconciled with iOS's floor (`LocalLLMPlugin.minimumPhysicalMemoryBytes`), which used to
 * be 6 GiB against this file's 3 GiB for models with the same ~2 GiB estimated peak RSS —
 * an unexplained 2x gap between platforms gating the identical workload. 4 GiB is that ~2 GiB
 * footprint plus ~2 GiB of headroom for the OS, the WebView, and the rest of the app before
 * jetsam/the low-memory killer takes the process rather than `isAvailable()` politely
 * declining up front.
 */
const val MIN_TOTAL_MEMORY_BYTES = 4L * 1024 * 1024 * 1024

/** Minimum free disk space required to start (or resume) a model download (~1 GiB). */
const val MIN_FREE_DISK_BYTES = 1L * 1024 * 1024 * 1024

const val EVENT_DOWNLOAD_PROGRESS = "modelDownloadProgress"
const val EVENT_TOKEN = "llmToken"

/** Suffix for an in-progress download's partial file, resumed via HTTP `Range`. */
const val MODEL_TMP_SUFFIX = ".part"

/** App-private directory models are downloaded into; cleared automatically on uninstall. */
fun modelsDir(context: Context): File = File(context.filesDir, "local-llm-models")

fun modelFile(context: Context, info: LocalLlmModelInfo): File = File(modelsDir(context), info.fileName)

fun tmpModelFile(context: Context, info: LocalLlmModelInfo): File =
    File(modelsDir(context), "${info.fileName}$MODEL_TMP_SUFFIX")

/** WorkManager unique-work name for a model's download — one in-flight download per model. */
fun uniqueDownloadWorkName(modelId: String): String = "local-llm-download-$modelId"
