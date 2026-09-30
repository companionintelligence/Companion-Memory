package com.companionintelligence.localllm

import android.app.NotificationChannel
import android.app.NotificationManager
import android.content.Context
import android.content.pm.ServiceInfo
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.work.CoroutineWorker
import androidx.work.Data
import androidx.work.ForegroundInfo
import androidx.work.WorkerParameters
import android.util.Log
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.ensureActive
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

private const val NOTIFICATION_CHANNEL_ID = "local_llm_model_download"
private const val NOTIFICATION_ID = 91_001
private const val PROGRESS_REPORT_INTERVAL_MS = 250L
private const val CONNECT_TIMEOUT_MS = 30_000
private const val READ_TIMEOUT_MS = 30_000
private const val TAG = "ModelDownloadWorker"

/** How long to leave the foreground promotion alone after the OS refused it. */
private const val FOREGROUND_RETRY_INTERVAL_MS = 30_000L

/**
 * Resumable, foreground download of a model's file. A plain single `fetch`/OkHttp
 * call would die on backgrounding or a network change for a file this size (0.3-3.6 GB) —
 * this worker persists partial progress to a `.part` file and resumes via HTTP `Range` on
 * retry (WorkManager itself retries transient failures per its backoff policy, and a
 * fresh `downloadModel()` call after a process death re-enqueues into the same partial
 * file via `ExistingWorkPolicy.KEEP`).
 *
 * Progress is reported two ways: `setProgress` (polled by `LocalLlmPlugin` to forward the
 * `modelDownloadProgress` JS event) and a foreground notification (required to keep a
 * long transfer alive under Android's background execution limits).
 */
class ModelDownloadWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {

    /** Last time the OS refused to promote this worker to the foreground; 0 if it never has. */
    private var foregroundRefusedAt = 0L

    override suspend fun doWork(): Result =
        withContext(Dispatchers.IO) {
            val modelId = inputData.getString(KEY_MODEL_ID)
            val urlString = inputData.getString(KEY_URL)
            val fileName = inputData.getString(KEY_FILE_NAME)
            val totalBytesHint = inputData.getLong(KEY_TOTAL_BYTES, 0L)

            if (modelId == null || urlString == null || fileName == null) {
                return@withContext Result.failure(errorData("Missing modelId/url/fileName"))
            }

            // Registered for exactly as long as this coroutine can still touch the files, so
            // cancelDownload/deleteModel can wait for the *real* end of the transfer, not for WorkManager's
            // (immediate) CANCELLED state. See ActiveDownloads.
            activeDownloads.begin(modelId)
            try {
                tryForeground(0)

                val destDir = File(applicationContext.filesDir, "local-llm-models")
                if (!destDir.exists()) {
                    destDir.mkdirs()
                }

                val destFile = File(destDir, fileName)
                if (destFile.exists()) {
                    return@withContext Result.success()
                }

                val tmpFile = File(destDir, "$fileName.part")
                downloadWithResume(urlString, tmpFile, totalBytesHint)

                if (!tmpFile.renameTo(destFile)) {
                    throw IOException("Could not finalize downloaded file")
                }

                Result.success()
            } catch (e: CancellationException) {
                throw e
            } catch (e: IOException) {
                // A cancelled download tears its socket down to unblock the read; that surfaces here as an
                // IOException, and is not a failure the user should be told about.
                if (!isActive) throw CancellationException("Download cancelled")
                Result.failure(errorData(e.message ?: "Download failed"))
            } catch (e: SecurityException) {
                Result.failure(errorData(e.message ?: "Download failed"))
            } catch (e: Exception) {
                // Anything else (an IllegalStateException from a refused service, say) is still *this* download
                // failing — reported with its message, not left to WorkManager as a bare failure.
                Log.e(TAG, "Download failed unexpectedly", e)
                Result.failure(errorData(e.message ?: "Download failed"))
            } finally {
                activeDownloads.end(modelId)
            }
        }

    /**
     * Streams [urlString] into [tmpFile], resuming from its current length via `Range`. If the partial turns
     * out to have changed underneath the resume (something deleted or replaced it while the request was in
     * flight), the response — which starts at the *old* offset — is unusable, so it starts over once from zero.
     */
    private suspend fun downloadWithResume(urlString: String, tmpFile: File, totalBytesHint: Long) {
        if (transfer(urlString, tmpFile, totalBytesHint, resume = true)) return

        tmpFile.delete()
        check(transfer(urlString, tmpFile, totalBytesHint, resume = false)) { "A fresh download reported a stale partial" }
    }

