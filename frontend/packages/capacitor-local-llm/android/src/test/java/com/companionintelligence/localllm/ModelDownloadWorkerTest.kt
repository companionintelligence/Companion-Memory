package com.companionintelligence.localllm

import androidx.work.Data
import androidx.work.ListenableWorker
import androidx.work.testing.TestListenableWorkerBuilder
import java.io.File
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment

/**
 * The byte-range/resume arithmetic in [ModelDownloadWorker] is the richest logic in this module
 * and the hardest to eyeball: every branch is "add this offset or don't", and getting it wrong
 * produces a *corrupt* 344 MB file rather than a crash. These tests run the real `doWork()`
 * against a real socket and assert on the resulting bytes.
 */
@RunWith(RobolectricTestRunner::class)
class ModelDownloadWorkerTest {

    private val context get() = RuntimeEnvironment.getApplication()
    private val info = LocalLlmModels.QWEN3_0_6B_INT4

    /**
     * Larger than `DEFAULT_BUFFER_SIZE` (8 KiB) so the copy loop really iterates, and
     * non-constant so an off-by-one in the resume offset shows up as mismatched content rather
     * than as bytes that happen to be identical.
     */
    private val payload = ByteArray(20_000) { (it % 251).toByte() }

    @Before
    fun startFromAnEmptyModelsDir() {
        modelsDir(context).deleteRecursively()
    }

    @Test
    fun the_worker_writes_the_file_the_plugin_looks_for_and_clears_the_partial() {
        // The worker builds its own paths from string literals (`"local-llm-models"`,
        // `"$fileName.part"`) while the plugin reads them through modelsDir()/modelFile()/
        // tmpModelFile(). Two copies of one contract; this is what holds them together.
        assertEquals(File(context.filesDir, "local-llm-models").path, modelsDir(context).path)
        assertEquals(File(modelsDir(context), info.fileName + ".part").path, tmpModelFile(context, info).path)

        TestHttpServer { exchange, _ -> exchange.respond(200, payload) }.use { server ->
            val result = runWorker(inputData(server.baseUrl + "/model", totalBytesHint = payload.size.toLong()))

            assertSucceeded(result)
            assertArrayEquals(payload, modelFile(context, info).readBytes())
            assertFalse("the .part file should have been renamed away", tmpModelFile(context, info).exists())
        }
    }

    @Test
    fun a_server_that_ignores_range_restarts_the_download_instead_of_appending_to_junk() {
        val partial = tmpModelFile(context, info)
        partial.parentFile!!.mkdirs()
        partial.writeBytes(ByteArray(100) { 0x7f })

        // Answers 200 with the whole body no matter what Range was asked for — the behaviour of
        // any mirror or CDN that does not implement ranges.
        TestHttpServer { exchange, _ -> exchange.respond(200, payload) }.use { server ->
            val result = runWorker(inputData(server.baseUrl + "/model", totalBytesHint = payload.size.toLong()))

            assertSucceeded(result)
            // Not junk-then-payload: the worker has to notice the 200 and start over.
            assertArrayEquals(payload, modelFile(context, info).readBytes())
        }
    }

    @Test
    fun an_interrupted_download_resumes_from_the_partial_files_own_length() {
        val alreadyHave = 6_000
        val partial = tmpModelFile(context, info)
        partial.parentFile!!.mkdirs()
        partial.writeBytes(payload.copyOfRange(0, alreadyHave))

        TestHttpServer(::serveRanges).use { server ->
            val result = runWorker(inputData(server.baseUrl + "/model", totalBytesHint = payload.size.toLong()))

            assertSucceeded(result)
            // `bytes=6000-` and not `bytes=6001-`: the offset is a count of bytes already held,
            // so it is also the index of the first byte still wanted.
            assertEquals("bytes=$alreadyHave-", server.requests.single().headers["range"]?.firstOrNull())
            // Proves the stream was appended rather than written from offset 0.
            assertArrayEquals(payload, modelFile(context, info).readBytes())
        }
    }

    @Test
    fun a_resumed_download_with_no_size_hint_derives_the_total_from_the_range_offset() {
        val alreadyHave = 6_000
        val partial = tmpModelFile(context, info)
        partial.parentFile!!.mkdirs()
        partial.writeBytes(payload.copyOfRange(0, alreadyHave))

        TestHttpServer(::serveRanges).use { server ->
            // No KEY_TOTAL_BYTES: the expected size must come from Content-Length *plus* what is
            // already on disk. If it came from Content-Length alone the finished file would be
            // 20,000 bytes against an expected 14,000 and the worker would fail a good download.
            val result = runWorker(inputData(server.baseUrl + "/model"))

            assertSucceeded(result)
            assertArrayEquals(payload, modelFile(context, info).readBytes())
        }
    }

