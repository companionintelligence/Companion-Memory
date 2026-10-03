package com.companionintelligence.localllm

import android.app.ActivityManager
import android.content.Context
import android.os.Build
import android.util.Log
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkInfo
import androidx.work.WorkManager
import com.companionintelligence.localllm.intents.CompanionIntentClient
import com.companionintelligence.localllm.intents.IntentToolProvider
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.util.concurrent.CancellationException
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong
import kotlinx.coroutines.CoroutineExceptionHandler
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONException

private const val TAG = "LocalLlmPlugin"
private const val DOWNLOAD_POLL_INTERVAL_MS = 500L

/**
 * How long `cancelDownload` / `deleteModel` wait for a cancelled download worker to actually stop before
 * touching its files. The worker tears its socket down the moment it is cancelled, so this is normally
 * milliseconds; it is a bound, not a delay.
 */
private const val DOWNLOAD_STOP_TIMEOUT_MS = 5_000L

/**
 * Android on-device LLM plugin (Google LiteRT-LM). See `src/definitions.ts` for the
 * JS-facing contract this implements, and `@ci/common/src/utils/nativeBridge.ts`
 * (`generateOffline`) for how the web app actually calls it — always behind
 * `isAvailable()`, with a fallback to the remote `/api/llm/generate` endpoint.
 *
 * All methods do their real work off the UI thread via [pluginScope] (`Dispatchers.IO`);
 * Capacitor already dispatches `@PluginMethod` calls off the main thread, but the extra
 * scope also gives model load/generate/download a lifecycle tied to the plugin instance
 * (cancelled in [handleOnDestroy]) instead of Capacitor's own call-handling thread.
 */
@CapacitorPlugin(name = "LocalLLM")
class LocalLlmPlugin : Plugin() {
    /**
     * The backstop: anything that escapes a launched block is logged instead of reaching the thread's uncaught
     * handler, which on Android ends the process. Calls that must be *answered* go through [launchCall], which
     * rejects them; this catches the rest (the download poller, for one).
     */
    private val pluginScope =
        CoroutineScope(
            SupervisorJob() + Dispatchers.IO +
                CoroutineExceptionHandler { _, error -> Log.e(TAG, "Unhandled error in a LocalLLM background task", error) },
        )
    private val observedDownloads = ConcurrentHashMap.newKeySet<String>()
    private lateinit var engine: LocalLlmEngine

    /** Non-null once [configureIntentTools] has been given an appliance to call. */
    @Volatile
    private var intentClient: CompanionIntentClient? = null

    /** The `(baseUrl, apiKey)` [intentClient] was built from, to tell a real reconfiguration from a repeat. */
    @Volatile
    private var intentConfig: Pair<String, String>? = null

    /**
     * Bumped each time the intent-tool configuration actually changes. Part of the engine's reuse
     * key, so `loadModel` after a reconfiguration rebuilds the conversation with the new tool set
     * instead of being short-circuited by "already loaded".
     */
    private val toolsGeneration = AtomicLong(0)

    /**
     * Keeps [LocalLlmGenerationService] running while any generation is. Best effort — see
     * [ForegroundServiceGate]: a refusal to start it must not fail, or crash, the generation.
     */
    private val foregroundService by lazy {
        ForegroundServiceGate(
            start = { LocalLlmGenerationService.start(context) },
            stop = { LocalLlmGenerationService.stop(context) },
            onFailure = { Log.w(TAG, "Foreground service unavailable; continuing without it", it) },
        )
    }

    /**
     * `pluginScope.launch` for a call that must be answered: whatever the block throws, the [call] is
     * rejected (and logged) instead of being left pending on the JS side while the process dies.
     */
    private fun launchCall(call: PluginCall, what: String, block: suspend CoroutineScope.() -> Unit) {
        pluginScope.launch {
            try {
                block()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Throwable) {
                Log.e(TAG, "$what failed", e)
                call.reject("$what failed: ${e.message}")
            }
        }
    }

    override fun load() {
        super.load()
        engine = LocalLlmEngine(context.applicationContext)
    }

