package com.companionintelligence.localllm

import java.net.URI
import java.net.URISyntaxException
import java.util.Locale

/**
 * The decisions [LocalLlmPlugin] makes before it touches the disk, the network or the engine,
 * kept free of `Context`, `Build` and every other framework type so each one is a plain JUnit
 * test rather than something only a device can exercise.
 */
object LocalLlmPolicy {
    /** `Build.VERSION_CODES.O` — the floor `isAvailable()` has always reported (see build.gradle). */
    const val MIN_SDK_INT = 26

    /**
     * Free space to leave on the volume *after* a model has finished downloading. The models are
     * 0.3-3.6 GB, so a fixed global "1 GiB free" floor (the old check) is wrong both ways: it
     * blocks a 344 MB download on a nearly full phone that could take it, and it lets a 3.6 GB
     * download start on a phone that has 1.2 GB left and will fail 80% of the way through.
     */
    const val DISK_HEADROOM_BYTES = 512L * 1024 * 1024

    private const val GIB = 1024L * 1024 * 1024
    private const val MIB = 1024L * 1024

    data class Availability(val available: Boolean, val reason: String?)

    /**
     * `available` means "this device can run at least the smallest model": a new enough Android and
     * enough RAM for the least demanding catalog entry. Free disk is deliberately not part of it —
     * it is per model, and is enforced by [diskShortfallMessage] when a download is requested.
     */
    fun availability(sdkInt: Int, deviceMemoryBytes: Long, smallestModelMinMemoryBytes: Long): Availability {
        if (sdkInt < MIN_SDK_INT) {
            return Availability(false, "Requires Android 8.0 (API 26) or newer.")
        }
        if (deviceMemoryBytes < smallestModelMinMemoryBytes) {
            return Availability(
                false,
                "This device has ${formatBytes(deviceMemoryBytes)} of RAM; the smallest on-device model needs " +
                    "at least ${formatBytes(smallestModelMinMemoryBytes)}.",
            )
        }
        return Availability(true, null)
    }

    /**
     * The RAM figure to compare against a model's `minDeviceMemoryBytes`: the *advertised* amount.
     *
     * `ActivityManager.MemoryInfo.totalMem` is what the kernel exposes after firmware and carve-out
     * reservations, which is 5-15% under the number on the box — a phone sold as 8 GB reports about
     * 7.3 GiB. Compared raw against an "8 GiB" floor it would refuse every 8 GB phone (12 GB and 6 GB
     * likewise). Google AI Edge Gallery, where the floors come from, hits the same problem and reads
     * `advertisedMem` on API 34+; where that does not exist, [totalMemBytes] is rounded up to the next
     * whole GiB, which recovers the nominal 4/6/8/12/16 GB sizes RAM is actually sold in.
     *
     * @param advertisedMemBytes `MemoryInfo.advertisedMem` on API 34+, otherwise null.
     */
    fun advertisedMemoryBytes(totalMemBytes: Long, advertisedMemBytes: Long?): Long {
        if (advertisedMemBytes != null && advertisedMemBytes >= totalMemBytes && advertisedMemBytes > 0) {
            return advertisedMemBytes
        }
        if (totalMemBytes <= 0) return 0
        return ((totalMemBytes + GIB - 1) / GIB) * GIB
    }

    /** Null when the device has enough RAM for [info]; otherwise the sentence to reject with. */
    fun ramShortfallMessage(info: LocalLlmModelInfo, deviceMemoryBytes: Long): String? =
        if (deviceMemoryBytes >= info.minDeviceMemoryBytes) {
            null
        } else {
            "This device has ${formatBytes(deviceMemoryBytes)} of RAM; ${info.modelId} needs at least " +
                "${formatBytes(info.minDeviceMemoryBytes)}."
        }

    /**
     * Bytes of a `.part` file a download can actually resume from. A `.part` that is already as long
     * as the finished file (or longer) is not a resume point — it is what a failed final size check
     * leaves behind, and asking the server for `Range: bytes=<size>-` answers 416 forever — so the
     * worker discards it and starts over, and it counts as zero here.
     */
    fun resumableBytes(partLength: Long, sizeBytes: Long): Long = if (partLength in 1 until sizeBytes) partLength else 0L

    /** Free space a download of [info] needs: what is still to fetch, plus [DISK_HEADROOM_BYTES]. */
    fun requiredFreeBytes(info: LocalLlmModelInfo, partLength: Long): Long =
        (info.sizeBytes - resumableBytes(partLength, info.sizeBytes)) + DISK_HEADROOM_BYTES

    /** Null when there is room to download [info]; otherwise the sentence to reject with. */
    fun diskShortfallMessage(info: LocalLlmModelInfo, partLength: Long, freeBytes: Long): String? {
        val required = requiredFreeBytes(info, partLength)
        if (freeBytes >= required) return null
        return "Not enough free storage to download ${info.modelId}: it needs ${formatBytes(required)} free " +
            "(${formatBytes(info.sizeBytes - resumableBytes(partLength, info.sizeBytes))} to download plus " +
            "${formatBytes(DISK_HEADROOM_BYTES)} to spare) but only ${formatBytes(freeBytes)} is available."
    }

