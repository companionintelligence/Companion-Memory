package com.companionintelligence.localllm

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The pure decisions behind `isAvailable`, `downloadModel` and `loadModel`. Plain JUnit: none of
 * [LocalLlmPolicy] touches an Android type, which is the point of it being separate from the plugin.
 */
class LocalLlmPolicyTest {

    private val gib = 1024L * 1024 * 1024
    private val mib = 1024L * 1024

    private val qwen3 = LocalLlmModels.QWEN3_0_6B_INT4
    private val qwen25 = LocalLlmModels.QWEN2_5_1_5B_INSTRUCT
    private val e2b = LocalLlmModels.GEMMA_4_E2B_IT
    private val e4b = LocalLlmModels.GEMMA_4_E4B_IT

    /** The model's one allowed url, with the host swappable so a rejection can be pinned on the host alone. */
    private fun pinnedUrl(info: LocalLlmModelInfo, host: String = "huggingface.co") =
        "https://$host${LocalLlmPolicy.downloadPathFor(info)}?download=true"

    /** The right path on the given authority — everything but [authority] is correct, so only it can be why it is refused. */
    private fun withAuthority(authority: String, info: LocalLlmModelInfo = qwen3) =
        "https://$authority${LocalLlmPolicy.downloadPathFor(info)}"

    // ---- isAvailable ------------------------------------------------------------------------

    @Test
    fun a_device_is_available_when_it_can_run_the_smallest_model_whatever_its_free_disk() {
        val smallest = LocalLlmModels.smallestMinDeviceMemoryBytes

        val ok = LocalLlmPolicy.availability(sdkInt = 26, deviceMemoryBytes = smallest, smallestModelMinMemoryBytes = smallest)
        assertTrue(ok.available)
        assertNull(ok.reason)

        // Free disk is not an input at all any more: the old global 1 GiB floor blocked a 344 MB model
        // on a phone that had room for it, and waved a 3.6 GB one through. It is per model, below.
        assertTrue(LocalLlmPolicy.availability(34, 12 * gib, smallest).available)
    }

    @Test
    fun an_old_android_or_too_little_ram_makes_the_device_unavailable_with_a_reason() {
        val smallest = LocalLlmModels.smallestMinDeviceMemoryBytes

        val oldAndroid = LocalLlmPolicy.availability(sdkInt = 25, deviceMemoryBytes = 16 * gib, smallestModelMinMemoryBytes = smallest)
        assertFalse(oldAndroid.available)
        assertTrue(oldAndroid.reason!!, oldAndroid.reason!!.contains("API 26"))

        val lowRam = LocalLlmPolicy.availability(sdkInt = 34, deviceMemoryBytes = 3 * gib, smallestModelMinMemoryBytes = smallest)
        assertFalse(lowRam.available)
        assertTrue(lowRam.reason!!, lowRam.reason!!.contains("3 GB") && lowRam.reason!!.contains("4 GB"))
    }

    // ---- advertised memory ------------------------------------------------------------------

    @Test
    fun advertised_memory_recovers_the_nominal_size_a_phone_is_sold_with() {
        // MemoryInfo.totalMem on a phone sold as "8 GB" is about 7.3 GiB; compared raw against an 8 GiB
        // floor it would be refused by the very models sized for it.
        val totalOf8GbPhone = (7.3 * gib).toLong()
        assertEquals(8 * gib, LocalLlmPolicy.advertisedMemoryBytes(totalOf8GbPhone, advertisedMemBytes = null))
        assertEquals(12 * gib, LocalLlmPolicy.advertisedMemoryBytes((11.2 * gib).toLong(), null))
        assertEquals(6 * gib, LocalLlmPolicy.advertisedMemoryBytes((5.5 * gib).toLong(), null))
        assertEquals(4 * gib, LocalLlmPolicy.advertisedMemoryBytes((3.7 * gib).toLong(), null))
        // Already a whole GiB: unchanged, not bumped to the next one.
        assertEquals(8 * gib, LocalLlmPolicy.advertisedMemoryBytes(8 * gib, null))
    }

    @Test
    fun the_platforms_own_advertised_figure_wins_when_it_exists_and_is_sane() {
        assertEquals(8 * gib, LocalLlmPolicy.advertisedMemoryBytes((7.3 * gib).toLong(), 8 * gib))
        // An advertised figure below the kernel's own total, or zero, is not credible.
        assertEquals(8 * gib, LocalLlmPolicy.advertisedMemoryBytes((7.3 * gib).toLong(), 4 * gib))
        assertEquals(8 * gib, LocalLlmPolicy.advertisedMemoryBytes((7.3 * gib).toLong(), 0L))
        assertEquals(0L, LocalLlmPolicy.advertisedMemoryBytes(0L, null))
    }

