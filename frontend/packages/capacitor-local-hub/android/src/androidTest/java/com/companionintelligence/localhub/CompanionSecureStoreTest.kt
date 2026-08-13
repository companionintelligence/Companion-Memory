package com.companionintelligence.localhub

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import java.io.File
import java.security.KeyPairGenerator
import java.security.KeyStore
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith

/**
 * On-device verification of [CompanionSecureStore] -- the replacement for
 * `capacitor-secure-storage-plugin` as the home of the long-lived appliance API key.
 *
 * These tests run against the **real** AndroidKeyStore on a real device/emulator, which is the
 * only place the behaviour that matters can be observed: whether a key can actually be
 * generated (StrongBox is absent on every emulator, so the fallback path in
 * `generateKey` is exercised for real here, not mocked), and -- the load-bearing one --
 * whether a keystore that cannot be used causes a **refusal** rather than a quiet downgrade to
 * reversible storage.
 *
 * Every test uses its own keystore alias and its own SharedPreferences file, deleted in
 * [tearDown], so nothing here can disturb the app's real credential or the outbox database key.
 */
@RunWith(AndroidJUnit4::class)
class CompanionSecureStoreTest {
    private val context: Context
        get() = InstrumentationRegistry.getInstrumentation().targetContext

    private val usedAliases = mutableListOf<String>()
    private val usedPreferences = mutableListOf<String>()

    @Before
    fun setUp() {
        clearTestState()
    }

    @After
    fun tearDown() {
        clearTestState()
        usedAliases.clear()
        usedPreferences.clear()
    }

    // ------------------------------------------------------------------ the happy path

    @Test
    fun setThenGet_roundTripsTheValue() {
        val store = newStore("roundtrip")

        store.set(API_KEY, SECRET)

        assertEquals(SECRET, store.get(API_KEY))
        assertTrue(store.contains(API_KEY))
    }

    @Test
    fun get_forAnUnknownKey_returnsNullWithoutCreatingAKey() {
        val alias = alias("absent")
        val store = newStore("absent")

        assertNull(store.get(API_KEY))
        assertFalse(store.contains(API_KEY))
        // A read miss must not have the side effect of minting a keystore key nothing uses.
        assertFalse(keyStore().containsAlias(alias))
    }

    @Test
    fun set_overwritesAnEarlierValue_andRemoveClearsIt() {
        val store = newStore("overwrite")

        store.set(API_KEY, SECRET)
        store.set(API_KEY, "a-rotated-key")
        assertEquals("a-rotated-key", store.get(API_KEY))

        store.remove(API_KEY)
        assertNull(store.get(API_KEY))
        assertFalse(store.contains(API_KEY))

        // Removing something already gone is a silent no-op, not a failure.
        store.remove(API_KEY)
    }

    @Test
    fun separateNamespaces_doNotSeeEachOthersValues() {
        val credentials = newStore("ns-a")
        val outbox = newStore("ns-b")

        credentials.set(API_KEY, SECRET)

        assertNull(outbox.get(API_KEY))
        assertEquals(SECRET, credentials.get(API_KEY))
    }

    /**
     * The emulator has no StrongBox, so `setIsStrongBoxBacked(true)` fails here and the code
     * falls back to a TEE-backed key. That fallback is the whole reason StrongBox is requested
     * optionally rather than required -- a naive `setIsStrongBoxBacked(true)` with no fallback
     * bricks the app on every device without the hardware, which is most of them.
     */
    @Test
    fun keyGeneration_succeedsOnHardwareWithoutStrongBox() {
        val alias = alias("strongbox-fallback")
        val store = newStore("strongbox-fallback")

        store.set(API_KEY, SECRET)

        assertTrue("expected an AES key to exist under $alias", keyStore().containsAlias(alias))
        val entry = keyStore().getEntry(alias, null)
        assertTrue("expected a SecretKeyEntry, got ${entry?.javaClass?.simpleName}", entry is KeyStore.SecretKeyEntry)
        assertEquals(SECRET, store.get(API_KEY))
    }

    // ------------------------------------------------------------------ it is really encrypted

