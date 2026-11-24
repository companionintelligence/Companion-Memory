package com.companionintelligence.localhub

import android.os.Build
import javax.crypto.AEADBadTagException

/**
 * Tells a keystore hiccup apart from a key that really changed, and retries the former.
 *
 * AndroidKeyStore runs each AES-GCM call as a *keystore operation* with a handle, and
 * keystore2 keeps only a few of them open at a time: under load it prunes the oldest, and the
 * next `doFinal` on a pruned handle fails with keymint `INVALID_OPERATION_HANDLE` ("Call on
 * finalized operation with outcome: Pruned"). The Java cipher layer surfaces that as an
 * `IllegalBlockSizeException` wrapping an `android.security.KeyStoreException` -- the same
 * exception family as a genuine bad tag, which is what [CompanionSecureStore] used to treat
 * every failure as. Seen on a Samsung S23 Ultra at a cold start on 2026-10-27: the app's own
 * launch-time keystore traffic was enough to prune the outbox key's decrypt, so the plugin
 * reported the outbox key lost and its queued captures unrecoverable; the next call decrypted
 * the same blob fine and drained 31 position fixes.
 *
 * A failure is transient when the cause chain carries a `KeyStoreException` the OS itself
 * marks retryable (API 33+), or one of the keymint messages that mean the *operation* failed
 * rather than the *key*. An [AEADBadTagException] anywhere in the chain means the key does not
 * match the ciphertext and is never retried: that is the one case where "the value is gone" is
 * true, and retrying it would only delay saying so.
 */
internal object KeystoreTransience {
    /** Pauses between attempts; `size + 1` attempts in all. Short: the pruning is over in milliseconds. */
    val BACKOFF_MS: LongArray = longArrayOf(50L, 200L)

    /**
     * keymint error names as `KeyStoreException` spells them in its message, for the OS
     * versions without `isTransientFailure()`. Lower case; matched case-insensitively.
     */
    private val TRANSIENT_MESSAGES = listOf(
        // INVALID_OPERATION_HANDLE (-28): the operation was pruned or already finished.
        "invalid operation handle",
        "outcome: pruned",
        // OPERATION_CANCELLED (-26): keystore dropped the operation (e.g. a concurrent abort).
        "operation cancelled",
    )

    fun isTransient(error: Throwable): Boolean {
        var transient = false
        val seen = HashSet<Throwable>()
        var cause: Throwable? = error

        while (cause != null && seen.add(cause)) {
            if (cause is AEADBadTagException) {
                return false
            }
            if (isRetryableKeyStoreException(cause)) {
                transient = true
            }
            val message = cause.message?.lowercase() ?: ""
            if (TRANSIENT_MESSAGES.any { message.contains(it) }) {
                transient = true
            }
            cause = cause.cause
        }

        return transient
    }

    /**
     * Runs [block], retrying it after each transient failure up to [BACKOFF_MS].size times.
     * Anything else, and the last transient failure, propagates as thrown.
     */
    fun <T> retrying(sleep: (Long) -> Unit = { Thread.sleep(it) }, block: () -> T): T {
        var attempt = 0

        while (true) {
            try {
                return block()
            } catch (e: Exception) {
                if (attempt >= BACKOFF_MS.size || !isTransient(e)) {
                    throw e
                }
                sleep(BACKOFF_MS[attempt])
                attempt += 1
            }
        }
    }

    /** Isolated so the API 33 members are only resolved where they exist. */
    private fun isRetryableKeyStoreException(error: Throwable): Boolean {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            return false
        }
        if (error !is android.security.KeyStoreException) {
            return false
        }

        return error.isTransientFailure ||
            error.retryPolicy == android.security.KeyStoreException.RETRY_WITH_EXPONENTIAL_BACKOFF
    }
}