    // ---- RAM floor --------------------------------------------------------------------------

    @Test
    fun a_model_is_refused_below_its_ram_floor_and_accepted_at_it() {
        assertNull(LocalLlmPolicy.ramShortfallMessage(qwen3, 4 * gib))
        assertNull(LocalLlmPolicy.ramShortfallMessage(qwen25, 6 * gib))
        assertNull(LocalLlmPolicy.ramShortfallMessage(e2b, 8 * gib))
        assertNull(LocalLlmPolicy.ramShortfallMessage(e4b, 16 * gib))

        val tooSmall = LocalLlmPolicy.ramShortfallMessage(e2b, 6 * gib)
        assertNotNull(tooSmall)
        // The sentence is shown to the user: name the model and both numbers.
        assertTrue(tooSmall!!, tooSmall.contains("gemma-4-e2b-it") && tooSmall.contains("6 GB") && tooSmall.contains("8 GB"))

        assertNotNull(LocalLlmPolicy.ramShortfallMessage(qwen3, 4 * gib - 1))
        assertNotNull(LocalLlmPolicy.ramShortfallMessage(e4b, 8 * gib))
    }

    @Test
    fun an_eight_gb_phone_runs_the_e2b_and_not_the_e4b_once_its_memory_is_reported_as_advertised() {
        val advertised = LocalLlmPolicy.advertisedMemoryBytes((7.3 * gib).toLong(), null)
        assertNull(LocalLlmPolicy.ramShortfallMessage(e2b, advertised))
        assertNotNull(LocalLlmPolicy.ramShortfallMessage(e4b, advertised))
    }

    // ---- disk headroom ----------------------------------------------------------------------

    @Test
    fun resumable_bytes_counts_only_a_partial_that_is_shorter_than_the_whole_file() {
        assertEquals(0L, LocalLlmPolicy.resumableBytes(0L, qwen3.sizeBytes))
        assertEquals(100L * mib, LocalLlmPolicy.resumableBytes(100L * mib, qwen3.sizeBytes))
        assertEquals(qwen3.sizeBytes - 1, LocalLlmPolicy.resumableBytes(qwen3.sizeBytes - 1, qwen3.sizeBytes))
        // As long as the file, or longer: not a resume point (a Range past the end answers 416). This
        // is what every failed Qwen3 download left behind.
        assertEquals(0L, LocalLlmPolicy.resumableBytes(qwen3.sizeBytes, qwen3.sizeBytes))
        assertEquals(0L, LocalLlmPolicy.resumableBytes(qwen3.sizeBytes + 1, qwen3.sizeBytes))
    }

    @Test
    fun a_fresh_download_needs_its_size_plus_512_mib_free() {
        assertEquals(512L * mib, LocalLlmPolicy.DISK_HEADROOM_BYTES)
        assertEquals(qwen3.sizeBytes + 512L * mib, LocalLlmPolicy.requiredFreeBytes(qwen3, partLength = 0))
        assertEquals(e4b.sizeBytes + 512L * mib, LocalLlmPolicy.requiredFreeBytes(e4b, partLength = 0))
    }

    @Test
    fun a_resumed_download_only_needs_room_for_what_is_left() {
        val have = 200L * mib
        assertEquals(
            (e2b.sizeBytes - have) + 512L * mib,
            LocalLlmPolicy.requiredFreeBytes(e2b, partLength = have),
        )
        // A stale full-length partial is discarded by the worker, so it earns no credit here.
        assertEquals(
            qwen3.sizeBytes + 512L * mib,
            LocalLlmPolicy.requiredFreeBytes(qwen3, partLength = qwen3.sizeBytes),
        )
    }

    @Test
    fun the_disk_check_is_per_model_and_exact_at_the_boundary() {
        val needed = LocalLlmPolicy.requiredFreeBytes(qwen3, 0)
        assertNull(LocalLlmPolicy.diskShortfallMessage(qwen3, 0, freeBytes = needed))
        assertNull(LocalLlmPolicy.diskShortfallMessage(qwen3, 0, freeBytes = needed + 1))

        val short = LocalLlmPolicy.diskShortfallMessage(qwen3, 0, freeBytes = needed - 1)
        assertNotNull(short)
        assertTrue(short!!, short.contains("qwen3-0.6b-int4") && short.contains("Not enough free storage"))
    }

