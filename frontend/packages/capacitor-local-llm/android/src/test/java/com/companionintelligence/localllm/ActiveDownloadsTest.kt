package com.companionintelligence.localllm

import kotlin.concurrent.thread
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class ActiveDownloadsTest {

    @Test
    fun a_model_is_active_between_begin_and_end() {
        val downloads = ActiveDownloads()
        assertFalse(downloads.isActive("m"))

        downloads.begin("m")
        assertTrue(downloads.isActive("m"))
        assertFalse("another model is unaffected", downloads.isActive("other"))

        downloads.end("m")
        assertFalse(downloads.isActive("m"))
    }

    @Test
    fun waiting_on_an_idle_model_returns_at_once() {
        val started = System.nanoTime()
        assertTrue(ActiveDownloads().awaitIdle("m", timeoutMs = 10_000))
        assertTrue(System.nanoTime() - started < 1_000_000_000L)
    }

    @Test
    fun waiting_returns_when_the_worker_really_ends() {
        val downloads = ActiveDownloads()
        downloads.begin("m")
        thread {
            Thread.sleep(150)
            downloads.end("m")
        }

        assertTrue(downloads.awaitIdle("m", timeoutMs = 5_000))
        assertFalse(downloads.isActive("m"))
    }

    @Test
    fun waiting_is_bounded_so_a_stalled_socket_cannot_hang_a_delete() {
        val downloads = ActiveDownloads()
        downloads.begin("m")

        val started = System.nanoTime()
        assertFalse(downloads.awaitIdle("m", timeoutMs = 150))
        val tookMs = (System.nanoTime() - started) / 1_000_000

        assertTrue("took ${tookMs}ms", tookMs in 100..2_000)
        assertTrue("still active", downloads.isActive("m"))
    }

    @Test
    fun overlapping_workers_for_one_model_are_counted() {
        val downloads = ActiveDownloads()
        downloads.begin("m")
        downloads.begin("m")

        downloads.end("m")
        assertTrue("one is still running", downloads.isActive("m"))
        downloads.end("m")
        assertFalse(downloads.isActive("m"))
    }
}
