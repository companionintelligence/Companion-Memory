package com.companionintelligence.localllm

import android.content.Context
import java.io.File

/** Which compute backend runs a model. `wire` is the string the JS contract uses. */
enum class LocalLlmAccelerator(val wire: String) {
    CPU("cpu"),
    GPU("gpu"),
    ;

    companion object {
        fun fromWire(value: String?): LocalLlmAccelerator? = entries.firstOrNull { it.wire == value }
    }
}

/**
 * Static metadata for a downloadable on-device model. Mirrors (and must stay in sync
 * with) `LOCAL_LLM_MODELS` in `src/definitions.ts` — `LocalLlmModelsTest` parses that file and
 * fails on any drift in id, file name, size, pinned commit, RAM floor, defaults, capabilities or
 * accelerators. The JS side owns the download `url` (it is what gets passed to `downloadModel`);
 * the native side owns everything needed to write, verify, and load the file, and refuses a url
 * that is not this model's pinned one (see [LocalLlmPolicy.downloadUrlProblem]).
 *
 * Keep every entry below in the plain `field = literal` form, one field per line: a contract test
 * on the web side regex-parses this file and compares it to `definitions.ts`, so an expression
 * like `4L * GIB` would silently fall out of that check.
 */
data class LocalLlmModelInfo(
    val modelId: String,
    /**
     * The Hugging Face repository the file is downloaded from, `<owner>/<name>`. Together with
     * [commitHash] and [fileName] it fixes the *one* url this model may be fetched from —
     * `https://huggingface.co/<hfRepo>/resolve/<commitHash>/<fileName>` — which the native side derives
     * itself ([LocalLlmPolicy.downloadUrlFor]) instead of trusting the url `downloadModel` is called with.
     */
    val hfRepo: String,
    /** File name written under {@link modelsDir}; also the LiteRT-LM bundle file name. */
    val fileName: String,
    /** Exact size of the pinned file. The download worker rejects any other length. */
    val sizeBytes: Long,
    /** The Hugging Face commit the download url is pinned to — never `main`, which moves. */
    val commitHash: String,
    /** Advertised device RAM below which the model is refused (see [LocalLlmPolicy.advertisedMemoryBytes]). */
    val minDeviceMemoryBytes: Long,
    /**
     * Advertised device RAM below which the GPU backend is withheld and the model runs on the CPU, whatever
     * was asked for. Never under [minDeviceMemoryBytes]. The GPU backend expands int4 weights to fp16 in
     * graphics memory — measured on a Galaxy S23 Ultra (2026-10-13): Gemma 4 E2B takes 2.4 GB of graphics
     * memory and 3.3 GB in all on the GPU, against 0.2 GB and 2.3 GB on the CPU — so a phone that can hold
     * the model on the CPU cannot necessarily hold it on the GPU. See [LocalLlmPolicy.resolveAccelerator].
     */
    val gpuMinDeviceMemoryBytes: Long,
    val defaultMaxTokens: Int,
    val defaultTopK: Int,
    val defaultTopP: Double,
    val defaultTemperature: Double,
    /** Subset of [CAPABILITY_THINKING], [CAPABILITY_VISION], [CAPABILITY_TOOLS]. */
    val capabilities: Set<String>,
    /** Backends the model runs on, best first, as [LocalLlmAccelerator.wire] strings. */
    val accelerators: List<String>,
    /**
     * True when the model's chat template renders `enable_thinking` into the conversation's *first*
     * turn only, so a later turn cannot switch it. Native-only — it has no counterpart in
     * `definitions.ts` — and measured, not assumed: on Gemma 4 E2B (LiteRT-LM 0.14.0) a turn asking
     * for thinking after a first turn that did not produced no `thought` channel at all, while the same
     * request as a conversation's first turn did. Qwen3 honours it per turn. [LocalLlmEngine] starts a
     * fresh conversation when a request's thinking mode differs from the one the conversation began with.
     */
    val thinkingFixedPerConversation: Boolean = false,
) {
    init {
        require(capabilities.all { it in KNOWN_CAPABILITIES }) { "$modelId declares an unknown capability: $capabilities" }
        require(accelerators.isNotEmpty() && accelerators.all { LocalLlmAccelerator.fromWire(it) != null }) {
            "$modelId declares an unknown accelerator: $accelerators"
        }
        require(gpuMinDeviceMemoryBytes >= minDeviceMemoryBytes) {
            "$modelId: the GPU floor ($gpuMinDeviceMemoryBytes) is under the model's floor ($minDeviceMemoryBytes)"
        }
    }

    val supportsThinking: Boolean get() = CAPABILITY_THINKING in capabilities
    val supportsVision: Boolean get() = CAPABILITY_VISION in capabilities
    val supportsTools: Boolean get() = CAPABILITY_TOOLS in capabilities

    /** The model's first listed accelerator — what a `loadModel` with no `accelerator` gets. */
    val defaultAccelerator: LocalLlmAccelerator
        get() = LocalLlmAccelerator.fromWire(accelerators.first())!!

    fun supportsAccelerator(accelerator: LocalLlmAccelerator): Boolean = accelerator.wire in accelerators

    companion object {
        const val CAPABILITY_THINKING = "thinking"
        const val CAPABILITY_VISION = "vision"
        const val CAPABILITY_TOOLS = "tools"
        val KNOWN_CAPABILITIES = setOf(CAPABILITY_THINKING, CAPABILITY_VISION, CAPABILITY_TOOLS)
    }
}

