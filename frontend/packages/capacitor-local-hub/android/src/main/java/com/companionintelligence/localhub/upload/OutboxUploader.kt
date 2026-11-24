package com.companionintelligence.localhub.upload

import com.companionintelligence.localhub.OutboxQueue
import com.companionintelligence.localhub.location.PositionRecordJson
import org.json.JSONArray
import org.json.JSONObject

/** One HTTP exchange with the appliance. `status` is null when no response arrived at all. */
data class UploadResponse(val status: Int?, val error: String? = null) {
    val ok: Boolean get() = status != null && status in 200..299
}

/** POSTs a JSON body to the appliance with the API key. Behind an interface for the tests. */
fun interface UploadTransport {
    fun postJson(url: String, apiKey: String, body: String): UploadResponse
}

/**
 * Whether the appliance still owes processing for rows that were uploaded. Persisted, because
 * the process that uploaded them can die before the finish call goes out.
 */
interface IngestFinishDebt {
    fun isOwed(): Boolean
    fun setOwed(owed: Boolean)
}

/**
 * Sends the positions waiting in the outbox to the appliance without the app being open.
 *
 * The same contract as the web flusher (`flushOutbox` in `@ci/common`'s `outboxFlush.ts`),
 * narrowed to the one kind native code produces:
 *
 * - **Only rows stamped for the session being sent under** ([OutboxOwnerStamp]). Rows from
 *   another account or another appliance stay put for the app to deal with.
 * - **A row leaves the queue only after the appliance accepted it.** A 4xx that waiting
 *   cannot fix (see [isPermanent]) parks the row in `needs_attention`, where the app shows it.
 * - **Transient failures cost no attempts.** The phone is often out of reach of its
 *   appliance (away from home, no tunnel); counting those would park every fix of a trip in
 *   `needs_attention` within minutes. The caller retries the whole drain later instead.
 * - **Then `POST /api/v1/ingest/finish`**, because `/api/v1/positions` stores rows without
 *   reverse geocoding or location estimates and leaves asking for them to the client.
 *
 * Both sides may drain at once when the app is open; the appliance drops a position whose
 * timestamp it already holds, so a row sent twice is stored once.
 */
class OutboxUploader(
    private val outbox: OutboxQueue,
    private val transport: UploadTransport,
    private val finishDebt: IngestFinishDebt,
) {
    sealed class Outcome {
        /** Everything sendable went out (possibly nothing), and no processing is owed. */
        data class Done(val sent: Int) : Outcome()
        /** The appliance could not be reached or was unwell; try the whole drain again later. */
        data class RetryLater(val sent: Int, val reason: String) : Outcome()
    }

    fun drain(origin: String, apiKey: String): Outcome {
        val base = origin.trimEnd('/')
        val stamp = OutboxOwnerStamp.of(base, apiKey)
        var sent = 0

        // Re-listed until a pass finds nothing: the tracker can queue fixes while this runs.
        // Each pass either removes rows or parks them, so the loop ends; the cap is a backstop.
        for (pass in 0 until MAX_PASSES) {
            val batch = outbox.list(STATUS_PENDING)
                .filter { it.kind == PositionRecordJson.OUTBOX_KIND && it.owner == stamp }
                .sortedBy { it.seq }
            if (batch.isEmpty()) {
                break
            }
            for (row in batch) {
                val payload = outbox.get(row.id)?.payload ?: continue
                val response = transport.postJson("$base$POSITIONS_PATH", apiKey, payload)
                when {
                    response.ok -> {
                        // Debt first, so it survives a crash between the two writes.
                        finishDebt.setOwed(true)
                        outbox.delete(row.id)
                        sent += 1
                    }
                    isPermanent(response.status) -> {
                        outbox.recordFailedAttempt(row.id, describe(response), permanent = true)
                    }
                    else -> return Outcome.RetryLater(sent, describe(response))
                }
            }
        }

        if (finishDebt.isOwed()) {
            val body = JSONObject().put("stages", JSONArray(FINISH_STAGES)).toString()
            val response = transport.postJson("$base$INGEST_FINISH_PATH", apiKey, body)
            when {
                // A permanent refusal will not change by asking again; drop the debt rather
                // than retry it forever. The rows are stored either way.
                response.ok || isPermanent(response.status) -> finishDebt.setOwed(false)
                else -> return Outcome.RetryLater(sent, "ingest finish: ${describe(response)}")
            }
        }
        return Outcome.Done(sent)
    }

    companion object {
        const val POSITIONS_PATH = "/api/v1/positions"
        const val INGEST_FINISH_PATH = "/api/v1/ingest/finish"

        /** `POSITION_FINISH_STAGES` in `outboxFlush.ts`, in the appliance's canonical order. */
        val FINISH_STAGES = listOf("reverse_position", "estimate_locations")

        private const val STATUS_PENDING = "pending"
        private const val MAX_PASSES = 20

        /** `RETRYABLE_CLIENT_STATUSES` in `outboxFlush.ts`; 409 added for a finish already running. */
        private val RETRYABLE_CLIENT_STATUSES = setOf(401, 403, 408, 409, 425, 429)

        /** `isPermanentFlushFailure`: a 4xx outside the retryable set. No response is transient. */
        fun isPermanent(status: Int?): Boolean =
            status != null && status in 400..499 && status !in RETRYABLE_CLIENT_STATUSES

        private fun describe(response: UploadResponse): String =
            response.error ?: "HTTP ${response.status}"
    }
}
