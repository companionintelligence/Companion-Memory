package com.companionintelligence.localhub

import java.io.File
import java.io.RandomAccessFile
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * Pure-JVM tests for the plaintext-shred primitive that runs once, on the launch that imports a
 * pre-encryption outbox into the SQLCipher one.
 *
 * The instrumented suite's only assertion about this is `assertFalse(legacyFile.exists())`,
 * which says nothing about whether the plaintext captures were scrubbed *before* the inode was
 * detached -- and unlinking without overwriting is exactly the failure this code exists to
 * prevent. Since [PlaintextShredder.shred] deletes what it scrubs, the scrubbing itself is
 * asserted through [PlaintextShredder.overwrite] and the deletion through `shred`.
 */
class PlaintextShredderTest {

    @get:Rule
    val temporaryFolder: TemporaryFolder = TemporaryFolder()

    private fun fileContaining(text: String, name: String = "outbox.db"): File {
        val file = File(temporaryFolder.root, name)
        file.writeBytes(text.toByteArray(Charsets.UTF_8))
        return file
    }

    @Test
    fun overwrite_replacesTheBytesInPlace_ratherThanAppendingToThem() {
        val plaintext = "MEETING-NOTES-THE-USER-NEVER-SENT".repeat(40)
        val file = fileContaining(plaintext)
        val originalLength = file.length()

        PlaintextShredder.overwrite(file)

        // Seeking to the end instead of 0 would leave every plaintext byte intact and merely
        // double the file, which then gets unlinked with the captures still readable off flash.
        assertEquals(originalLength, file.length())
        assertFalse(
            "plaintext survived the overwrite",
            file.readBytes().toString(Charsets.ISO_8859_1).contains("MEETING-NOTES"),
        )
    }

    @Test
    fun overwrite_scrubsPastTheEndOfItsBuffer() {
        // 64 KiB is the write buffer; a single non-looping write would leave everything past it
        // untouched, and a database is essentially always larger than one buffer.
        val block = "PAYLOAD-TAIL-MARKER-".repeat(1024)
        val file = fileContaining(block.repeat(12))
        val originalLength = file.length()
        assertTrue("the fixture must exceed one 64 KiB buffer", originalLength > 64 * 1024)

        PlaintextShredder.overwrite(file)

        assertEquals(originalLength, file.length())
        val scrubbed = file.readBytes().toString(Charsets.ISO_8859_1)
        assertFalse("bytes past the buffer survived", scrubbed.contains("PAYLOAD-TAIL-MARKER"))
    }

    @Test
    fun shred_unlinksTheDatabaseAndEveryJournalWalAndShmSidecar() {
        val database = fileContaining("rows", name = "legacy.db")
        val sidecars = listOf("legacy.db-journal", "legacy.db-wal", "legacy.db-shm")
            .map { fileContaining("sidecar bytes", name = it) }

        PlaintextShredder.shred(database)

        assertFalse(database.exists())
        // A sidecar left behind is not cosmetic: a hot -wal or -journal holds committed row
        // images of the very captures the database was carrying.
        sidecars.forEach { assertFalse("${it.name} survived", it.exists()) }
    }

    /**
     * The ordering inside [PlaintextShredder.shred] — overwrite, *then* unlink — is the whole
     * point of the primitive, and it is invisible from the outside because the evidence is
     * unlinked by the time the test could look at it.
     *
     * Holding an open descriptor across the shred is what makes it observable: POSIX unlink
     * only drops the directory entry, so this handle keeps reading the same inode after
     * `delete()` and shows what was left in the blocks that were released. Reverse the two
     * lines in `shred` and the `!file.exists()` guard at the top of `overwrite` returns
     * immediately, so the row images below are still sitting there in the clear.
     */
    @Test
    fun shred_scrubsEachSidecarBeforeItUnlinksIt() {
        val database = fileContaining("rows", name = "hot.db")
        // A hot -wal is the worst of the three to leave readable: it holds committed row
        // images of the captures the database itself was carrying.
        val wal = fileContaining("WAL-COMMITTED-ROW-IMAGE-".repeat(64), name = "hot.db-wal")

        RandomAccessFile(wal, "r").use { stillOpen ->
            PlaintextShredder.shred(database)

            assertFalse("the -wal sidecar must still be unlinked", wal.exists())

            val bytes = ByteArray(stillOpen.length().toInt())
            stillOpen.seek(0)
            stillOpen.readFully(bytes)
            assertFalse(
                "plaintext survived into the freed inode -- the sidecar was unlinked without being scrubbed",
                bytes.toString(Charsets.ISO_8859_1).contains("WAL-COMMITTED-ROW-IMAGE"),
            )
        }
    }

    @Test
    fun overwrite_leavesAMissingOrEmptyFileExactlyAsItFoundIt() {
        val missing = File(temporaryFolder.root, "not-there.db")
        val empty = temporaryFolder.newFile("empty.db")

        PlaintextShredder.overwrite(missing)
        PlaintextShredder.overwrite(empty)

        assertFalse("a missing file must not be conjured into existence", missing.exists())
        assertTrue(empty.exists())
        assertEquals(0L, empty.length())
    }
}