    override fun handleOnDestroy() {
        // Off the calling (main) thread: unload() waits its turn behind a load() in progress, and a GPU
        // load can hold the engine for minutes — long past the 5 s an ANR takes.
        Thread({ engine.unload() }, "LocalLlm-unload").start()
        pluginScope.cancel()
        super.handleOnDestroy()
    }

    /**
     * Pure capability probe: Android API level, device RAM, and free disk space.
     * No downloads, no side effects — safe to call speculatively (e.g. to decide whether
     * to even show an "on-device model" option in settings).
     *
     * `available` means this device can run at least the *smallest* model. RAM for the bigger ones and
     * disk for any of them are per model, so they are reported (`totalMemoryBytes`, `freeDiskBytes`)
     * for the caller to compare against a model's `minDeviceMemoryBytes` / `sizeBytes`, and enforced
     * natively by `downloadModel` and `loadModel`.
     */
    @PluginMethod
    fun isAvailable(call: PluginCall) {
        val deviceMemory = deviceMemoryBytes()

        val dir = modelsDir(context)
        dir.mkdirs()

        val availability =
            LocalLlmPolicy.availability(Build.VERSION.SDK_INT, deviceMemory, LocalLlmModels.smallestMinDeviceMemoryBytes)

        val ret = JSObject()
        ret.put("available", availability.available)
        availability.reason?.let { ret.put("reason", it) }
        ret.put("totalMemoryBytes", deviceMemory)
        ret.put("freeDiskBytes", dir.usableSpace)
        call.resolve(ret)
    }

    @PluginMethod
    fun getModelStatus(call: PluginCall) {
        val modelId = call.getString("modelId")
        if (modelId == null) {
            call.reject("modelId is required")
            return
        }
        val info = LocalLlmModels.find(modelId)
        if (info == null) {
            call.reject("Unknown modelId: $modelId")
            return
        }

        launchCall(call, "Reading the model status") {
            try {
                call.resolve(currentStatus(modelId, info))
            } catch (e: Exception) {
                call.reject("Failed to read model status: ${e.message}", e)
            }
        }
    }

    @PluginMethod
    fun downloadModel(call: PluginCall) {
        val modelId = call.getString("modelId")
        val url = call.getString("url")
        if (modelId == null || url == null) {
            call.reject("modelId and url are required")
            return
        }
        val info = LocalLlmModels.find(modelId)
        if (info == null) {
            call.reject("Unknown modelId: $modelId")
            return
        }

        if (modelFile(context, info).exists()) {
            call.resolve()
            return
        }

        // The url comes from the WebView. Refuse anything that is not this model's pinned
        // huggingface.co link before a byte is fetched — see LocalLlmPolicy.downloadUrlProblem.
        LocalLlmPolicy.downloadUrlProblem(info, url)?.let {
            call.reject(it)
            return
        }
        LocalLlmPolicy.ramShortfallMessage(info, deviceMemoryBytes())?.let {
            call.reject(it)
            return
        }

        launchCall(call, "Starting the download") {
            try {
                val dir = modelsDir(context)
                dir.mkdirs()

                // An already-running or queued download is attached to (ExistingWorkPolicy.KEEP
                // below), not restarted, so it is not re-checked: free space shrinks as it fills the
                // very .part it is being compared against.
                if (!isDownloadActive(modelId)) {
                    LocalLlmPolicy.diskShortfallMessage(info, tmpModelFile(context, info).length(), dir.usableSpace)?.let {
                        call.reject(it)
                        return@launchCall
                    }
                }

                val request =
                    OneTimeWorkRequestBuilder<ModelDownloadWorker>()
                        // The worker is handed the catalog's own url, not `url`: the one from JS was only
                        // checked (above) to agree with it.
                        .setInputData(ModelDownloadWorker.inputDataFor(info))
                        .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                        .build()

                // KEEP: a second downloadModel() call for the same model (e.g. after the app was
                // killed and relaunched mid-download) attaches to the still-running/queued work
                // instead of starting a duplicate transfer.
                WorkManager.getInstance(context).enqueueUniqueWork(uniqueDownloadWorkName(modelId), ExistingWorkPolicy.KEEP, request)
                observeDownload(modelId, info)

                call.resolve()
            } catch (e: Exception) {
                call.reject("Failed to start the download: ${e.message}", e)
            }
        }
    }

