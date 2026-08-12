package com.companionintelligence.localllm

import android.app.ActivityManager
import android.content.Context
import android.os.Build
import androidx.work.Constraints
import androidx.work.Data
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkInfo
import androidx.work.WorkManager
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.util.concurrent.CancellationException
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

private const val DOWNLOAD_POLL_INTERVAL_MS = 500L

/**
 * Android-only on-device LLM plugin (Google LiteRT-LM). See `src/definitions.ts` for the
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
    private val pluginScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val observedDownloads = ConcurrentHashMap.newKeySet<String>()
    private lateinit var engine: LocalLlmEngine

    override fun load() {
        super.load()
        engine = LocalLlmEngine(context.applicationContext)
    }

    override fun handleOnDestroy() {
        engine.unload()
        pluginScope.cancel()
        super.handleOnDestroy()
    }

    /**
     * Pure capability probe: Android API level, total device RAM, and free disk space.
     * No downloads, no side effects — safe to call speculatively (e.g. to decide whether
     * to even show an "on-device model" option in settings).
     */
    @PluginMethod
    fun isAvailable(call: PluginCall) {
        val ret = JSObject()

        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            ret.put("available", false)
            ret.put("reason", "Requires Android 8.0 (API 26) or newer.")
            call.resolve(ret)
            return
        }

        val activityManager = context.getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager
        val memInfo = ActivityManager.MemoryInfo()
        activityManager?.getMemoryInfo(memInfo)

        // Total device RAM, not momentary free RAM: a stable "can this device ever run
        // it" check, matching how the model is sized (LocalLlmModels' estimatedPeakMemoryBytes).
        if (memInfo.totalMem < MIN_TOTAL_MEMORY_BYTES) {
            ret.put("available", false)
            ret.put("reason", "This device has less than ${MIN_TOTAL_MEMORY_BYTES / (1024 * 1024)}MB of RAM.")
            call.resolve(ret)
            return
        }

        val dir = modelsDir(context)
        dir.mkdirs()
        if (dir.freeSpace < MIN_FREE_DISK_BYTES) {
            ret.put("available", false)
            ret.put("reason", "Not enough free storage to download the on-device model.")
            call.resolve(ret)
            return
        }

        ret.put("available", true)
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

        pluginScope.launch {
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

        val inputData =
            Data.Builder()
                .putString(ModelDownloadWorker.KEY_MODEL_ID, modelId)
                .putString(ModelDownloadWorker.KEY_URL, url)
                .putString(ModelDownloadWorker.KEY_FILE_NAME, info.fileName)
                .putLong(ModelDownloadWorker.KEY_TOTAL_BYTES, info.sizeBytes)
                .build()

        val request =
            OneTimeWorkRequestBuilder<ModelDownloadWorker>()
                .setInputData(inputData)
                .setConstraints(Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build())
                .build()

        // KEEP: a second downloadModel() call for the same model (e.g. after the app was
        // killed and relaunched mid-download) attaches to the still-running/queued work
        // instead of starting a duplicate transfer.
        WorkManager.getInstance(context).enqueueUniqueWork(uniqueDownloadWorkName(modelId), ExistingWorkPolicy.KEEP, request)
        observeDownload(modelId, info)

        call.resolve()
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

        pluginScope.launch {
            WorkManager.getInstance(context).cancelUniqueWork(uniqueDownloadWorkName(modelId))
            modelFile(context, info).delete()
            tmpModelFile(context, info).delete()
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

        // PluginCall's two-arg getInt/getDouble still return a nullable boxed type even
        // with a default supplied — fall back to the same default again to satisfy that.
        val maxTokens = call.getInt("maxTokens", info.defaultMaxTokens) ?: info.defaultMaxTokens
        val topK = call.getInt("topK", info.defaultTopK) ?: info.defaultTopK
        val topP = call.getDouble("topP", info.defaultTopP) ?: info.defaultTopP
        val temperature = call.getDouble("temperature", info.defaultTemperature) ?: info.defaultTemperature

        pluginScope.launch {
            try {
                engine.load(file.absolutePath, maxTokens, topK, topP, temperature)
                call.resolve()
            } catch (e: Exception) {
                call.reject("Failed to load model: ${e.message}", e)
            }
        }
    }

    @PluginMethod
    fun unloadModel(call: PluginCall) {
        pluginScope.launch {
            engine.unload()
            call.resolve()
        }
    }

    @PluginMethod
    fun generate(call: PluginCall) {
        val prompt = call.getString("prompt")
        if (prompt == null) {
            call.reject("prompt is required")
            return
        }
        if (!engine.isLoaded()) {
            call.reject("No model is loaded. Call loadModel() first.")
            return
        }

        pluginScope.launch {
            try {
                val text = engine.generate(prompt)
                val ret = JSObject()
                ret.put("text", text)
                call.resolve(ret)
            } catch (e: CancellationException) {
                call.reject("Generation was cancelled")
            } catch (e: Exception) {
                call.reject("Generation failed: ${e.message}", e)
            }
        }
    }

    @PluginMethod
    fun generateStream(call: PluginCall) {
        val prompt = call.getString("prompt")
        if (prompt == null) {
            call.reject("prompt is required")
            return
        }
        if (!engine.isLoaded()) {
            call.reject("No model is loaded. Call loadModel() first.")
            return
        }

        pluginScope.launch {
            try {
                engine.generateStreaming(prompt) { partial, done ->
                    val event = JSObject()
                    event.put("partial", partial)
                    event.put("done", done)
                    notifyListeners(EVENT_TOKEN, event)
                }
                call.resolve()
            } catch (e: CancellationException) {
                val event = JSObject()
                event.put("partial", "")
                event.put("done", true)
                notifyListeners(EVENT_TOKEN, event)
                call.resolve()
            } catch (e: Exception) {
                call.reject("Generation failed: ${e.message}", e)
            }
        }
    }

    @PluginMethod
    fun cancel(call: PluginCall) {
        engine.cancel()
        call.resolve()
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