    /** The download host. The one place a model file is ever fetched from. */
    const val DOWNLOAD_HOST = "huggingface.co"

    /** The path of [info]'s one allowed download: `/<hfRepo>/resolve/<commitHash>/<fileName>`. */
    fun downloadPathFor(info: LocalLlmModelInfo): String = "/${info.hfRepo}/resolve/${info.commitHash}/${info.fileName}"

    /**
     * The url [info] is downloaded from — built here from the catalog, never taken from the caller. The
     * `?download=true` matches what the JS catalog carries, so the two are identical strings.
     */
    fun downloadUrlFor(info: LocalLlmModelInfo): String = "https://$DOWNLOAD_HOST${downloadPathFor(info)}?download=true"

    /**
     * Null when [url] is this model's own pinned download link on Hugging Face; otherwise why not.
     *
     * The url arrives from the WebView, so it is untrusted input to something that writes multi-GB
     * files into app storage. Three independent layers:
     *  - the worker is **never handed this url** — it gets [downloadUrlFor]. What is checked here is
     *    only that the caller and the native catalog agree, so a JS/native drift fails loudly at the
     *    call instead of downloading something the caller did not mean.
     *  - the **host** must be `huggingface.co` or a subdomain, over `https` on the default port, with no
     *    credentials. A `resolve` link *redirects* to a CDN (`cdn-lfs*.hf.co`); that is a redirect target
     *    followed by the connection, not a url anyone may pass in, so it is not on the list.
     *  - the **path must equal** `/<hfRepo>/resolve/<commitHash>/<fileName>` for *this* model — the whole
     *    path, not a suffix (a suffix match accepted `/attacker/repo/resolve/main/resolve/<commit>/<file>`,
     *    leaving byte size as the only integrity check). The query string is ignored. A stale bundle still
     *    asking for `resolve/main` (whose size drifts, see [LocalLlmModels.QWEN3_0_6B_INT4]) is refused.
     */
    fun downloadUrlProblem(info: LocalLlmModelInfo, url: String): String? {
        val uri =
            try {
                URI(url.trim())
            } catch (e: URISyntaxException) {
                return "The download url is not a valid url."
            }

        if (uri.scheme?.lowercase(Locale.ROOT) != "https") {
            return "The download url must use https."
        }
        if (uri.rawUserInfo != null) {
            return "The download url must not carry credentials."
        }
        val host = uri.host?.lowercase(Locale.ROOT)
        if (host == null || !isAllowedDownloadHost(host)) {
            return "Refusing to download from ${host ?: "an unknown host"}: on-device models are only fetched from huggingface.co."
        }
        if (uri.port != -1 && uri.port != 443) {
            return "The download url must use the default https port."
        }
        val expectedPath = downloadPathFor(info)
        if (uri.rawPath != expectedPath) {
            return "The download url for ${info.modelId} must be pinned to its commit — $expectedPath — " +
                "not a moving ref such as resolve/main or another repository's file."
        }
        return null
    }

    /** `huggingface.co` itself or any subdomain of it — and not a look-alike such as `evilhuggingface.co`. */
    fun isAllowedDownloadHost(host: String): Boolean {
        val h = host.lowercase(Locale.ROOT).trimEnd('.')
        return h == "huggingface.co" || h.endsWith(".huggingface.co")
    }

    /** The backend to load on, and whether the caller's preference had to be overridden. */
    data class AcceleratorChoice(val accelerator: LocalLlmAccelerator, val preferenceUnsupported: Boolean)

    /**
     * `requested` is a preference: an absent one takes the model's first listed accelerator, and one
     * the model does not list (a `gpu` request for a CPU-only model) is replaced by that same default
     * rather than rejected — `LoadModelResult` reports what was actually used.
     */
    fun resolveAccelerator(info: LocalLlmModelInfo, requested: LocalLlmAccelerator?): AcceleratorChoice {
        if (requested == null) return AcceleratorChoice(info.defaultAccelerator, preferenceUnsupported = false)
        if (info.supportsAccelerator(requested)) return AcceleratorChoice(requested, preferenceUnsupported = false)
        return AcceleratorChoice(info.defaultAccelerator, preferenceUnsupported = true)
    }

    /** "512 MB", "3.4 GB", "4 GB" — for the sentences above; binary units under the familiar names. */
    fun formatBytes(bytes: Long): String {
        if (bytes < GIB) {
            return "${(bytes + MIB - 1) / MIB} MB"
        }
        val gib = bytes.toDouble() / GIB
        val tenths = Math.round(gib * 10) / 10.0
        return if (tenths == Math.floor(tenths)) "${tenths.toLong()} GB" else String.format(Locale.US, "%.1f GB", tenths)
    }
}