    @Test
    fun the_old_one_gib_floor_is_gone_a_small_model_fits_where_a_big_one_does_not() {
        // 900 MB free: the old global gate ("< 1 GiB free => unavailable") refused every model here.
        val free = 900L * mib
        assertNull("the 344 MB model needs ~841 MB and fits", LocalLlmPolicy.diskShortfallMessage(qwen3, 0, free))
        assertNotNull(LocalLlmPolicy.diskShortfallMessage(qwen25, 0, free))
        assertNotNull(LocalLlmPolicy.diskShortfallMessage(e4b, 0, free))

        // 3 GB free is plenty for the first three models and not for the 3.6 GB one — the case the
        // old gate waved through and let fail 80% of the way in.
        val threeGb = 3L * gib
        assertNull(LocalLlmPolicy.diskShortfallMessage(qwen25, 0, threeGb))
        assertNotNull(LocalLlmPolicy.diskShortfallMessage(e4b, 0, threeGb))
    }

    // ---- the download host allow-list and pinning --------------------------------------------

    @Test
    fun the_pinned_huggingface_url_is_accepted_for_every_catalog_model() {
        for (info in LocalLlmModels.ALL) {
            assertNull(info.modelId, LocalLlmPolicy.downloadUrlProblem(info, pinnedUrl(info)))
            // The url the native side derives is one it accepts, and is the model's own path.
            assertNull(info.modelId, LocalLlmPolicy.downloadUrlProblem(info, LocalLlmPolicy.downloadUrlFor(info)))
            assertEquals(
                "https://huggingface.co/${info.hfRepo}/resolve/${info.commitHash}/${info.fileName}?download=true",
                LocalLlmPolicy.downloadUrlFor(info),
            )
        }
        // Subdomains of huggingface.co are fine; so is a differently-cased host.
        assertNull(LocalLlmPolicy.downloadUrlProblem(qwen3, pinnedUrl(qwen3, host = "cdn.huggingface.co")))
        assertNull(LocalLlmPolicy.downloadUrlProblem(qwen3, pinnedUrl(qwen3, host = "HuggingFace.co")))
        // The query string is ignored — with or without it, whatever it says — and so is surrounding whitespace.
        assertNull(LocalLlmPolicy.downloadUrlProblem(qwen3, withAuthority("huggingface.co")))
        assertNull(LocalLlmPolicy.downloadUrlProblem(qwen3, withAuthority("huggingface.co") + "?download=true&x=1"))
        assertNull(LocalLlmPolicy.downloadUrlProblem(qwen3, "  " + withAuthority("huggingface.co") + "  "))
    }

    @Test
    fun a_moving_ref_is_refused_so_a_stale_bundle_cannot_reintroduce_the_size_drift() {
        val main = "https://huggingface.co/${qwen3.hfRepo}/resolve/main/${qwen3.fileName}?download=true"
        val problem = LocalLlmPolicy.downloadUrlProblem(qwen3, main)
        assertNotNull(problem)
        assertTrue(problem!!, problem.contains("pinned"))

        // Pinned to a different commit than the catalog's is just as wrong: the size would not match.
        val otherCommit = "https://huggingface.co/${qwen3.hfRepo}/resolve/${"0".repeat(40)}/${qwen3.fileName}"
        assertNotNull(LocalLlmPolicy.downloadUrlProblem(qwen3, otherCommit))
    }

    @Test
    fun the_path_must_equal_the_models_own_not_merely_end_with_it() {
        val commit = qwen3.commitHash
        val file = qwen3.fileName
        val refused =
            listOf(
                // The attack that a suffix match let through: a moving ref in an attacker's repo whose *path
                // happens to end* in `/resolve/<commit>/<file>`. Byte size would have been the only check left.
                "https://huggingface.co/attacker/repo/resolve/main/resolve/$commit/$file",
                // The same, prefixed onto the real repo.
                "https://huggingface.co/attacker/${qwen3.hfRepo}/resolve/$commit/$file",
                "https://huggingface.co/x/resolve/$commit/$file",
                // Right commit and file name in someone else's repository.
                "https://huggingface.co/attacker/${qwen3.hfRepo.substringAfter('/')}/resolve/$commit/$file",
                // Another of the catalog's repositories.
                "https://huggingface.co/${e2b.hfRepo}/resolve/$commit/$file",
                // Extra segments after the file, and path traversal.
                "https://huggingface.co${LocalLlmPolicy.downloadPathFor(qwen3)}/extra",
                "https://huggingface.co${LocalLlmPolicy.downloadPathFor(qwen3)}/../../other.bin",
                "https://huggingface.co/${qwen3.hfRepo}/resolve/$commit/../$commit/$file",
                // Encoded look-alikes are not the same string.
                "https://huggingface.co/${qwen3.hfRepo}/resolve/$commit/${file.replace("Q", "%51")}",
                // Trailing slash.
                "https://huggingface.co${LocalLlmPolicy.downloadPathFor(qwen3)}/",
            )
        for (url in refused) {
            assertNotNull("should have been refused: $url", LocalLlmPolicy.downloadUrlProblem(qwen3, url))
        }
    }

