package com.companionintelligence.localhub.replica

import java.io.BufferedReader
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import org.json.JSONObject

/**
 * The two requests the JS connector and sync client make, over `HttpURLConnection` (the stack
 * CapacitorHttp uses, so the app's trust store and cleartext policy apply):
 *
 * - `GET <origin>/api/powersync/token?cutoff=` with the API key, as `connector.ts` asks;
 * - `POST <endpoint>/sync/stream` with `Authorization: Token`, NDJSON back, as
 *   `AbstractRemote.fetchStream` sends it.
 */
class HttpReplicaTransport(
    private val origin: String,
    private val apiKey: String,
    private val cutoffIso: String,
) : ReplicaTransport {
    override fun fetchCredentials(): ReplicaCredentials {
        val url = "$origin/api/powersync/token?cutoff=${URLEncoder.encode(cutoffIso, "UTF-8")}"
        val connection = (URL(url).openConnection() as HttpURLConnection).apply {
            connectTimeout = TIMEOUT_MS
            readTimeout = TIMEOUT_MS
            setRequestProperty(API_KEY_HEADER, apiKey)
        }
        try {
            val status = connection.responseCode
            val body = (if (status >= 400) connection.errorStream else connection.inputStream)
                ?.bufferedReader()?.use(BufferedReader::readText).orEmpty()
            if (status !in 200..299) throw IOException("token request answered $status")
            val json = JSONObject(body)
            return ReplicaCredentials(json.getString("powersync_url").trimEnd('/'), json.getString("token"))
        } finally {
            connection.disconnect()
        }
    }

    override fun openStream(credentials: ReplicaCredentials, requestBody: String): SyncLineSource {
        val connection = (URL("${credentials.endpoint}/sync/stream").openConnection() as HttpURLConnection).apply {
            requestMethod = "POST"
            connectTimeout = TIMEOUT_MS
            // The service sends a keepalive line well inside this while the stream is idle.
            readTimeout = STREAM_READ_TIMEOUT_MS
            doOutput = true
            setRequestProperty("Content-Type", "application/json")
            setRequestProperty("Accept", "application/x-ndjson")
            setRequestProperty("Authorization", "Token ${credentials.token}")
            setRequestProperty("x-user-agent", USER_AGENT)
        }
        try {
            connection.outputStream.use { it.write(requestBody.toByteArray(Charsets.UTF_8)) }
            val status = connection.responseCode
            if (status != 200) throw IOException("sync stream answered $status")
        } catch (e: Exception) {
            connection.disconnect()
            throw e
        }
        val reader = connection.inputStream.bufferedReader(Charsets.UTF_8)
        return object : SyncLineSource {
            override fun readLine(): String? = reader.readLine()

            override fun close() {
                // disconnect() first: it unblocks a readLine() waiting on the socket.
                connection.disconnect()
                runCatching { reader.close() }
            }
        }
    }

    private companion object {
        const val TIMEOUT_MS = 30_000
        const val STREAM_READ_TIMEOUT_MS = 60_000
        const val API_KEY_HEADER = "x-api-key"
        const val USER_AGENT = "ci-replica-background-sync"
    }
}