    /**
     * Stops an in-flight download and drops its `.part`, then emits a final `modelDownloadProgress`
     * with `not_downloaded`. A no-op — no event either — when nothing is downloading, so it can
     * never delete a finished model or a failed download's resumable partial.
     */
    @PluginMethod
    fun cancelDownload(call: PluginCall) {
        val modelId = call.getString("modelId")
        if (modelId == null) {
            call.reject("modelId is required")
            return
        }
        val info = LocalLlmModels.find(modelId)
        if (info == null) {
            call.reject("Unknown modelId: $modelId")
            return
        }

        launchCall(call, "Cancelling the download") {
            try {
                if (isDownloadActive(modelId)) {
                    WorkManager.getInstance(context).cancelUniqueWork(uniqueDownloadWorkName(modelId)).result.get()
                    // WorkManager calls the work CANCELLED at once; the worker itself may still be mid-read.
                    // Wait for it to really stop before touching its partial file — a promise that resolved
                    // first could be followed by a new download, and both would then write the same `.part`.
                    settleDownload(modelId)
                    tmpModelFile(context, info).delete()
                    emitDownloadProgress(modelId, "not_downloaded", 0L, info.sizeBytes)
                }
                call.resolve()
            } catch (e: Exception) {
                call.reject("Failed to cancel the download: ${e.message}", e)
            }
        }
    }

    /**
     * Blocks (bounded) until no download worker for [modelId] is running in this process. If one is still
     * running after [DOWNLOAD_STOP_TIMEOUT_MS] it is logged and the caller goes on: the worker checks its
     * partial file against the offset it resumed from and stops on cancellation, so a late straggler cannot
     * promote a wrong-offset file — but it should never take this long, and someone will want to know.
     */
    private fun settleDownload(modelId: String) {
        if (!ModelDownloadWorker.activeDownloads.awaitIdle(modelId, DOWNLOAD_STOP_TIMEOUT_MS)) {
            Log.w(TAG, "The download of $modelId did not stop within ${DOWNLOAD_STOP_TIMEOUT_MS}ms of being cancelled")
        }
    }

    @PluginMethod
    fun deleteModel(call: PluginCall) {
        val modelId = call.getString("modelId")
        if (modelId == null) {
            call.reject("modelId is required")
            return
        }
        val info = LocalLlmModels.find(modelId)
        if (info == null) {
            call.reject("Unknown modelId: $modelId")
            return
        }

        launchCall(call, "Deleting the model") {
            // Stop the download first and wait for the worker to really finish, so it cannot recreate a
            // partial file behind the delete.
            WorkManager.getInstance(context).cancelUniqueWork(uniqueDownloadWorkName(modelId)).result.get()
            settleDownload(modelId)

            // The engine's own lock: a load in progress is waited for (a check of loadedModel() would see
            // nothing while it runs and delete the file under Engine.initialize()), a resident copy is
            // unloaded so getLoadedModel cannot report a model whose bundle is gone, and no load can start
            // until the files are gone.
            engine.withModelUnloaded(modelId) {
                modelFile(context, info).delete()
                tmpModelFile(context, info).delete()
            }
            call.resolve()
        }
    }