    @Test
    fun a_url_for_a_different_models_file_is_refused_under_this_model_id() {
        assertNotNull(LocalLlmPolicy.downloadUrlProblem(qwen3, pinnedUrl(e2b)))
        assertNotNull(LocalLlmPolicy.downloadUrlProblem(e2b, pinnedUrl(qwen3)))
        for (a in LocalLlmModels.ALL) {
            for (b in LocalLlmModels.ALL) {
                if (a !== b) assertNotNull("${a.modelId} accepted ${b.modelId}'s url", LocalLlmPolicy.downloadUrlProblem(a, pinnedUrl(b)))
            }
        }
    }

    @Test
    fun a_host_that_is_not_huggingface_is_refused_however_it_is_dressed_up() {
        // Each of these carries the model's *correct* path, so the host is the only thing wrong with it.
        val refused =
            listOf(
                withAuthority("evil.example"),
                // Look-alikes: a suffix that is not a subdomain, and a subdomain of someone else's domain.
                withAuthority("evilhuggingface.co"),
                withAuthority("huggingface.co.evil.example"),
                // Credentials in the authority: the *host* here is evil.example.
                withAuthority("huggingface.co@evil.example"),
                withAuthority("huggingface.co:secret@evil.example"),
                // A redirect *target* is followed by the connection, never accepted as an input url.
                withAuthority("cdn-lfs.hf.co"),
                withAuthority("127.0.0.1"),
                withAuthority("localhost"),
            )
        for (url in refused) {
            assertNotNull("should have been refused: $url", LocalLlmPolicy.downloadUrlProblem(qwen3, url))
        }
    }

    @Test
    fun only_https_on_the_default_port_is_accepted() {
        val path = LocalLlmPolicy.downloadPathFor(qwen3)
        assertNotNull(LocalLlmPolicy.downloadUrlProblem(qwen3, "http://huggingface.co$path"))
        assertNotNull(LocalLlmPolicy.downloadUrlProblem(qwen3, "ftp://huggingface.co$path"))
        assertNotNull(LocalLlmPolicy.downloadUrlProblem(qwen3, "file:///data/local/tmp/${qwen3.fileName}"))
        assertNotNull(LocalLlmPolicy.downloadUrlProblem(qwen3, withAuthority("huggingface.co:8443")))
        assertNull(LocalLlmPolicy.downloadUrlProblem(qwen3, withAuthority("huggingface.co:443")))
        assertNotNull(LocalLlmPolicy.downloadUrlProblem(qwen3, ""))
        assertNotNull(LocalLlmPolicy.downloadUrlProblem(qwen3, "not a url at all"))
        assertNotNull(LocalLlmPolicy.downloadUrlProblem(qwen3, "//huggingface.co$path"))
    }

    @Test
    fun the_host_allow_list_is_exactly_huggingface_dot_co_and_its_subdomains() {
        assertTrue(LocalLlmPolicy.isAllowedDownloadHost("huggingface.co"))
        assertTrue(LocalLlmPolicy.isAllowedDownloadHost("HUGGINGFACE.CO"))
        assertTrue(LocalLlmPolicy.isAllowedDownloadHost("cdn-lfs.huggingface.co"))
        assertTrue(LocalLlmPolicy.isAllowedDownloadHost("huggingface.co."))
        assertFalse(LocalLlmPolicy.isAllowedDownloadHost("hf.co"))
        assertFalse(LocalLlmPolicy.isAllowedDownloadHost("cdn-lfs.hf.co"))
        assertFalse(LocalLlmPolicy.isAllowedDownloadHost("nothuggingface.co"))
        assertFalse(LocalLlmPolicy.isAllowedDownloadHost("huggingface.co.attacker.net"))
        assertFalse(LocalLlmPolicy.isAllowedDownloadHost(""))
    }

    // ---- accelerator resolution --------------------------------------------------------------