object LocalLlmModels {
    /** litert-community/gemma-4-E2B-it-litert-lm — multimodal Gemma 4, Android only. */
    val GEMMA_4_E2B_IT = LocalLlmModelInfo(
        modelId = "gemma-4-e2b-it",
        hfRepo = "litert-community/gemma-4-E2B-it-litert-lm",
        fileName = "gemma-4-E2B-it.litertlm",
        sizeBytes = 2_588_147_712L,
        commitHash = "361a4010ad6d88fc5c86e148e333c0342b99763d",
        // 6 GB on the CPU (2.3 GB resident), the GPU from 8 GB (3.3 GB resident) — measured, see the field's doc.
        minDeviceMemoryBytes = 6_442_450_944L,
        gpuMinDeviceMemoryBytes = 8_589_934_592L,
        defaultMaxTokens = 4000,
        defaultTopK = 64,
        defaultTopP = 0.95,
        defaultTemperature = 1.0,
        capabilities = setOf("thinking", "vision", "tools"),
        // CPU first (2026-10-13): the GPU backend corrupts digits read from tool responses with Gemma 4 on
        // LiteRT-LM 0.18 (#2202, open, no fix); the CPU reads them exactly. The GPU stays an explicit choice.
        accelerators = listOf("cpu", "gpu"),
        thinkingFixedPerConversation = true,
    )

    /** litert-community/gemma-4-E4B-it-litert-lm — the larger Gemma 4, Android only. */
    val GEMMA_4_E4B_IT = LocalLlmModelInfo(
        modelId = "gemma-4-e4b-it",
        hfRepo = "litert-community/gemma-4-E4B-it-litert-lm",
        fileName = "gemma-4-E4B-it.litertlm",
        sizeBytes = 3_654_467_584L,
        commitHash = "9695417f248178c63a9f318c6e0c56cb917cb837",
        minDeviceMemoryBytes = 12_884_901_888L,
        gpuMinDeviceMemoryBytes = 12_884_901_888L,
        defaultMaxTokens = 4000,
        defaultTopK = 64,
        defaultTopP = 0.95,
        defaultTemperature = 1.0,
        capabilities = setOf("thinking", "vision", "tools"),
        // CPU first (2026-10-13): the GPU backend corrupts digits read from tool responses with Gemma 4 on
        // LiteRT-LM 0.18 (#2202, open, no fix); the CPU reads them exactly. The GPU stays an explicit choice.
        accelerators = listOf("cpu", "gpu"),
        thinkingFixedPerConversation = true,
    )

    /** Every model this build can download and load, smallest first. */
    val ALL: List<LocalLlmModelInfo> = listOf(GEMMA_4_E2B_IT, GEMMA_4_E4B_IT)

    private val byId = ALL.associateBy { it.modelId }

    fun find(modelId: String): LocalLlmModelInfo? = byId[modelId]

    /**
     * The RAM a device needs before it can run *any* model here — what `isAvailable()` gates on.
     * Derived from the catalog so adding a smaller model lowers the floor without a second edit.
     */
    val smallestMinDeviceMemoryBytes: Long get() = ALL.minOf { it.minDeviceMemoryBytes }
}

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
