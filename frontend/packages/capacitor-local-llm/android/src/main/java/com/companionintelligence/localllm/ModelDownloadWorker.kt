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
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

private const val NOTIFICATION_CHANNEL_ID = "local_llm_model_download"
private const val NOTIFICATION_ID = 91_001
private const val PROGRESS_REPORT_INTERVAL_MS = 250L
private const val CONNECT_TIMEOUT_MS = 30_000
private const val READ_TIMEOUT_MS = 30_000

/**
 * Resumable, foreground download of a model's `.task` file. A plain single `fetch`/OkHttp
 * call would die on backgrounding or a network change for a file this size (~530 MiB) —
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

    override suspend fun doWork(): Result =
        withContext(Dispatchers.IO) {
            val modelId = inputData.getString(KEY_MODEL_ID)
            val urlString = inputData.getString(KEY_URL)
            val fileName = inputData.getString(KEY_FILE_NAME)
            val totalBytesHint = inputData.getLong(KEY_TOTAL_BYTES, 0L)

            if (modelId == null || urlString == null || fileName == null) {
                return@withContext Result.failure(errorData("Missing modelId/url/fileName"))
            }

            try {
                setForeground(foregroundInfo(0))

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
            } catch (e: IOException) {
                Result.failure(errorData(e.message ?: "Download failed"))
            } catch (e: SecurityException) {
                Result.failure(errorData(e.message ?: "Download failed"))
            }
        }

    /** Streams [urlString] into [tmpFile], resuming from its current length via `Range`. */
    private suspend fun downloadWithResume(urlString: String, tmpFile: File, totalBytesHint: Long) {
        var downloadedBytes = tmpFile.length()

        val connection = URL(urlString).openConnection() as HttpURLConnection
        connection.connectTimeout = CONNECT_TIMEOUT_MS
        connection.readTimeout = READ_TIMEOUT_MS
        connection.instanceFollowRedirects = true
        if (downloadedBytes > 0) {
            connection.setRequestProperty("Range", "bytes=$downloadedBytes-")
            // Force an uncompressed response so the byte offset above stays meaningful.
            connection.setRequestProperty("Accept-Encoding", "identity")
        }

        connection.connect()

        try {
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

            connection.inputStream.use { input ->
                FileOutputStream(tmpFile, /* append = */ downloadedBytes > 0).use { output ->
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
                throw IOException("Downloaded size (${tmpFile.length()}) did not match expected size ($totalBytes)")
            }
        } finally {
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
        setForeground(foregroundInfo(percent))
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
    }
}