    /**
     * One request. Returns false — having written nothing — only when [resume] was asked for and the partial
     * file no longer holds exactly the bytes the `Range` header was computed from.
     */
    private suspend fun transfer(urlString: String, tmpFile: File, totalBytesHint: Long, resume: Boolean): Boolean =
        coroutineScope {
            var downloadedBytes = if (resume) tmpFile.length() else 0L

            // A partial that is already as long as the whole file (or longer) is not a resume point.
            // It is what an earlier attempt leaves behind when its final size check failed — every
            // Qwen3 download did, while the catalog's size was stale — and asking for
            // `Range: bytes=<size>-` then answers 416 forever. Start over instead of retrying it.
            if (resume && totalBytesHint > 0) {
                val resumable = LocalLlmPolicy.resumableBytes(downloadedBytes, totalBytesHint)
                if (resumable != downloadedBytes) {
                    tmpFile.delete()
                    downloadedBytes = resumable
                }
            }

            val connection = URL(urlString).openConnection() as HttpURLConnection
            connection.connectTimeout = CONNECT_TIMEOUT_MS
            connection.readTimeout = READ_TIMEOUT_MS
            connection.instanceFollowRedirects = true
            if (downloadedBytes > 0) {
                connection.setRequestProperty("Range", "bytes=$downloadedBytes-")
                // Force an uncompressed response so the byte offset above stays meaningful.
                connection.setRequestProperty("Accept-Encoding", "identity")
            }

            // connect(), getResponseCode() and read() block and do not react to coroutine cancellation.
            // This child is cancelled with the worker and tears the socket down, which is what makes them
            // throw — so a cancelled download stops in milliseconds, not at the next 30 s read timeout.
            val guard =
                launch {
                    try {
                        awaitCancellation()
                    } finally {
                        connection.disconnect()
                    }
                }

            try {
                connection.connect()

                val responseCode = connection.responseCode
                if (responseCode != HttpURLConnection.HTTP_OK && responseCode != HttpURLConnection.HTTP_PARTIAL) {
                    throw IOException("HTTP $responseCode")
                }

                // The server ignored our Range request (some don't support it) — restart clean
                // rather than silently corrupting the file by appending from the wrong offset.
                if (downloadedBytes > 0 && responseCode == HttpURLConnection.HTTP_OK) {
                    downloadedBytes = 0L
                    tmpFile.delete()
                }

                val totalBytes =
                    when {
                        totalBytesHint > 0 -> totalBytesHint
                        connection.contentLengthLong >= 0 -> connection.contentLengthLong + downloadedBytes
                        else -> 0L
                    }

                // Everything above blocked on the network for as long as it liked; if the download was
                // cancelled meanwhile (and its partial possibly deleted), stop here rather than open the file.
                ensureActive()

                val append = downloadedBytes > 0
                FileOutputStream(tmpFile, append).use { output ->
                    // Opening in append mode *creates* a missing file. If the partial vanished (a cancel or
                    // a delete raced this resume), the response body starts at offset `downloadedBytes` and
                    // would become a tiny file whose contents belong at that offset — which a later resume
                    // would extend into a full-length file that passes the size check and is corrupt.
                    if (append && output.channel.size() != downloadedBytes) {
                        return@coroutineScope false
                    }

                    connection.inputStream.use { input ->
                        val buffer = ByteArray(DEFAULT_BUFFER_SIZE)
                        var lastReportedAt = 0L

                        while (true) {
                            val read = input.read(buffer)
                            if (read == -1) break

                            output.write(buffer, 0, read)
                            downloadedBytes += read

                            val now = System.currentTimeMillis()
                            if (now - lastReportedAt >= PROGRESS_REPORT_INTERVAL_MS) {
                                lastReportedAt = now
                                reportProgress(downloadedBytes, totalBytes)
                            }
                        }
                    }
                }

                reportProgress(downloadedBytes, totalBytes)

                if (totalBytes > 0 && tmpFile.length() != totalBytes) {
                    val actual = tmpFile.length()
                    // Too long can never be resumed into the right file (a resume would ask for bytes past
                    // the end), so drop it. Too short is a resumable partial — keep it for the next attempt.
                    if (actual > totalBytes) {
                        tmpFile.delete()
                    }
                    throw IOException("Downloaded size ($actual) did not match expected size ($totalBytes)")
                }
                true
            } finally {
                guard.cancel()
                connection.disconnect()
            }
        }