    @PluginMethod
    fun loadModel(call: PluginCall) {
        val modelId = call.getString("modelId")
        if (modelId == null) {
            call.reject("modelId is required")
            return
        }
        val info = LocalLlmModels.find(modelId)
        if (info == null) {
            call.reject("Unknown modelId: $modelId")
            return
        }
        val file = modelFile(context, info)
        if (!file.exists()) {
            call.reject("Model is not downloaded: $modelId")
            return
        }
        LocalLlmPolicy.ramShortfallMessage(info, deviceMemoryBytes())?.let {
            call.reject(it)
            return
        }

        val requestedWire = call.getString("accelerator")
        val requestedAccelerator = LocalLlmAccelerator.fromWire(requestedWire)
        if (requestedWire != null && requestedAccelerator == null) {
            call.reject("accelerator must be 'cpu' or 'gpu', not '$requestedWire'")
            return
        }

        // PluginCall's two-arg getInt/getDouble still return a nullable boxed type even
        // with a default supplied — fall back to the same default again to satisfy that.
        val maxTokens = call.getInt("maxTokens", info.defaultMaxTokens) ?: info.defaultMaxTokens
        val topK = call.getInt("topK", info.defaultTopK) ?: info.defaultTopK
        val topP = call.getDouble("topP", info.defaultTopP) ?: info.defaultTopP
        val temperature = call.getDouble("temperature", info.defaultTemperature) ?: info.defaultTemperature
        val enableSpeculativeDecoding = call.getBoolean("enableSpeculativeDecoding", false) ?: false

        val spec =
            LocalLlmEngine.LoadSpec(
                info = info,
                modelPath = file.absolutePath,
                maxTokens = maxTokens,
                topK = topK,
                topP = topP,
                temperature = temperature,
                accelerator = requestedAccelerator ?: info.defaultAccelerator,
                enableSpeculativeDecoding = enableSpeculativeDecoding,
                toolsGeneration = toolsGeneration.get(),
            )

        launchCall(call, "Loading the model") {
            try {
                // Already resident with exactly these options: nothing to rebuild, and no reason to
                // hit the appliance for its intent catalog again.
                val outcome =
                    engine.reusableOutcome(spec) ?: run {
                        // Fetched here, not lazily: LiteRT-LM fixes the tool set when the conversation is
                        // created, so tools must exist before load(). No-ops (and logs) when the appliance
                        // is unreachable or intent tools were never configured, leaving a toolless — but
                        // working — local model. A model whose chat template has no tool slot (no `tools`
                        // capability) gets none, and no system instruction either.
                        //
                        // A tool's answer goes back into the window the engine is sized with, so each tool's
                        // budget is derived from `spec.maxTokens` — the effective value, not the model's default
                        // (see `providersForLoad`). `maxTokens` is part of the reuse key (`LoadSpec`), so a load
                        // with another window gets tools with its own budget rather than being short-circuited above.
                        engine.load(spec, IntentToolProvider.providersForLoad(spec, intentClient))
                    }

                val result = JSObject()
                result.put("toolCount", outcome.toolCount)
                result.put("accelerator", outcome.accelerator.wire)
                result.put("fellBackToCpu", outcome.fellBackToCpu)
                result.put("speculativeDecoding", outcome.speculativeDecoding)
                call.resolve(result)
            } catch (e: Exception) {
                call.reject("Failed to load model: ${e.message}", e)
            } catch (e: LinkageError) {
                // A native library that will not link is a load failure, not a reason to take the app down.
                call.reject("Failed to load model: ${e.message}")
            }
        }
    }

    /**
     * Points the on-device model's tool calling at a CI-Server, or turns it off.
     *
     * Credentials are passed in from the web layer (which already holds the configured origin and
     * the minted API key) rather than read natively, so this plugin stays self-contained — no
     * dependency on the sibling Local Hub plugin's keystore, and no second place that has to know
     * how the app stores its credentials.
     *
     * Takes effect on the next `loadModel()`, since the tool set is bound when the conversation is
     * created; call this before loading, or reload afterwards.
     */
    @PluginMethod
    fun configureIntentTools(call: PluginCall) {
        val enabled = call.getBoolean("enabled", true) ?: true

        if (!enabled) {
            if (intentConfig != null) toolsGeneration.incrementAndGet()
            intentClient = null
            intentConfig = null
            call.resolve()

            return
        }

        val baseUrl = call.getString("baseUrl")
        val apiKey = call.getString("apiKey")

        if (baseUrl.isNullOrBlank() || apiKey.isNullOrBlank()) {
            call.reject("baseUrl and apiKey are required to enable intent tools")

            return
        }

        // Only a *change* invalidates the resident model's tool set: the web layer re-sends the same
        // configuration before every load, and counting that as a change would defeat the reuse.
        val config = baseUrl to apiKey
        if (config != intentConfig) {
            toolsGeneration.incrementAndGet()
            intentClient = CompanionIntentClient(baseUrl, apiKey)
            intentConfig = config
        }
        call.resolve()
    }