    @Test
    fun a_chunked_response_of_unknown_length_completes_instead_of_dividing_by_zero() {
        // Content-Length is absent, so totalBytes resolves to 0 and the percentage for the
        // foreground notification has nothing to divide by.
        TestHttpServer { exchange, _ -> exchange.respondChunked(200, payload) }.use { server ->
            val result = runWorker(inputData(server.baseUrl + "/model"))

            assertSucceeded(result)
            // With an unknown total the final size check must also be skipped, not failed.
            assertArrayEquals(payload, modelFile(context, info).readBytes())
        }
    }

    @Test
    fun an_already_downloaded_model_short_circuits_without_touching_the_network() {
        val dest = modelFile(context, info)
        dest.parentFile!!.mkdirs()
        dest.writeBytes(payload)

        TestHttpServer { exchange, _ -> exchange.respond(500, "should never be asked for") }.use { server ->
            val result = runWorker(inputData(server.baseUrl + "/model", totalBytesHint = payload.size.toLong()))

            assertSucceeded(result)
            // Re-fetching 344 MB because a retry ran after the file landed is the whole point of
            // the early return.
            assertTrue("worker contacted the server for a file it already had", server.requests.isEmpty())
            assertArrayEquals(payload, dest.readBytes())
        }
    }

    @Test
    fun missing_input_data_fails_with_a_reason_the_plugin_can_forward() {
        val result =
            runWorker(
                Data.Builder().putString(ModelDownloadWorker.KEY_URL, "http://127.0.0.1:1/model").build(),
            )

        // LocalLlmPlugin.currentStatus and observeDownload both read KEY_ERROR out of
        // outputData; a bare Result.failure() degrades every diagnosis to "Download failed".
        assertEquals("Missing modelId/url/fileName", failureReason(result))
    }

    @Test
    fun an_http_error_is_reported_by_status_code_rather_than_as_a_generic_failure() {
        // 404/401 here is the documented Hugging Face gated-repo case — the one download failure
        // a support person can actually act on, and only if the code survives to the UI.
        TestHttpServer { exchange, _ -> exchange.respond(404, """{"error":"GatedRepo"}""") }.use { server ->
            val result = runWorker(inputData(server.baseUrl + "/model", totalBytesHint = payload.size.toLong()))

            assertEquals("HTTP 404", failureReason(result))
            assertFalse(modelFile(context, info).exists())
        }
    }

    @Test
    fun a_truncated_body_is_rejected_instead_of_being_finalised_as_the_model() {
        TestHttpServer { exchange, _ -> exchange.respond(200, payload.copyOfRange(0, 9_000)) }.use { server ->
            val result = runWorker(inputData(server.baseUrl + "/model", totalBytesHint = payload.size.toLong()))

            val reason = failureReason(result)
            assertTrue("unexpected reason: $reason", reason!!.contains("did not match expected size"))
            // A short file renamed into place would load as a corrupt bundle and be reported
            // "ready" forever, since every status check is `file.exists()`.
            assertFalse(modelFile(context, info).exists())
        }
    }

    // ---- harness ----------------------------------------------------------------------

    /** Honours `Range: bytes=N-` with a 206 carrying only the tail, the way Hugging Face does. */
    private fun serveRanges(exchange: TestExchange, request: RecordedRequest) {
        val range = request.headers["range"]?.firstOrNull()
        if (range == null) {
            exchange.respond(200, payload)
        } else {
            val from = range.removePrefix("bytes=").substringBefore('-').toInt()
            exchange.responseHeaders.add("Content-Range", "bytes $from-${payload.size - 1}/${payload.size}")
            exchange.respond(206, payload.copyOfRange(from, payload.size))
        }
    }

    private fun inputData(
        url: String,
        fileName: String = info.fileName,
        totalBytesHint: Long = 0L,
        modelId: String = info.modelId,
    ): Data =
        Data.Builder()
            .putString(ModelDownloadWorker.KEY_MODEL_ID, modelId)
            .putString(ModelDownloadWorker.KEY_URL, url)
            .putString(ModelDownloadWorker.KEY_FILE_NAME, fileName)
            .putLong(ModelDownloadWorker.KEY_TOTAL_BYTES, totalBytesHint)
            .build()

    private fun runWorker(inputData: Data): ListenableWorker.Result {
        val worker =
            TestListenableWorkerBuilder.from(context, ModelDownloadWorker::class.java)
                .setInputData(inputData)
                .build()

        return runBlocking { worker.doWork() }
    }

    private fun assertSucceeded(result: ListenableWorker.Result) {
        assertTrue("expected success but got $result (${failureReason(result)})", result is ListenableWorker.Result.Success)
    }

    private fun failureReason(result: ListenableWorker.Result): String? =
        (result as? ListenableWorker.Result.Failure)?.outputData?.getString(ModelDownloadWorker.KEY_ERROR)
}
