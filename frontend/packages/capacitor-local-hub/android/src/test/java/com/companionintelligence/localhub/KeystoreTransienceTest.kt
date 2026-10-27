package com.companionintelligence.localhub

import java.security.GeneralSecurityException
import javax.crypto.AEADBadTagException
import javax.crypto.IllegalBlockSizeException
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pure-JVM tests for [KeystoreTransience]: the exception shapes come from a device log
 * (2026-10-27, keystore2 pruning the outbox key's decrypt at a cold start), rebuilt here with
 * plain exceptions because `android.security.KeyStoreException` cannot be constructed off a
 * device. Not under Robolectric for the same reason as [OutboxDatabaseKeyTest].
 */
class KeystoreTransienceTest {

    /** The chain the cipher layer produced on the phone: IllegalBlockSizeException ← KeyStoreException. */
    private fun prunedOperation(): Exception =
        IllegalBlockSizeException().apply {
            initCause(
                RuntimeException(
                    "Invalid operation handle (internal Keystore code: -28 message: " +
                        "system/security/keystore2/src/operation.rs:905: KeystoreOperation::finish\n" +
                        "Caused by:\n    0: In finish\n" +
                        "    1: system/security/keystore2/src/operation.rs:350: Call on finalized operation with outcome: Pruned.\n" +
                        "    2: Error::Km(r#INVALID_OPERATION_HANDLE)) (public error code: 15 internal Keystore code: -28)",
                ),
            )
        }

    @Test
    fun `a pruned keystore operation is transient wherever it sits in the chain`() {
        assertTrue(KeystoreTransience.isTransient(prunedOperation()))
        assertTrue(KeystoreTransience.isTransient(GeneralSecurityException("wrapped", prunedOperation())))
        assertTrue(KeystoreTransience.isTransient(RuntimeException("Operation cancelled (internal Keystore code: -26)")))
    }

    @Test
    fun `a bad tag is never transient, whatever else the chain says`() {
        assertFalse(KeystoreTransience.isTransient(AEADBadTagException("tag mismatch")))
        assertFalse(
            KeystoreTransience.isTransient(
                AEADBadTagException("tag mismatch").apply { initCause(prunedOperation()) },
            ),
        )
    }

    @Test
    fun `an ordinary failure is not transient`() {
        assertFalse(KeystoreTransience.isTransient(IllegalBlockSizeException()))
        assertFalse(KeystoreTransience.isTransient(GeneralSecurityException("Keystore alias holds the wrong entry")))
        assertFalse(KeystoreTransience.isTransient(RuntimeException(null as String?)))
    }

    @Test
    fun `a cyclic cause chain terminates`() {
        val a = RuntimeException("a")
        val b = RuntimeException("b", a)
        a.initCause(b)

        assertFalse(KeystoreTransience.isTransient(a))
    }

    @Test
    fun `retrying runs the block again after a transient failure, with the backoff, and returns its value`() {
        val slept = mutableListOf<Long>()
        var calls = 0

        val value = KeystoreTransience.retrying(sleep = { slept += it }) {
            calls += 1
            if (calls <= 2) throw prunedOperation()
            "decrypted"
        }

        assertEquals("decrypted", value)
        assertEquals(3, calls)
        assertEquals(KeystoreTransience.BACKOFF_MS.toList(), slept)
    }

    @Test
    fun `retrying gives up after the last backoff and throws that failure`() {
        val slept = mutableListOf<Long>()
        var calls = 0
        val failures = mutableListOf<Exception>()

        val thrown: Exception? = try {
            KeystoreTransience.retrying<String>(sleep = { slept += it }) {
                calls += 1
                throw prunedOperation().also { failures += it }
            }
            null
        } catch (e: IllegalBlockSizeException) {
            e
        }

        assertEquals(KeystoreTransience.BACKOFF_MS.size + 1, calls)
        assertEquals(KeystoreTransience.BACKOFF_MS.toList(), slept)
        assertSame(failures.last(), thrown)
    }

    @Test
    fun `retrying does not retry a failure that is not transient`() {
        val slept = mutableListOf<Long>()
        var calls = 0

        val thrown: Exception? = try {
            KeystoreTransience.retrying<String>(sleep = { slept += it }) {
                calls += 1
                throw AEADBadTagException("tag mismatch")
            }
            null
        } catch (e: AEADBadTagException) {
            e
        }

        assertEquals(1, calls)
        assertTrue(slept.isEmpty())
        assertEquals("tag mismatch", thrown?.message)
    }
}
