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
    /** File name written under {@link modelsDir}; also the LiteRT-LM `.task` file name. */
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
     * litert-community/Gemma3-1B-IT, `Gemma3-1B-IT_multi-prefill-seq_q4_ekv2048.task`
     * (2025-05-14 build). Only model offered today — smallest broadly-capable option.
     */
    val GEMMA3_1B_IT_INT4 = LocalLlmModelInfo(
        modelId = "gemma3-1b-it-int4",
        fileName = "Gemma3-1B-IT_multi-prefill-seq_q4_ekv2048.task",
        sizeBytes = 554_661_246L,
        estimatedPeakMemoryBytes = 2_147_483_648L,
        defaultMaxTokens = 1024,
        defaultTopK = 64,
        defaultTopP = 0.95,
        defaultTemperature = 1.0,
    )

    private val byId = listOf(GEMMA3_1B_IT_INT4).associateBy { it.modelId }

    fun find(modelId: String): LocalLlmModelInfo? = byId[modelId]
}

/** Minimum *total* device RAM to consider the on-device model runnable at all (~3 GiB). */
const val MIN_TOTAL_MEMORY_BYTES = 3L * 1024 * 1024 * 1024

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
