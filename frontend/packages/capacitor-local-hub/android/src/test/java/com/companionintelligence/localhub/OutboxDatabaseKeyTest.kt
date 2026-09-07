package com.companionintelligence.localhub

import java.io.File
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * Pure-JVM tests for the four "the key is gone -- does that mean data loss?" outcomes in
 * [OutboxDatabaseKey], plus the exact shape of the spec it hands SQLCipher.
 *
 * These branches are unreachable from the instrumented suite: a device test can only exercise
 * a keystore that works, so the paths that decide whether queued captures are declared lost --
 * or silently destroyed by minting a replacement key against a database that can no longer be
 * opened -- have never been executed anywhere. A fake [SecureValueStore] reaches all four, and
 * reaches the persist-then-read-back check, which no real AndroidKeyStore can be made to fail.
 *
 * Deliberately *not* under Robolectric: [OutboxDatabaseKey]'s only imports are `java.io.File`
 * and `java.security.SecureRandom`, so a sandboxed Android class loader would cost seconds per
 * class and buy nothing.
 */
class OutboxDatabaseKeyTest {

    @get:Rule
    val temporaryFolder: TemporaryFolder = TemporaryFolder()

    /**
     * A secret store that can be made to behave like a damaged keystore.
     *
     * [poisoned] entries throw [SecureStoreDecryptionException] on read, which is what
     * `CompanionSecureStore.get` does when a blob no longer decrypts under the current
     * AndroidKeyStore key. [swallowWrites] is the one behaviour a real keystore cannot be asked
     * for on demand: reporting a successful write that did not survive.
     */
    private class FakeSecureValueStore : SecureValueStore {
        val values = LinkedHashMap<String, String>()
        val poisoned = mutableSetOf<String>()
        val writes = mutableListOf<Pair<String, String>>()
        val removals = mutableListOf<String>()
        var swallowWrites = false

        override fun get(key: String): String? {
            if (key in poisoned) {
                throw SecureStoreDecryptionException("Could not decrypt '$key'")
            }
            return values[key]
        }

        override fun set(key: String, value: String) {
            writes += key to value
            if (!swallowWrites) {
                values[key] = value
            }
        }

        override fun remove(key: String) {
            removals += key
            poisoned -= key
            values -= key
        }
    }

    private fun missingDatabase(): File = File(temporaryFolder.root, DATABASE_FILE_NAME)

    private fun databaseOf(byteCount: Int): File {
        val file = temporaryFolder.newFile(DATABASE_FILE_NAME)
        file.writeBytes(ByteArray(byteCount) { 7 })
        return file
    }

    @Test
    fun firstRun_mintsARawKey_andHandsSqlCipherTheQuoted64HexForm() {
        val store = FakeSecureValueStore()

        val spec = OutboxDatabaseKey(store).rawKeySpec(missingDatabase())

        // 64 lowercase hex characters is precisely what makes SQLCipher treat this as a RAW
        // key and skip PBKDF2. Any other length is silently reinterpreted as a passphrase --
        // that still "works", so nothing downstream would ever report the weaker, slower
        // derivation. Hence the exact-shape assertion rather than a length check.
        assertTrue("not a raw key spec: $spec", RAW_KEY_SPEC.matches(spec))

        val (entry, stored) = store.writes.single()
        assertEquals(OutboxDatabaseKey.DEFAULT_ENTRY_NAME, entry)
        // What was persisted is the bare hex, and the spec is that same hex quoted -- not a
        // re-encoding, and not a second key.
        assertEquals("x'$stored'", spec)
    }

    @Test
    fun freshKeys_areNotAllTheSameKey() {
        val first = OutboxDatabaseKey(FakeSecureValueStore()).rawKeySpec(missingDatabase())
        val second = OutboxDatabaseKey(FakeSecureValueStore())
            .rawKeySpec(File(temporaryFolder.root, "second.db"))

        assertNotEquals(first, second)
    }

    @Test
    fun anAlreadyStoredKey_isReusedVerbatim_andNothingIsWrittenBack() {
        val store = FakeSecureValueStore()
        val existing = "a".repeat(64)
        store.values["custom.entry"] = existing

        val spec = OutboxDatabaseKey(store, entryName = "custom.entry").rawKeySpec(databaseOf(4096))

        assertEquals("x'$existing'", spec)
        assertTrue("an existing key must never be rewritten", store.writes.isEmpty())
        assertTrue(store.removals.isEmpty())
    }