    @PluginMethod
    fun getLoadedModel(call: PluginCall) {
        val loaded = engine.loadedModel()
        val ret = JSObject()
        ret.put("loaded", loaded != null)
        if (loaded != null) {
            ret.put("modelId", loaded.info.modelId)
            ret.put("accelerator", loaded.accelerator.wire)
        }
        call.resolve(ret)
    }

    /**
     * Starts a fresh conversation on the resident engine — the "New chat" button. Cancels a generation
     * still in flight and waits for it to stop first; rejects if nothing is loaded.
     */
    @PluginMethod
    fun resetConversation(call: PluginCall) {
        if (!engine.isLoaded()) {
            call.reject("No model is loaded. Call loadModel() first.")
            return
        }

        launchCall(call, "Resetting the conversation") {
            try {
                engine.resetConversation()
                call.resolve()
            } catch (e: IllegalStateException) {
                call.reject(e.message ?: "Could not reset the conversation")
            } catch (e: Exception) {
                call.reject("Could not reset the conversation: ${e.message}", e)
            }
        }
    }

    @PluginMethod
    fun unloadModel(call: PluginCall) {
        launchCall(call, "Unloading the model") {
            engine.unload()
            call.resolve()
        }
    }

    @PluginMethod
    fun generate(call: PluginCall) {
        val parsed = parseGenerateOptions(call) ?: return

        launchCall(call, "Generation") {
            val request = prepareRequest(call, parsed) ?: return@launchCall

            // Inside the try's reach and never throwing: a refused foreground service is not a failed
            // generation, and the release below runs exactly once on every path.
            val lease = foregroundService.acquire()
            try {
                val completion = engine.generate(request)
                val ret = JSObject()
                ret.put("text", completion.text)
                if (completion.thought.isNotEmpty()) {
                    ret.put("thought", completion.thought)
                }
                completion.stats?.let { ret.put("stats", statsToJs(it)) }
                call.resolve(ret)
            } catch (e: CancellationException) {
                call.reject("Generation was cancelled")
            } catch (e: LocalLlmEngine.ThermallyThrottledException) {
                call.reject(e.message)
            } catch (e: IllegalArgumentException) {
                call.reject(e.message)
            } catch (e: IllegalStateException) {
                call.reject(e.message)
            } catch (e: Exception) {
                call.reject("Generation failed: ${e.message}", e)
            } finally {
                lease.release()
            }
        }
    }

    @PluginMethod
    fun generateStream(call: PluginCall) {
        val parsed = parseGenerateOptions(call) ?: return

        launchCall(call, "Generation") {
            val request = prepareRequest(call, parsed) ?: return@launchCall

            val lease = foregroundService.acquire()
            try {
                engine.generateStreaming(request) { streamEvent ->
                    val event = JSObject()
                    event.put("partial", streamEvent.partial)
                    streamEvent.thought?.let { event.put("thought", it) }
                    event.put("done", streamEvent.done)
                    streamEvent.stats?.let { event.put("stats", statsToJs(it)) }
                    notifyListeners(EVENT_TOKEN, event)
                }
                call.resolve()
            } catch (e: CancellationException) {
                val event = JSObject()
                event.put("partial", "")
                event.put("done", true)
                notifyListeners(EVENT_TOKEN, event)
                call.resolve()
            } catch (e: LocalLlmEngine.ThermallyThrottledException) {
                call.reject(e.message)
            } catch (e: IllegalArgumentException) {
                call.reject(e.message)
            } catch (e: IllegalStateException) {
                call.reject(e.message)
            } catch (e: Exception) {
                call.reject("Generation failed: ${e.message}", e)
            } finally {
                lease.release()
            }
        }
    }

    @PluginMethod
    fun cancel(call: PluginCall) {
        engine.cancel()
        call.resolve()
    }

    /** The parts of a `generate`/`generateStream` call that can be checked without decoding anything. */
    private class ParsedGenerate(val prompt: String, val enableThinking: Boolean, val rawImages: List<String>)

