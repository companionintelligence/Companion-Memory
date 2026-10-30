package com.companionintelligence.localhub.upload

import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

/**
 * [UploadTransport] over `HttpURLConnection`: the stack CapacitorHttp uses for the app's own
 * requests, so the same trust store and the app's cleartext policy apply to both.
 */
class HttpUploadTransport : UploadTransport {
    override fun postJson(url: String, apiKey: String, body: String): UploadResponse {
        val connection = try {
            URL(url).openConnection() as HttpURLConnection
        } catch (e: Exception) {
            return UploadResponse(null, e.message ?: e.javaClass.simpleName)
        }
        return try {
            connection.requestMethod = "POST"
            connection.connectTimeout = TIMEOUT_MS
            connection.readTimeout = TIMEOUT_MS
            connection.doOutput = true
            connection.setRequestProperty("Content-Type", "application/json")
            connection.setRequestProperty(API_KEY_HEADER, apiKey)
            connection.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
            val status = connection.responseCode
            // Drained so the connection can be reused; the body itself is not needed.
            val stream = if (status >= 400) connection.errorStream else connection.inputStream
            stream?.use { it.readBytes() }
            UploadResponse(status)
        } catch (e: IOException) {
            UploadResponse(null, e.message ?: e.javaClass.simpleName)
        } finally {
            connection.disconnect()
        }
    }

    private companion object {
        /** `FLUSH_TIMEOUT_MS` in `outboxFlush.ts`. */
        const val TIMEOUT_MS = 30_000
        /** `apiAuth.ts`; the native shell authenticates with the long-lived key. */
        const val API_KEY_HEADER = "x-api-key"
    }
}
