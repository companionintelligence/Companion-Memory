package com.companionintelligence.localhub.replica

import org.json.JSONArray
import org.json.JSONObject

/**
 * The phone's PowerSync replica as the background sync sees it: PowerSync's Rust core, reached
 * through `powersync_control`, inside the encrypted database the app's own sync client uses.
 */
interface ReplicaCore : AutoCloseable {
    /** One `powersync_control(op, payload)` call in its own write transaction; the core's JSON reply. */
    fun control(op: String, payload: String?): String

    /** Local writes the app has not uploaded yet (`ps_crud`). */
    fun pendingUploads(): Int
}

/** Where to sync from, as `GET /api/powersync/token` answers. */
data class ReplicaCredentials(val endpoint: String, val token: String)

/** The open `POST <endpoint>/sync/stream` response, one NDJSON line at a time. */
interface SyncLineSource : AutoCloseable {
    /** The next line, or null when the server ended the stream. Throws once [close]d. */
    fun readLine(): String?
}

interface ReplicaTransport {
    fun fetchCredentials(): ReplicaCredentials

    fun openStream(credentials: ReplicaCredentials, requestBody: String): SyncLineSource
}

/**
 * One background catch-up of the replica: what the JS client does while the app is open
 * (`AbstractStreamingSyncImplementation.rustSyncIteration` in `@powersync/common`), run until
 * the first complete checkpoint and then stopped.
 *
 * The core does all the bookkeeping -- buckets, checksums, applying rows; this only moves bytes
 * between it and the sync service:
 *
 * 1. `start` with the app's own start options (schema included), which answers with the
 *    request to open the stream with.
 * 2. `connection` / `established`, then every line as `line_text`.
 * 3. Done on `DidCompleteSync`. `CloseSyncStream` (the service ended this iteration) and
 *    `FetchCredentials` with `did_expire` (the token ran out) end the run early, to be tried
 *    again next time; so do cancellation, the deadline, and the stream ending.
 * 4. Always `stop`.
 *
 * Skipped outright when the app has local writes waiting to upload: uploading is the app's job
 * (through its GraphQL connector), and the core holds back checkpoints over unuploaded writes,
 * so the run would only download what it could not apply.
 */
class ReplicaSyncRunner(
    private val transport: ReplicaTransport,
    private val openCore: () -> ReplicaCore?,
    private val startOptions: String,
    private val nowMs: () -> Long = System::currentTimeMillis,
) {
    sealed class Outcome {
        data class Completed(val lines: Int) : Outcome()
        data class Skipped(val reason: String) : Outcome()
        data class Stopped(val reason: String, val lines: Int) : Outcome()
    }

    /**
     * @param isCancelled checked between lines; the caller also closes the stream from another
     *   thread (see [onStreamOpen]) so a run blocked waiting for the next line ends promptly.
     * @param onStreamOpen hands the caller the open stream, so cancelling can close it.
     */
    fun run(
        deadlineMs: Long,
        isCancelled: () -> Boolean = { false },
        onStreamOpen: (SyncLineSource) -> Unit = {},
    ): Outcome {
        val core = openCore() ?: return Outcome.Skipped("no replica on this phone yet")
        core.use {
            if (core.pendingUploads() > 0) {
                return Outcome.Skipped("local changes are waiting for the app to upload them")
            }
            val credentials = transport.fetchCredentials()

            var request: String? = null
            try {
                for (instruction in instructions(core.control("start", startOptions))) {
                    instruction.optJSONObject("EstablishSyncStream")?.let { request = it.get("request").toString() }
                }
                val body = request ?: return Outcome.Stopped("the core did not ask for a sync stream", 0)

                return transport.openStream(credentials, body).use { stream ->
                    onStreamOpen(stream)
                    core.control("connection", "established")
                    follow(core, stream, deadlineMs, isCancelled)
                }
            } finally {
                // Never leave the core mid-iteration in the file the app opens next.
                runCatching { core.control("stop", null) }
            }
        }
    }

    private fun follow(core: ReplicaCore, stream: SyncLineSource, deadlineMs: Long, isCancelled: () -> Boolean): Outcome {
        var lines = 0
        var outcome: Outcome? = null
        while (outcome == null) {
            outcome = when {
                isCancelled() -> Outcome.Stopped("cancelled: the app took the replica", lines)
                nowMs() >= deadlineMs -> Outcome.Stopped("out of time", lines)
                else -> {
                    val line = stream.readLine()
                    when {
                        line == null -> Outcome.Stopped("the service ended the stream", lines)
                        line.isBlank() -> null
                        else -> {
                            lines += 1
                            verdict(instructions(core.control("line_text", line)), lines)
                        }
                    }
                }
            }
        }
        return outcome
    }

    /** What the core's answer to one line means for the run, or null to keep reading. */
    private fun verdict(instructions: List<JSONObject>, lines: Int): Outcome? {
        for (instruction in instructions) {
            when {
                instruction.has("DidCompleteSync") -> return Outcome.Completed(lines)
                instruction.has("CloseSyncStream") -> return Outcome.Stopped("the core closed the stream", lines)
                instruction.optJSONObject("FetchCredentials")?.optBoolean("did_expire") == true ->
                    return Outcome.Stopped("the sync token expired", lines)
            }
        }
        return null
    }

    private fun instructions(raw: String): List<JSONObject> {
        val array = JSONArray(raw)
        return (0 until array.length()).map { array.getJSONObject(it) }
    }
}