    /**
     * Validates a generate call synchronously and rejects it (returning null) on the first problem,
     * so the cheap failures — no prompt, no model, too many images, a model with no vision — never
     * cost an image decode or a foreground service.
     */
    private fun parseGenerateOptions(call: PluginCall): ParsedGenerate? {
        val prompt = call.getString("prompt")
        if (prompt == null) {
            call.reject("prompt is required")
            return null
        }
        val loaded = engine.loadedModel()
        if (loaded == null) {
            call.reject("No model is loaded. Call loadModel() first.")
            return null
        }

        val enableThinking = call.getBoolean("enableThinking", false) ?: false

        val images = ArrayList<String>()
        val rawImages = call.data.optJSONArray("images")
        if (rawImages != null) {
            for (i in 0 until rawImages.length()) {
                val image =
                    try {
                        rawImages.get(i) as? String
                    } catch (e: JSONException) {
                        null
                    }
                if (image == null) {
                    call.reject("images must be an array of base64 strings; item ${i + 1} is not a string.")
                    return null
                }
                images.add(image)
            }
        }
        if (images.size > ImageSizing.MAX_IMAGES) {
            call.reject("At most ${ImageSizing.MAX_IMAGES} images can be sent in one request; got ${images.size}.")
            return null
        }
        if (images.isNotEmpty() && !loaded.info.supportsVision) {
            call.reject("${loaded.info.modelId} cannot read images; load a model with the vision capability.")
            return null
        }
        if (prompt.isBlank() && images.isEmpty()) {
            call.reject("prompt is required")
            return null
        }

        return ParsedGenerate(prompt, enableThinking, images)
    }

    /**
     * Decodes and downsizes the call's images (off the caller's thread) into a [LocalLlmEngine.GenerateRequest].
     * An image that cannot be read rejects the whole call and returns null: it is never dropped from
     * the prompt, since the model would then answer a question about a picture it was never shown.
     */
    private suspend fun prepareRequest(call: PluginCall, parsed: ParsedGenerate): LocalLlmEngine.GenerateRequest? {
        val images =
            try {
                parsed.rawImages.mapIndexed { index, base64 -> ImagePreparer.toPng(index + 1, base64) }
            } catch (e: IllegalArgumentException) {
                call.reject(e.message)
                return null
            } catch (e: OutOfMemoryError) {
                call.reject("The image is too large to process on this device.")
                return null
            }
        return LocalLlmEngine.GenerateRequest(parsed.prompt, parsed.enableThinking, images)
    }

    private fun statsToJs(stats: GenerationStats): JSObject {
        val js = JSObject()
        js.put("timeToFirstTokenMs", stats.timeToFirstTokenMs)
        js.put("totalMs", stats.totalMs)
        js.put("outputTokens", stats.outputTokens)
        js.put("decodeTokensPerSecond", stats.decodeTokensPerSecond)
        js.put("tokensEstimated", stats.tokensEstimated)
        return js
    }