    @Test
    fun aKeyThatDoesNotReadBack_isRefusedBeforeAnythingIsEncryptedWithIt() {
        val store = FakeSecureValueStore()
        // A store that reports success and keeps nothing. Without the read-back the next launch
        // mints a *different* key against a database it can no longer open -- the exact failure
        // OutboxKeyLostException exists to report, arriving one launch too late to diagnose.
        store.swallowWrites = true

        val thrown = runCatching { OutboxDatabaseKey(store).rawKeySpec(missingDatabase()) }
            .exceptionOrNull()

        assertTrue("expected OutboxKeyLostException, got $thrown", thrown is OutboxKeyLostException)
        assertTrue(thrown!!.message!!.contains("did not persist"))
        assertEquals(1, store.writes.size)
    }

    @Test
    fun anUndecryptableKey_overANonEmptyDatabase_isReportedAsLoss_andTheBlobIsKept() {
        val store = FakeSecureValueStore()
        store.values[OutboxDatabaseKey.DEFAULT_ENTRY_NAME] = "b".repeat(64)
        store.poisoned += OutboxDatabaseKey.DEFAULT_ENTRY_NAME
        val database = databaseOf(1234)

        val thrown = runCatching { OutboxDatabaseKey(store).rawKeySpec(database) }.exceptionOrNull()

        assertTrue("expected OutboxKeyLostException, got $thrown", thrown is OutboxKeyLostException)
        // This message is the only diagnostic anyone gets for a stranded queue, so it has to
        // name the file and how much of it is stranded.
        assertTrue(thrown!!.message!!.contains(DATABASE_FILE_NAME))
        assertTrue(thrown.message!!.contains("1234 bytes"))
        // Dropping the blob here would remove the last chance of ever recovering those rows,
        // and minting a replacement would relabel the loss as "file is not a database".
        assertTrue("the undecryptable key must be kept", store.removals.isEmpty())
        assertTrue("nothing may be minted over a live database", store.writes.isEmpty())
        assertTrue(database.exists())
    }

    @Test
    fun anUndecryptableKey_withNoDatabase_dropsTheUnusableBlob_andStartsClean() {
        val store = FakeSecureValueStore()
        store.values[OutboxDatabaseKey.DEFAULT_ENTRY_NAME] = "c".repeat(64)
        store.poisoned += OutboxDatabaseKey.DEFAULT_ENTRY_NAME

        val spec = OutboxDatabaseKey(store).rawKeySpec(missingDatabase())

        // Without the remove() the blob stays poisoned and every future launch throws, with no
        // UI anywhere to clear it.
        assertEquals(listOf(OutboxDatabaseKey.DEFAULT_ENTRY_NAME), store.removals)
        assertTrue(RAW_KEY_SPEC.matches(spec))
        assertEquals(1, store.writes.size)
    }

    @Test
    fun aZeroLengthDatabaseFile_isNotContent_soAFreshInstallStillGetsAKey() {
        val store = FakeSecureValueStore()
        // getDatabasePath()/SQLiteOpenHelper can leave a 0-byte file behind after a failed
        // open. Treating that as "a database encrypted with the key you lost" would brick every
        // subsequent launch of an install that has never stored anything at all.
        val emptyDatabase = temporaryFolder.newFile(DATABASE_FILE_NAME)
        assertEquals(0L, emptyDatabase.length())

        val spec = OutboxDatabaseKey(store).rawKeySpec(emptyDatabase)

        assertTrue(RAW_KEY_SPEC.matches(spec))
        assertEquals(1, store.writes.size)
    }

    @Test
    fun noStoredKey_overAnExistingDatabase_isReportedRatherThanSilentlyReplaced() {
        val store = FakeSecureValueStore()

        val thrown = runCatching { OutboxDatabaseKey(store).rawKeySpec(databaseOf(64)) }
            .exceptionOrNull()

        assertTrue("expected OutboxKeyLostException, got $thrown", thrown is OutboxKeyLostException)
        assertTrue(thrown!!.message!!.contains("64 bytes"))
        assertTrue("a replacement key must not be minted", store.writes.isEmpty())
    }

    private companion object {
        const val DATABASE_FILE_NAME = "ci_local_hub_outbox_enc.db"
        val RAW_KEY_SPEC = Regex("^x'[0-9a-f]{64}'$")
    }
}
