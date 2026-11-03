package com.companionintelligence.localhub.upload

/**
 * `outboxOwnerStamp()` from `@ci/common`'s `outbox.ts`, ported: the appliance origin plus a
 * fingerprint of the API key, which is what every queued row is stamped with at enqueue.
 *
 * The background uploader sends a row only when its stamp equals this value for the key and
 * origin it is about to send with -- the same rule the web flusher applies -- so a fix queued
 * under one account never goes out under another account's key after a sign-out or re-pair.
 * The two implementations must agree bit for bit; `OutboxOwnerStampTest` pins fixtures that
 * were computed by the TypeScript function.
 */
object OutboxOwnerStamp {
    fun of(origin: String, apiKey: String): String =
        "${origin.ifEmpty { "same-origin" }} ${fingerprint("$origin\n$apiKey")}"

    /**
     * cyrb53 over UTF-16 code units, as JavaScript's `charCodeAt` sees the string. Kotlin's
     * `Int` multiply wraps exactly like `Math.imul`, and `ushr` is `>>>`.
     */
    internal fun fingerprint(value: String): String {
        var h1 = 0xdeadbeef.toInt()
        var h2 = 0x41c6ce57
        for (unit in value) {
            val code = unit.code
            h1 = (h1 xor code) * 2654435761L.toInt()
            h2 = (h2 xor code) * 1597334677
        }
        h1 = (h1 xor (h1 ushr 16)) * 2246822507L.toInt()
        h1 = h1 xor ((h2 xor (h2 ushr 13)) * 3266489909L.toInt())
        h2 = (h2 xor (h2 ushr 16)) * 2246822507L.toInt()
        h2 = h2 xor ((h1 xor (h1 ushr 13)) * 3266489909L.toInt())
        val combined = ((h2 and 0x1fffff).toLong() shl 32) + (h1.toLong() and 0xffffffffL)
        return combined.toString(16).padStart(14, '0')
    }
}