    @Test
    fun an_absent_accelerator_takes_the_models_first_listed_one() {
        assertEquals(LocalLlmAccelerator.CPU, LocalLlmPolicy.resolveAccelerator(qwen3, null).accelerator)
        assertEquals(LocalLlmAccelerator.GPU, LocalLlmPolicy.resolveAccelerator(e2b, null).accelerator)
        assertFalse(LocalLlmPolicy.resolveAccelerator(e2b, null).preferenceUnsupported)
    }

    @Test
    fun a_listed_preference_is_honoured_and_an_unlisted_one_is_replaced_by_the_default() {
        assertEquals(LocalLlmAccelerator.CPU, LocalLlmPolicy.resolveAccelerator(e2b, LocalLlmAccelerator.CPU).accelerator)
        assertEquals(LocalLlmAccelerator.GPU, LocalLlmPolicy.resolveAccelerator(qwen25, LocalLlmAccelerator.GPU).accelerator)

        // Qwen3 lists only the CPU, so a GPU request is overridden — and says so.
        val choice = LocalLlmPolicy.resolveAccelerator(qwen3, LocalLlmAccelerator.GPU)
        assertEquals(LocalLlmAccelerator.CPU, choice.accelerator)
        assertTrue(choice.preferenceUnsupported)
    }

    @Test
    fun accelerator_wire_names_round_trip_and_unknown_ones_are_null() {
        assertEquals(LocalLlmAccelerator.GPU, LocalLlmAccelerator.fromWire("gpu"))
        assertEquals(LocalLlmAccelerator.CPU, LocalLlmAccelerator.fromWire("cpu"))
        assertNull(LocalLlmAccelerator.fromWire("npu"))
        assertNull(LocalLlmAccelerator.fromWire("GPU"))
        assertNull(LocalLlmAccelerator.fromWire(null))
    }

    // ---- tool-result budget ---------------------------------------------------------------------

    @Test
    fun a_tool_result_may_take_half_the_context_window_in_bytes() {
        assertEquals("Qwen3-0.6B's window", 512, LocalLlmPolicy.toolResultByteBudget(1024))
        assertEquals("a 4k window", 2048, LocalLlmPolicy.toolResultByteBudget(4096))
        assertEquals("Gemma 4's window", 2000, LocalLlmPolicy.toolResultByteBudget(4000))
        assertEquals("an 8k window", 4096, LocalLlmPolicy.toolResultByteBudget(8192))
    }

    @Test
    fun the_tool_result_budget_has_a_floor_and_a_ceiling() {
        assertEquals("capped like the appliance's", 16_384, LocalLlmPolicy.toolResultByteBudget(1_000_000))
        assertEquals("the ceiling is reached at a 32k window", 16_384, LocalLlmPolicy.toolResultByteBudget(32_768))
        assertEquals(16_383, LocalLlmPolicy.toolResultByteBudget(32_766))
        assertEquals(16_384, LocalLlmPolicy.toolResultByteBudget(Int.MAX_VALUE))

        assertEquals("a tiny window keeps a floor", 256, LocalLlmPolicy.toolResultByteBudget(100))
        assertEquals("the floor is reached at 512", 256, LocalLlmPolicy.toolResultByteBudget(512))
        assertEquals(257, LocalLlmPolicy.toolResultByteBudget(514))
        assertEquals(256, LocalLlmPolicy.toolResultByteBudget(0))
        assertEquals("nonsense keeps the floor", 256, LocalLlmPolicy.toolResultByteBudget(-5))
        assertEquals(256, LocalLlmPolicy.toolResultByteBudget(Int.MIN_VALUE))
    }

    @Test
    fun every_catalog_model_that_can_call_tools_gets_a_budget_smaller_than_its_window() {
        for (info in LocalLlmModels.ALL.filter { it.supportsTools }) {
            val budget = LocalLlmPolicy.toolResultByteBudget(info.defaultMaxTokens)

            // Bytes against tokens, but a token is never less than a byte: a budget under the window in tokens
            // cannot fill it, however the text tokenises.
            assertTrue("${info.modelId}: $budget bytes in a ${info.defaultMaxTokens} token window", budget < info.defaultMaxTokens)
        }
    }

    // ---- wording -------------------------------------------------------------------------------

    @Test
    fun byte_counts_read_naturally_in_the_messages_shown_to_the_user() {
        assertEquals("512 MB", LocalLlmPolicy.formatBytes(512L * mib))
        assertEquals("4 GB", LocalLlmPolicy.formatBytes(4 * gib))
        assertEquals("3.4 GB", LocalLlmPolicy.formatBytes((3.4 * gib).toLong()))
        assertEquals("1 MB", LocalLlmPolicy.formatBytes(1))
        assertEquals("0 MB", LocalLlmPolicy.formatBytes(0))
    }
}
