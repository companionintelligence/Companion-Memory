package com.companionintelligence.localhub

import java.io.File
import java.security.SecureRandom

/**
 * The database key is gone but the encrypted database is still on disk, so its contents --
 * captures that have never reached any server -- are unrecoverable.
 *
 * Thrown rather than swallowed, and rather than silently minting a replacement key: a fresh
 * key would make the existing file fail to open with SQLCipher's generic "file is not a
 * database", which reads like corruption and hides the fact that user data was lost. Deleting
 * the file automatically is deliberately **not** done here -- that is a product decision that
 * owes the user a warning naming how many captures are about to go, per
 * `SECURITY_ARCHITECTURE.md` §3.4, and there is no UI for that yet.
 */
class OutboxKeyLostException(message: String, cause: Throwable? = null) : RuntimeException(message, cause)

/**
 * Supplies the raw 32-byte key the outbox database is encrypted with, wrapped at rest by the
 * AndroidKeyStore key in [CompanionSecureStore].
 *
 * **Raw key, not a passphrase.** The key is handed to SQLCipher as `x'<64 hex chars>'`, the
 * documented raw-key form, so SQLCipher skips PBKDF2 entirely. PBKDF2 exists to stretch a
 * low-entropy human secret; there is no passphrase anywhere in this design (native auth is an
 * API key, not something the user types at launch), so stretching 256 bits of `SecureRandom`
 * output would buy nothing and would cost real milliseconds on every cold start -- on the
 * critical path of `LocalHubPlugin.start()`, which opens the database eagerly on purpose.
 *
 * The hex string reaches SQLCipher through `SQLiteOpenHelper`'s `String password` constructor,
 * which UTF-8 encodes it and passes the bytes to `sqlite3_key()`; SQLCipher's raw-key detection
 * runs on those bytes, so the `PRAGMA key` and `sqlite3_key()` paths are equivalent here.
 */
class OutboxDatabaseKey(
    private val store: CompanionSecureStore,
    private val entryName: String = DEFAULT_ENTRY_NAME,
) {
    /**
     * The `x'…'` key spec for [databaseFile], generating and persisting a fresh key the first
     * time. [databaseFile] is consulted only to tell "first run" apart from "the key vanished
     * out from under an existing database", which are the same code path but very different
     * events.
     */
    fun rawKeySpec(databaseFile: File): String {
        val stored = try {
            store.get(entryName)
        } catch (e: SecureStoreDecryptionException) {
            if (databaseHasContent(databaseFile)) {
                throw OutboxKeyLostException(
                    "The outbox database key can no longer be decrypted, and " +
                        "${databaseFile.name} (${databaseFile.length()} bytes) was encrypted with it. " +
                        "Those queued captures are unrecoverable.",
                    e,
                )
            }
            // No database to strand -- drop the unusable blob and start clean.
            store.remove(entryName)
            null
        }

        if (stored != null) {
            return keySpec(stored)
        }

        if (databaseHasContent(databaseFile)) {
            throw OutboxKeyLostException(
                "No outbox database key is stored, but ${databaseFile.name} " +
                    "(${databaseFile.length()} bytes) exists and can only be read with it. " +
                    "Those queued captures are unrecoverable.",
            )
        }

        val bytes = ByteArray(KEY_BYTES)
        SecureRandom().nextBytes(bytes)
        val hex = bytes.toHex()
        store.set(entryName, hex)

        // Read back before anything is encrypted with it. A write that reported success but did
        // not survive would leave the next launch generating a *different* key against a
        // database it can no longer open -- the exact failure OutboxKeyLostException reports,
        // arriving one launch too late to be diagnosable.
        val persisted = store.get(entryName)
        if (persisted != hex) {
            throw OutboxKeyLostException("The new outbox database key did not persist; refusing to encrypt with it")
        }

        return keySpec(hex)
    }

    private fun databaseHasContent(databaseFile: File): Boolean = databaseFile.exists() && databaseFile.length() > 0

    private fun keySpec(hex: String): String = "x'$hex'"

    private fun ByteArray.toHex(): String = buildString(size * 2) {
        for (byte in this@toHex) {
            append(HEX_DIGITS[(byte.toInt() shr 4) and 0x0F])
            append(HEX_DIGITS[byte.toInt() and 0x0F])
        }
    }

    companion object {
        const val DEFAULT_ENTRY_NAME = "outbox.dek.v1"

        /** 256 bits, matching SQLCipher 4's AES-256 default. */
        private const val KEY_BYTES = 32

        private const val HEX_DIGITS = "0123456789abcdef"
    }
}
