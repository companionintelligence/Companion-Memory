package com.companionintelligence.localllm

import androidx.work.Data
import androidx.work.ForegroundInfo
import androidx.work.ForegroundUpdater
import androidx.work.ListenableWorker
import androidx.work.testing.TestListenableWorkerBuilder
import com.google.common.util.concurrent.ListenableFuture
import java.io.File
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.ExecutionException
import java.util.concurrent.Executor
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
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
            // But a *short* partial is a valid prefix: it stays, so the next attempt resumes from it
            // instead of paying for the bytes again.
            assertEquals(9_000L, tmpModelFile(context, info).length())
        }
    }

    @Test
    fun a_download_that_ends_longer_than_the_catalog_size_drops_its_partial() {
        // The size-drift failure: the file at the url grew past the size the catalog recorded. The
        // over-long partial can never be resumed into the right file — a Range request for its length
        // is past the end and answers 416 — so leaving it behind makes every retry fail the same way.
        val longer = payload + ByteArray(500) { 0x55 }
        TestHttpServer { exchange, _ -> exchange.respond(200, longer) }.use { server ->
            val result = runWorker(inputData(server.baseUrl + "/model", totalBytesHint = payload.size.toLong()))

            val reason = failureReason(result)
            assertTrue("unexpected reason: $reason", reason!!.contains("did not match expected size"))
            assertFalse(modelFile(context, info).exists())
            assertFalse("the over-long .part must not be kept", tmpModelFile(context, info).exists())
        }
    }

    @Test
    fun a_stale_partial_as_long_as_the_whole_file_is_discarded_and_the_file_fetched_afresh() {
        // What a failed Qwen3 download left on disk: the *whole* file, in a .part, because the final
        // size check failed and nothing removed it. With the corrected size it equals the expected
        // length exactly; a Range request for `bytes=<length>-` would be answered 416.
        val stale = tmpModelFile(context, info)
        stale.parentFile!!.mkdirs()
        stale.writeBytes(ByteArray(payload.size) { 0x11 })

        TestHttpServer(::serveRanges).use { server ->
            val result = runWorker(inputData(server.baseUrl + "/model", totalBytesHint = payload.size.toLong()))

            assertSucceeded(result)
            assertArrayEquals("must be the server's bytes, not the stale ones", payload, modelFile(context, info).readBytes())
            assertEquals("no Range header: this is a fresh download", null, server.requests.single().headers["range"])
        }
    }

    @Test
    fun a_stale_partial_longer_than_the_expected_size_is_discarded_too() {
        val stale = tmpModelFile(context, info)
        stale.parentFile!!.mkdirs()
        stale.writeBytes(ByteArray(payload.size + 4_000) { 0x22 })

        TestHttpServer(::serveRanges).use { server ->
            val result = runWorker(inputData(server.baseUrl + "/model", totalBytesHint = payload.size.toLong()))

            assertSucceeded(result)
            assertArrayEquals(payload, modelFile(context, info).readBytes())
            assertEquals(null, server.requests.single().headers["range"])
        }
    }

    // ---- the catalog's size is what the worker verifies against ----------------------------------

    @Test
    fun the_worker_is_handed_each_catalog_models_own_size_and_file_name() {
        for (model in LocalLlmModels.ALL) {
            val data = ModelDownloadWorker.inputDataFor(model)

            // KEY_TOTAL_BYTES is what `tmpFile.length() != totalBytes` compares against. It is the catalog
            // size, byte for byte — the value that drifted for Qwen3 when `main` moved on (344,437,808 → 344,671,744).
            assertEquals(model.modelId, model.sizeBytes, data.getLong(ModelDownloadWorker.KEY_TOTAL_BYTES, -1L))
            assertEquals(model.fileName, data.getString(ModelDownloadWorker.KEY_FILE_NAME))
            assertEquals(model.modelId, data.getString(ModelDownloadWorker.KEY_MODEL_ID))

            // The url the worker fetches is derived from the catalog — the JS layer's url never reaches it.
            assertEquals(model.modelId, LocalLlmPolicy.downloadUrlFor(model), data.getString(ModelDownloadWorker.KEY_URL))
            val fetched = java.net.URI(data.getString(ModelDownloadWorker.KEY_URL)!!)
            assertEquals("https", fetched.scheme)
            assertEquals("huggingface.co", fetched.host)
            assertEquals("/${model.hfRepo}/resolve/${model.commitHash}/${model.fileName}", fetched.rawPath)
        }
    }

    @Test
    fun the_qwen3_pin_is_the_revision_that_loads_on_litert_lm_0_14_0_not_whatever_main_is_now() {
        // `main` was re-exported on 2026-09-20 (344_671_744 bytes) for LiteRT-LM 0.17.1+: on 0.14.0 it fails at
        // Engine.initialize() and it fails this size check. The pin is the older revision, size and commit as a pair.
        assertEquals("154c5de0fc0fc5002a7da570ba8c67edffa32ca2", LocalLlmModels.QWEN3_0_6B_INT4.commitHash)
        assertEquals(344_437_808L, LocalLlmModels.QWEN3_0_6B_INT4.sizeBytes)
        assertTrue(LocalLlmModels.QWEN3_0_6B_INT4.sizeBytes != 344_671_744L)
    }

    @Test
    fun a_download_of_exactly_the_catalog_size_is_accepted_and_one_byte_off_is_not() {
        val size = LocalLlmModels.QWEN3_0_6B_INT4.sizeBytes.toInt()
        val exact = ByteArray(size) { (it % 251).toByte() }

        TestHttpServer { exchange, _ -> exchange.respond(200, exact) }.use { server ->
            assertSucceeded(runWorker(inputData(server.baseUrl + "/model", totalBytesHint = size.toLong())))
            assertEquals(size.toLong(), modelFile(context, info).length())
        }

        modelsDir(context).deleteRecursively()
        val oneShort = exact.copyOf(size - 1)
        TestHttpServer { exchange, _ -> exchange.respond(200, oneShort) }.use { server ->
            val reason = failureReason(runWorker(inputData(server.baseUrl + "/model", totalBytesHint = size.toLong())))
            assertTrue("unexpected reason: $reason", reason!!.contains("did not match expected size"))
            assertFalse(modelFile(context, info).exists())
        }
    }

    // ---- cancellation, a vanishing partial, and a refused foreground promotion --------------------

    @Test
    fun a_cancelled_download_stops_promptly_and_leaves_a_valid_prefix() {
        val release = CountDownLatch(1)
        // A slow but live stream: 1,000 bytes every 100 ms, so the worker is reading, writing and reporting
        // progress when it is cancelled. (The other case — cancelled while blocked on a *silent* socket — relies
        // on HttpURLConnection.disconnect() unblocking the reader. Android's implementation does; the JDK's,
        // which is what a host-JVM test gets, waits behind the blocked read, so that path is device-only.)
        TestHttpServer { exchange, _ ->
            exchange.sendResponseHeaders(200, payload.size.toLong())
            var sent = 0
            while (sent < payload.size && !release.await(100, TimeUnit.MILLISECONDS)) {
                val n = minOf(1_000, payload.size - sent)
                exchange.responseBody.write(payload, sent, n)
                exchange.responseBody.flush()
                sent += n
            }
        }.use { server ->
            val worker = buildWorker(inputData(server.baseUrl + "/model", totalBytesHint = payload.size.toLong()))
            val job = CoroutineScope(Dispatchers.IO).launch { worker.doWork() }
            try {
                waitUntil("the worker has written the first bytes") { tmpModelFile(context, info).length() > 0 }
                assertTrue("registered while running", ModelDownloadWorker.activeDownloads.isActive(info.modelId))

                val started = System.nanoTime()
                job.cancel()
                assertTrue(
                    "the worker must report idle promptly after cancellation",
                    ModelDownloadWorker.activeDownloads.awaitIdle(info.modelId, 5_000),
                )
                val tookMs = (System.nanoTime() - started) / 1_000_000
                assertTrue("took ${tookMs}ms", tookMs < 3_000)

                // What it wrote is a genuine prefix of the file, so a later resume is sound, and it was not
                // promoted to the real model.
                assertFalse(modelFile(context, info).exists())
                val partial = tmpModelFile(context, info).readBytes()
                assertTrue(partial.isNotEmpty())
                assertTrue("still short of the whole file", partial.size < payload.size)
                assertArrayEquals(payload.copyOfRange(0, partial.size), partial)
            } finally {
                release.countDown()
                runBlocking { job.join() }
            }
        }
    }

    @Test
    fun the_worker_is_registered_as_active_exactly_while_it_runs_on_every_outcome() {
        var activeDuringTransfer = false
        TestHttpServer { exchange, _ ->
            activeDuringTransfer = ModelDownloadWorker.activeDownloads.isActive(info.modelId)
            exchange.respond(200, payload)
        }.use { server ->
            assertSucceeded(runWorker(inputData(server.baseUrl + "/model", totalBytesHint = payload.size.toLong())))
        }
        assertTrue("active while downloading", activeDuringTransfer)
        assertFalse("idle after success", ModelDownloadWorker.activeDownloads.isActive(info.modelId))

        TestHttpServer { exchange, _ -> exchange.respond(404, "nope") }.use { server ->
            failureReason(runWorker(inputData(server.baseUrl + "/model", totalBytesHint = payload.size.toLong())))
        }
        assertFalse("idle after failure", ModelDownloadWorker.activeDownloads.isActive(info.modelId))
    }

    @Test
    fun a_resume_whose_partial_vanished_mid_request_restarts_from_zero_instead_of_writing_a_wrong_offset_file() {
        val alreadyHave = 6_000
        val partial = tmpModelFile(context, info)
        partial.parentFile!!.mkdirs()
        partial.writeBytes(payload.copyOfRange(0, alreadyHave))

        TestHttpServer { exchange, request ->
            val range = request.headers["range"]?.firstOrNull()
            if (range == null) {
                exchange.respond(200, payload)
            } else {
                // The cancel/delete that raced this resume: the partial is gone before the body is read. The
                // 206 that follows starts at byte 6,000 — written to a fresh file it would be a "partial" whose
                // bytes belong at offset 6,000, and a later resume would extend it to full length with a
                // corrupt middle that still passes the size check.
                tmpModelFile(context, info).delete()
                serveRanges(exchange, request)
            }
        }.use { server ->
            val result = runWorker(inputData(server.baseUrl + "/model", totalBytesHint = payload.size.toLong()))

            assertSucceeded(result)
            assertArrayEquals("must be the whole file, not 6,000 missing bytes", payload, modelFile(context, info).readBytes())
            assertEquals(2, server.requests.size)
            assertEquals("bytes=$alreadyHave-", server.requests[0].headers["range"]?.firstOrNull())
            assertEquals("the retry starts over", null, server.requests[1].headers["range"])
        }
    }

    @Test
    fun a_download_carries_on_when_android_refuses_the_foreground_promotion() {
        // API 31+: setForeground fails with an IllegalStateException when the app is in the background and not
        // allowed to start a foreground service. That is a notification, not a reason to fail a 3 GB transfer.
        val refuse =
            object : ForegroundUpdater {
                override fun setForegroundAsync(context: android.content.Context, id: UUID, foregroundInfo: ForegroundInfo): ListenableFuture<Void> =
                    RefusedFuture(IllegalStateException("startForegroundService() not allowed due to mAllowStartForeground false"))
            }

        TestHttpServer { exchange, _ -> exchange.respond(200, payload) }.use { server ->
            val worker = buildWorker(inputData(server.baseUrl + "/model", totalBytesHint = payload.size.toLong()), refuse)
            val result = runBlocking { worker.doWork() }

            assertSucceeded(result)
            assertArrayEquals(payload, modelFile(context, info).readBytes())
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

    private fun buildWorker(inputData: Data, foreground: ForegroundUpdater? = null): ModelDownloadWorker {
        val builder = TestListenableWorkerBuilder.from(context, ModelDownloadWorker::class.java).setInputData(inputData)
        if (foreground != null) builder.setForegroundUpdater(foreground)
        return builder.build()
    }

    private fun runWorker(inputData: Data): ListenableWorker.Result = runBlocking { buildWorker(inputData).doWork() }

    /** A `ListenableFuture` that is already failed — what WorkManager hands back when the OS refuses. */
    private class RefusedFuture(private val error: Throwable) : ListenableFuture<Void> {
        override fun addListener(listener: Runnable, executor: Executor) = executor.execute(listener)

        override fun cancel(mayInterruptIfRunning: Boolean) = false

        override fun isCancelled() = false

        override fun isDone() = true

        override fun get(): Void = throw ExecutionException(error)

        override fun get(timeout: Long, unit: TimeUnit): Void = throw ExecutionException(error)
    }

    private fun waitUntil(what: String, timeoutMs: Long = 10_000, condition: () -> Boolean) {
        val deadline = System.nanoTime() + timeoutMs * 1_000_000
        while (!condition()) {
            if (System.nanoTime() > deadline) throw AssertionError("timed out waiting for: $what")
            Thread.sleep(20)
        }
    }

    private fun assertSucceeded(result: ListenableWorker.Result) {
        assertTrue("expected success but got $result (${failureReason(result)})", result is ListenableWorker.Result.Success)
    }

    private fun failureReason(result: ListenableWorker.Result): String? =
        (result as? ListenableWorker.Result.Failure)?.outputData?.getString(ModelDownloadWorker.KEY_ERROR)
}