    private suspend fun reportProgress(downloaded: Long, total: Long) {
        setProgress(
            Data.Builder()
                .putLong(KEY_BYTES_DOWNLOADED, downloaded)
                .putLong(KEY_TOTAL_BYTES, total)
                .build(),
        )

        val percent = if (total > 0) ((downloaded * 100) / total).toInt() else 0
        tryForeground(percent)
    }

    /**
     * Promotes this worker to a foreground service so a long transfer survives backgrounding — as a best
     * effort. Android refuses when the app is in the background and not allowed to start one
     * (`ForegroundServiceStartNotAllowedException` on API 31+, an `IllegalStateException` for `setForeground`;
     * a `SecurityException` when the permission or service type is missing). The download itself does not
     * need it: it runs as ordinary background work, resumes via `Range` if the system stops it, and asks
     * again after [FOREGROUND_RETRY_INTERVAL_MS]. Failing the whole download over a notification would be the
     * wrong trade.
     */
    private suspend fun tryForeground(percent: Int) {
        val now = System.currentTimeMillis()
        if (foregroundRefusedAt != 0L && now - foregroundRefusedAt < FOREGROUND_RETRY_INTERVAL_MS) return
        try {
            setForeground(foregroundInfo(percent))
            foregroundRefusedAt = 0L
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            foregroundRefusedAt = now
            Log.w(TAG, "Not promoted to a foreground service; continuing as background work", e)
        }
    }

    private fun errorData(message: String): Data = Data.Builder().putString(KEY_ERROR, message).build()

    private fun foregroundInfo(progress: Int): ForegroundInfo {
        ensureNotificationChannel()

        val notification =
            NotificationCompat.Builder(applicationContext, NOTIFICATION_CHANNEL_ID)
                .setContentTitle("Downloading on-device model")
                .setContentText("$progress%")
                .setSmallIcon(android.R.drawable.stat_sys_download)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .setProgress(100, progress, false)
                .build()

        // The 3-arg constructor (with an explicit foreground service type) exists across
        // all supported API levels in androidx.work; the OS only starts enforcing the
        // declared type at API 29+/34+, so it is safe to call unconditionally.
        return ForegroundInfo(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC)
    }

    // NotificationChannel is an API 26+ class; this module's minSdk matches the app's
    // (23), so it must not be constructed on older devices. Channels are meaningless
    // below 26 anyway — NotificationCompat.Builder ignores the channel id there.
    private fun ensureNotificationChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return
        }

        val manager = applicationContext.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (manager.getNotificationChannel(NOTIFICATION_CHANNEL_ID) == null) {
            manager.createNotificationChannel(
                NotificationChannel(NOTIFICATION_CHANNEL_ID, "On-device model downloads", NotificationManager.IMPORTANCE_LOW),
            )
        }
    }

    companion object {
        const val KEY_MODEL_ID = "modelId"
        const val KEY_URL = "url"
        const val KEY_FILE_NAME = "fileName"
        const val KEY_TOTAL_BYTES = "totalBytes"
        const val KEY_BYTES_DOWNLOADED = "bytesDownloaded"
        const val KEY_ERROR = "error"

        /** Downloads with a worker running in this process right now — see [ActiveDownloads]. */
        val activeDownloads = ActiveDownloads()

        /**
         * The work request input for downloading [info]. The one place the size the worker verifies
         * (`KEY_TOTAL_BYTES`) *and the url it fetches* are chosen — both from the catalog, so a test can pin
         * them and the plugin must not build this by hand. The url the JS layer passed to `downloadModel`
         * is validated against the catalog but never reaches the worker.
         */
        fun inputDataFor(info: LocalLlmModelInfo): Data =
            Data.Builder()
                .putString(KEY_MODEL_ID, info.modelId)
                .putString(KEY_URL, LocalLlmPolicy.downloadUrlFor(info))
                .putString(KEY_FILE_NAME, info.fileName)
                .putLong(KEY_TOTAL_BYTES, info.sizeBytes)
                .build()
    }
}