    /**
     * The specific defect being fixed: `capacitor-secure-storage-plugin`'s fallback writes
     * `Base64(plaintext)` into SharedPreferences. Asserting the secret does not appear as a
     * *literal substring* of the file would not catch that -- Base64 of a secret contains no
     * literal secret either. So decode what was actually stored and assert the plaintext bytes
     * are not in there.
     */
    @Test
    fun storedBlob_isCiphertext_notBase64OfThePlaintext() {
        val preferencesName = preferences("ciphertext")
        val store = newStore("ciphertext")

        store.set(API_KEY, SECRET)

        val raw = context.getSharedPreferences(preferencesName, Context.MODE_PRIVATE).getString(API_KEY, null)
        assertNotNull("nothing was stored at all", raw)

        val decoded = Base64.decode(raw, Base64.NO_WRAP)
        assertEquals("unexpected blob format version", 1, decoded[0].toInt())
        assertFalse(
            "the stored blob decodes to something containing the plaintext secret",
            decoded.containsSubsequence(SECRET.toByteArray(Charsets.UTF_8)),
        )

        // And the on-disk XML itself carries no copy of the secret in any encoding we wrote.
        val preferencesFile = File(File(context.applicationInfo.dataDir, "shared_prefs"), "$preferencesName.xml")
        assertTrue("expected $preferencesFile to exist", preferencesFile.exists())
        assertFalse(
            "the preferences file contains the plaintext secret",
            preferencesFile.readBytes().containsSubsequence(SECRET.toByteArray(Charsets.UTF_8)),
        )
    }

    @Test
    fun twoWritesOfTheSameValue_produceDifferentCiphertext() {
        val preferencesName = preferences("iv")
        val store = newStore("iv")

        store.set(API_KEY, SECRET)
        val first = context.getSharedPreferences(preferencesName, Context.MODE_PRIVATE).getString(API_KEY, null)
        store.set(API_KEY, SECRET)
        val second = context.getSharedPreferences(preferencesName, Context.MODE_PRIVATE).getString(API_KEY, null)

        // A fresh provider-generated IV per write. Identical blobs would mean a reused IV,
        // which is the one mistake that breaks AES-GCM outright.
        assertFalse("the same value encrypted to the same bytes twice", first == second)
        assertEquals(SECRET, store.get(API_KEY))
    }

    // ------------------------------------------------------------------ fail closed

    /**
     * **The test this whole slice exists for.** With the keystore alias occupied by an entry of
     * the wrong type -- the kind of thing an alias collision or a partially-migrated install
     * produces -- the store must refuse the write and leave nothing behind.
     *
     * The behaviour being ruled out is the shipping one in `PasswordStorageHelper`: catch the
     * keystore failure, log it, write plain Base64 into the same SharedPreferences file, and
     * return success to the caller.
     */
    @Test
    fun set_whenTheKeystoreEntryIsUnusable_throwsAndWritesNothing() {
        val aliasName = alias("hostile")
        val preferencesName = preferences("hostile")
        occupyAliasWithAnRsaKey(aliasName)

        val store = CompanionSecureStore(context, aliasName, preferencesName)

        assertThrows(SecureStoreUnavailableException::class.java) { store.set(API_KEY, SECRET) }

        assertFalse("a value was stored despite the keystore being unusable", store.contains(API_KEY))
        assertNull(
            context.getSharedPreferences(preferencesName, Context.MODE_PRIVATE).getString(API_KEY, null),
        )
        assertNoTraceOfTheSecretOnDisk()
    }

    @Test
    fun get_whenTheKeystoreEntryIsUnusable_throwsRatherThanReportingNoValue() {
        val aliasName = alias("hostile-read")
        val preferencesName = preferences("hostile-read")

        // Store a value normally first, then break the key underneath it.
        val store = CompanionSecureStore(context, aliasName, preferencesName)
        store.set(API_KEY, SECRET)
        keyStore().deleteEntry(aliasName)
        occupyAliasWithAnRsaKey(aliasName)

        assertThrows(SecureStoreUnavailableException::class.java) { store.get(API_KEY) }
    }

    /**
     * A blob that survives while its key does not. Reporting "no value" here would be a
     * plausible-looking lie; the caller has to be able to tell "you were never signed in" from
     * "the thing that could read your credential is gone".
     */
    @Test
    fun get_whenTheKeyWasReplaced_reportsDecryptionFailure() {
        val aliasName = alias("rekeyed")
        val preferencesName = preferences("rekeyed")
        val store = CompanionSecureStore(context, aliasName, preferencesName)

        store.set(API_KEY, SECRET)
        // Delete only the key; the ciphertext stays in SharedPreferences. The next get()
        // generates a fresh key that cannot possibly decrypt it.
        keyStore().deleteEntry(aliasName)

        assertThrows(SecureStoreDecryptionException::class.java) { store.get(API_KEY) }
    }

    @Test
    fun get_withACorruptedBlob_reportsDecryptionFailure() {
        val preferencesName = preferences("corrupt")
        val store = newStore("corrupt")

        store.set(API_KEY, SECRET)
        context.getSharedPreferences(preferencesName, Context.MODE_PRIVATE)
            .edit()
            .putString(API_KEY, "not-base64-at-all!!!")
            .commit()

        assertThrows(SecureStoreDecryptionException::class.java) { store.get(API_KEY) }
    }