    /**
     * Advertised device RAM — the figure `minDeviceMemoryBytes` is written against. See
     * [LocalLlmPolicy.advertisedMemoryBytes] for why the raw `totalMem` is not compared directly.
     */
    private fun deviceMemoryBytes(): Long {
        val activityManager = context.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager ?: return 0L
        val memInfo = ActivityManager.MemoryInfo()
        activityManager.getMemoryInfo(memInfo)
        val advertised = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) memInfo.advertisedMem else null
        return LocalLlmPolicy.advertisedMemoryBytes(memInfo.totalMem, advertised)
    }

    /** Current on-disk / in-flight status for [modelId], as a ready-to-resolve JSObject. */
    private suspend fun currentStatus(modelId: String, info: LocalLlmModelInfo): JSObject {
        val ret = JSObject()
        val file = modelFile(context, info)

        if (file.exists()) {
            ret.put("status", "ready")
            ret.put("bytesDownloaded", info.sizeBytes)
            ret.put("totalBytes", info.sizeBytes)
            return ret
        }

        val partialBytes = tmpModelFile(context, info).length()
        val latest = latestWorkInfo(modelId)

        when (latest?.state) {
            WorkInfo.State.ENQUEUED, WorkInfo.State.RUNNING, WorkInfo.State.BLOCKED -> {
                ret.put("status", "downloading")
                ret.put("bytesDownloaded", latest.progress.getLong(ModelDownloadWorker.KEY_BYTES_DOWNLOADED, partialBytes))
                ret.put("totalBytes", info.sizeBytes)
                // A download WorkManager kept running across an app restart or an activity recreate has no
                // poller in this process — downloadModel() is the only other place one starts — so without
                // this the UI that asked for the status would never hear progress, ready or error. Already
                // observed models are de-duplicated by observedDownloads.
                observeDownload(modelId, info)
            }
            WorkInfo.State.FAILED -> {
                ret.put("status", "error")
                ret.put("error", latest.outputData.getString(ModelDownloadWorker.KEY_ERROR) ?: "Download failed")
                ret.put("bytesDownloaded", partialBytes)
                ret.put("totalBytes", info.sizeBytes)
            }
            else -> {
                ret.put("status", "not_downloaded")
            }
        }
        return ret
    }

    private suspend fun latestWorkInfo(modelId: String): WorkInfo? =
        withContext(Dispatchers.IO) {
            WorkManager.getInstance(context).getWorkInfosForUniqueWork(uniqueDownloadWorkName(modelId)).get().firstOrNull()
        }

    /** True while a download for [modelId] is queued, blocked or running. */
    private suspend fun isDownloadActive(modelId: String): Boolean =
        when (latestWorkInfo(modelId)?.state) {
            WorkInfo.State.ENQUEUED, WorkInfo.State.RUNNING, WorkInfo.State.BLOCKED -> true
            else -> false
        }

    /**
     * Polls the download's WorkInfo until it reaches a terminal state, forwarding each
     * change as a `modelDownloadProgress` event. Only one poller runs per modelId at a
     * time (subsequent `downloadModel` calls for an already-observed model are no-ops
     * here — the `ExistingWorkPolicy.KEEP` enqueue above already covers attaching to the
     * existing transfer).
     */
    private fun observeDownload(modelId: String, info: LocalLlmModelInfo) {
        if (!observedDownloads.add(modelId)) {
            return
        }

        pluginScope.launch {
            try {
                while (isActive) {
                    val latest = latestWorkInfo(modelId) ?: break
                    val bytesDownloaded = latest.progress.getLong(ModelDownloadWorker.KEY_BYTES_DOWNLOADED, 0L)

                    when (latest.state) {
                        WorkInfo.State.RUNNING, WorkInfo.State.ENQUEUED, WorkInfo.State.BLOCKED -> {
                            emitDownloadProgress(modelId, "downloading", bytesDownloaded, info.sizeBytes)
                        }
                        WorkInfo.State.SUCCEEDED -> {
                            emitDownloadProgress(modelId, "ready", info.sizeBytes, info.sizeBytes)
                            break
                        }
                        WorkInfo.State.FAILED -> {
                            val error = latest.outputData.getString(ModelDownloadWorker.KEY_ERROR) ?: "Download failed"
                            emitDownloadProgress(modelId, "error", bytesDownloaded, info.sizeBytes, error)
                            break
                        }
                        WorkInfo.State.CANCELLED -> {
                            emitDownloadProgress(modelId, "not_downloaded", 0L, info.sizeBytes)
                            break
                        }
                    }

                    delay(DOWNLOAD_POLL_INTERVAL_MS)
                }
            } finally {
                observedDownloads.remove(modelId)
            }
        }
    }

    private fun emitDownloadProgress(
        modelId: String,
        status: String,
        bytesDownloaded: Long,
        totalBytes: Long,
        error: String? = null,
    ) {
        val event = JSObject()
        event.put("modelId", modelId)
        event.put("status", status)
        event.put("bytesDownloaded", bytesDownloaded)
        event.put("totalBytes", totalBytes)
        if (error != null) {
            event.put("error", error)
        }
        notifyListeners(EVENT_DOWNLOAD_PROGRESS, event)
    }
}