    // ------------------------------------------------------------------ crypto-shred

    /**
     * The primitive a future "erase this device" is built on: destroying one keystore entry
     * makes every ciphertext under it permanently unreadable, no matter how many copies of the
     * file exist, because the key never existed outside the TEE.
     */
    @Test
    fun destroyKey_makesPreviouslyStoredValuesUnrecoverable() {
        val aliasName = alias("shred")
        val preferencesName = preferences("shred")
        val store = CompanionSecureStore(context, aliasName, preferencesName)

        store.set(API_KEY, SECRET)
        val ciphertext = context.getSharedPreferences(preferencesName, Context.MODE_PRIVATE)
            .getString(API_KEY, null)
        assertNotNull(ciphertext)

        store.destroyKey()

        assertFalse(keyStore().containsAlias(aliasName))
        assertNull(store.get(API_KEY))

        // Even restoring the exact ciphertext from a backup does not bring it back.
        context.getSharedPreferences(preferencesName, Context.MODE_PRIVATE)
            .edit()
            .putString(API_KEY, ciphertext)
            .commit()
        assertThrows(SecureStoreDecryptionException::class.java) { store.get(API_KEY) }
    }

    // ------------------------------------------------------------------ helpers

    private fun newStore(name: String): CompanionSecureStore =
        CompanionSecureStore(context, alias(name), preferences(name))

    private fun alias(name: String): String = "com.companionintelligence.localhub.test.$name".also {
        if (!usedAliases.contains(it)) usedAliases.add(it)
    }

    private fun preferences(name: String): String = "ci_local_hub_test_$name".also {
        if (!usedPreferences.contains(it)) usedPreferences.add(it)
    }

    private fun keyStore(): KeyStore = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    /**
     * Puts a *signing* RSA keypair under [aliasName]. `getEntry` then hands back a
     * `PrivateKeyEntry`, which is exactly the "the keystore has something here and it is not an
     * AES key" condition the store has to refuse rather than work around.
     */
    private fun occupyAliasWithAnRsaKey(aliasName: String) {
        val generator = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_RSA, "AndroidKeyStore")
        generator.initialize(
            KeyGenParameterSpec.Builder(
                aliasName,
                KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY,
            )
                .setDigests(KeyProperties.DIGEST_SHA256)
                .setSignaturePaddings(KeyProperties.SIGNATURE_PADDING_RSA_PKCS1)
                .build(),
        )
        generator.generateKeyPair()
    }

    /**
     * Walks the directories any fallback could plausibly have written to and asserts the secret
     * is not sitting in any of them, in either its raw or Base64 form.
     */
    private fun assertNoTraceOfTheSecretOnDisk() {
        val secretBytes = SECRET.toByteArray(Charsets.UTF_8)
        val base64Bytes = Base64.encodeToString(secretBytes, Base64.NO_WRAP).toByteArray(Charsets.UTF_8)
        val dataDir = File(context.applicationInfo.dataDir)

        for (directory in listOf("shared_prefs", "files", "databases", "no_backup")) {
            File(dataDir, directory).walkTopDown().filter { it.isFile }.forEach { file ->
                val bytes = file.readBytes()
                assertFalse("$file contains the plaintext secret", bytes.containsSubsequence(secretBytes))
                assertFalse("$file contains a Base64 copy of the secret", bytes.containsSubsequence(base64Bytes))
            }
        }
    }

    private fun clearTestState() {
        val store = keyStore()
        usedAliases.forEach { alias ->
            if (store.containsAlias(alias)) {
                store.deleteEntry(alias)
            }
        }
        usedPreferences.forEach { name ->
            context.getSharedPreferences(name, Context.MODE_PRIVATE).edit().clear().commit()
            File(File(context.applicationInfo.dataDir, "shared_prefs"), "$name.xml").delete()
        }
    }

    private fun ByteArray.containsSubsequence(needle: ByteArray): Boolean {
        if (needle.isEmpty() || needle.size > size) {
            return false
        }
        outer@ for (start in 0..(size - needle.size)) {
            for (offset in needle.indices) {
                if (this[start + offset] != needle[offset]) continue@outer
            }
            return true
        }
        return false
    }

    private companion object {
        const val API_KEY = "ci.apiKey"

        /**
         * Deliberately distinctive so a substring scan over the app's data directory is a
         * meaningful assertion rather than a coincidence hunt.
         */
        const val SECRET = "ci-secret-value-9f3c1d7a-do-not-store-in-the-clear"
    }
}
