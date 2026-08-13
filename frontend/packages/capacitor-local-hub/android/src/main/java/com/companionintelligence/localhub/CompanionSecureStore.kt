package com.companionintelligence.localhub

import android.content.Context
import android.content.SharedPreferences
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.GeneralSecurityException
import java.security.KeyStore
import java.security.ProviderException
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * The keystore itself could not be used: it is missing, locked out, backed by a broken
 * provider, or the alias holds an entry of the wrong type.
 *
 * **Nothing was written when this is thrown.** That is the entire point of this type --
 * see [CompanionSecureStore]'s class docs for the defect it exists to avoid reproducing.
 */
class SecureStoreUnavailableException(message: String, cause: Throwable? = null) :
    RuntimeException(message, cause)

/**
 * A stored ciphertext exists but could not be decrypted with the current keystore key --
 * the key was replaced or destroyed, or the blob was truncated/corrupted.
 *
 * Distinct from [SecureStoreUnavailableException] because the recovery differs: the value
 * is gone for good and the caller must treat it as absent (for the API key that means
 * re-authentication; for the outbox DEK it means the database is unopenable, which is
 * handled explicitly in [OutboxDatabaseKey]).
 */
class SecureStoreDecryptionException(message: String, cause: Throwable? = null) :
    RuntimeException(message, cause)

/**
 * AndroidKeyStore-backed value store for the few secrets this app must keep on the device:
 * the long-lived appliance API key, and the raw key the SQLCipher outbox is encrypted with.
 *
 * ### Why this exists rather than `capacitor-secure-storage-plugin`
 *
 * That plugin -- which holds the appliance API key today -- tries an AndroidKeyStore RSA
 * wrapping path and, **if Keystore initialisation throws for any reason, silently falls back
 * to plain Base64 in the same `MODE_PRIVATE` SharedPreferences file**, logging one `Log.e`
 * and reporting success to the caller. On a device with a damaged or locked-out keystore the
 * credential degrades to reversible Base64 on disk while the app says everything is fine.
 * That is precisely the threat encryption-at-rest exists for, so this store **fails closed**:
 * every path that cannot encrypt throws [SecureStoreUnavailableException] and writes nothing.
 * There is deliberately no plaintext or Base64 fallback anywhere in this file.
 *
 * ### Shape
 *
 * - One AES-256-GCM key per *namespace*, held in `AndroidKeyStore` under [keyAlias]; the key
 *   material never leaves the TEE/StrongBox.
 * - Values are stored as `version || ivLen || iv || ciphertext`, Base64 (`NO_WRAP`), in an
 *   app-private SharedPreferences file. `android:allowBackup="false"` on the app keeps that
 *   file out of adb/cloud backup, and the ciphertext would be useless off-device anyway
 *   because the wrapping key is non-exportable.
 * - Namespaces are separate on purpose: destroying the outbox namespace's keystore entry
 *   ([destroyKey]) crypto-shreds the encrypted database without touching the credential, and
 *   vice versa. That separation is what makes a future "erase this device" a single atomic
 *   operation per data class rather than a best-effort file delete.
 *
 * ### Deliberate deviation: `setUnlockedDeviceRequired` is NOT set
 *
 * `SECURITY_ARCHITECTURE.md` §2.4/§3.1 lists `setUnlockedDeviceRequired(true)` on API 28+.
 * It is not applied here, and the reason is the same document's §3.1: on iOS it chooses
 * `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly` and spends a paragraph rejecting
 * `…WhenUnlocked` because "the sidecar must be able to write while the screen is locked --
 * a background location update, a background flush … and the failure mode is invisible:
 * captures silently stop queueing whenever the phone is in a pocket."
 * `setUnlockedDeviceRequired(true)` is the Android twin of `…WhenUnlocked`, not of
 * `…AfterFirstUnlock`: it makes the key unusable while the screen is locked, so setting it
 * would break exactly the background ingest §4.4 decides must keep running, and would make
 * the two platforms inconsistent in the direction §3.1 argues against. AndroidKeyStore keys
 * are already unavailable before the first post-boot unlock on a credential-protected
 * device, which is the `AfterFirstUnlock` equivalent and is what we want.
 *
 * The flag is a constructor parameter rather than a constant so the decision is one edit and
 * one test away if a future slice removes the background-write requirement.
 *
 * ### Threading
 *
 * SharedPreferences is thread-safe and `Cipher` instances are created per call, so instances
 * of this class are safe to share. Writes use `commit()`, not `apply()`: a caller that got a
 * successful return has to be able to assume the value is on disk, because the next thing
 * that happens is usually an HTTP response or a resolved JS promise saying so.
 */
class CompanionSecureStore(
    context: Context,
    private val keyAlias: String,
    preferencesName: String,
    /** See the class docs -- deliberately false; flipping it breaks background ingest. */
    private val requireUnlockedDevice: Boolean = false,
) {
    private val preferences: SharedPreferences =
        context.applicationContext.getSharedPreferences(preferencesName, Context.MODE_PRIVATE)

    /** Present without decrypting -- cheap enough to answer "is there a credential at all?". */
    fun contains(key: String): Boolean = preferences.contains(key)

    /**
     * Decrypted value, or `null` when nothing is stored under [key].
     *
     * Throws [SecureStoreUnavailableException] if the keystore cannot be used at all and
     * [SecureStoreDecryptionException] if a blob exists but no longer decrypts. Neither is
     * ever converted into "no value" here -- callers that want that leniency (the JS
     * `secureStorageGet`, which treats any failure as "signed out") opt into it themselves.
     */
    fun get(key: String): String? {
        // Deliberately checked before touching the keystore: a read miss must not have the
        // side effect of generating a key that nothing will ever use.
        val stored = preferences.getString(key, null) ?: return null
        val secretKey = loadOrCreateKey()

        val decoded = try {
            Base64.decode(stored, Base64.NO_WRAP)
        } catch (e: IllegalArgumentException) {
            throw SecureStoreDecryptionException("Stored value for '$key' is not valid Base64", e)
        }
        if (decoded.size < MIN_BLOB_SIZE || decoded[0] != FORMAT_VERSION) {
            throw SecureStoreDecryptionException("Stored value for '$key' is truncated or has an unknown format")
        }

        val ivLength = decoded[1].toInt()
        if (ivLength <= 0 || decoded.size <= HEADER_SIZE + ivLength) {
            throw SecureStoreDecryptionException("Stored value for '$key' has an invalid IV length")
        }
        val iv = decoded.copyOfRange(HEADER_SIZE, HEADER_SIZE + ivLength)
        val ciphertext = decoded.copyOfRange(HEADER_SIZE + ivLength, decoded.size)

        return try {
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.DECRYPT_MODE, secretKey, GCMParameterSpec(GCM_TAG_BITS, iv))
            String(cipher.doFinal(ciphertext), Charsets.UTF_8)
        } catch (e: GeneralSecurityException) {
            // AEADBadTagException lands here too: the key changed under us, so the value is
            // unrecoverable. Say so instead of returning a plausible-looking null.
            throw SecureStoreDecryptionException("Could not decrypt '$key'; the keystore key no longer matches", e)
        }
    }

    /**
     * Encrypts and commits [value]. Throws [SecureStoreUnavailableException] rather than
     * storing anything the keystore did not protect.
     */
    fun set(key: String, value: String) {
        val secretKey = loadOrCreateKey()

        val encoded = try {
            val cipher = Cipher.getInstance(TRANSFORMATION)
            // No IV is supplied: AndroidKeyStore requires the provider to generate it for
            // AES-GCM (supplying one throws), which also removes any chance of us reusing an
            // IV under the same key -- the one mistake that would break GCM outright.
            cipher.init(Cipher.ENCRYPT_MODE, secretKey)
            val iv = cipher.iv
            val ciphertext = cipher.doFinal(value.toByteArray(Charsets.UTF_8))
            val blob = ByteArray(HEADER_SIZE + iv.size + ciphertext.size)
            blob[0] = FORMAT_VERSION
            blob[1] = iv.size.toByte()
            iv.copyInto(blob, HEADER_SIZE)
            ciphertext.copyInto(blob, HEADER_SIZE + iv.size)
            Base64.encodeToString(blob, Base64.NO_WRAP)
        } catch (e: GeneralSecurityException) {
            throw SecureStoreUnavailableException("Could not encrypt '$key'; refusing to store it unprotected", e)
        } catch (e: ProviderException) {
            throw SecureStoreUnavailableException("Could not encrypt '$key'; refusing to store it unprotected", e)
        }

        if (!preferences.edit().putString(key, encoded).commit()) {
            throw SecureStoreUnavailableException("Could not commit '$key' to secure storage")
        }
    }

    /** Removes one value. Silent no-op if it was already gone. */
    fun remove(key: String) {
        preferences.edit().remove(key).commit()
    }

    /**
     * Destroys this namespace's keystore key and every ciphertext under it -- the
     * crypto-shred primitive. After this call nothing previously written here can be
     * recovered, no matter how many copies of the SharedPreferences file exist, because the
     * only key that could decrypt them never existed outside the TEE.
     *
     * Not wired to a caller yet: it is the operation the remote-wipe slice will invoke, and
     * the outbox tests use it to prove an encrypted database really becomes unopenable.
     */
    fun destroyKey() {
        preferences.edit().clear().commit()
        try {
            keyStore().deleteEntry(keyAlias)
        } catch (e: GeneralSecurityException) {
            throw SecureStoreUnavailableException("Could not delete keystore entry '$keyAlias'", e)
        }
    }

    private fun keyStore(): KeyStore = try {
        KeyStore.getInstance(ANDROID_KEY_STORE).apply { load(null) }
    } catch (e: GeneralSecurityException) {
        throw SecureStoreUnavailableException("AndroidKeyStore is unavailable", e)
    } catch (e: java.io.IOException) {
        throw SecureStoreUnavailableException("AndroidKeyStore could not be loaded", e)
    }

    private fun loadOrCreateKey(): SecretKey {
        val store = keyStore()

        val existing = try {
            store.getEntry(keyAlias, null)
        } catch (e: GeneralSecurityException) {
            // UnrecoverableKeyException lands here: the entry exists but is unusable. Fail
            // closed -- silently replacing it would destroy whatever it already protects.
            throw SecureStoreUnavailableException("Keystore entry '$keyAlias' exists but cannot be loaded", e)
        }

        if (existing != null) {
            val secretEntry = existing as? KeyStore.SecretKeyEntry
                ?: throw SecureStoreUnavailableException(
                    "Keystore alias '$keyAlias' holds a ${existing.javaClass.simpleName}, not an AES key",
                )
            return secretEntry.secretKey
        }

        return generateKey()
    }

    private fun generateKey(): SecretKey {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            // StrongBox is absent on most devices and on every emulator, and asking for it
            // unconditionally is how this kind of code bricks an app on real hardware. Try it,
            // and fall through to the TEE-backed key when the provider says no.
            generateStrongBoxKeyOrNull()?.let { return it }
        }
        return generateKey(strongBox = false)
    }

    /**
     * Isolated in its own method so the `StrongBoxUnavailableException` reference is only ever
     * resolved on API 28+, where the class exists.
     */
    private fun generateStrongBoxKeyOrNull(): SecretKey? = try {
        generateKey(strongBox = true)
    } catch (e: android.security.keystore.StrongBoxUnavailableException) {
        null
    } catch (e: ProviderException) {
        // Some devices advertise StrongBox and then fail inside the provider at generation
        // time with a plain ProviderException rather than the documented subclass.
        null
    }

    private fun generateKey(strongBox: Boolean): SecretKey {
        try {
            val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEY_STORE)
            val spec = KeyGenParameterSpec.Builder(
                keyAlias,
                KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
            )
                .setKeySize(AES_KEY_BITS)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                // Explicit, not incidental: see the class docs. A key that needs a recent user
                // authentication cannot be used by a background flush on a locked phone.
                .setUserAuthenticationRequired(false)
                .apply {
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                        setUnlockedDeviceRequired(requireUnlockedDevice)
                        if (strongBox) {
                            setIsStrongBoxBacked(true)
                        }
                    }
                }
                .build()
            generator.init(spec)
            return generator.generateKey()
        } catch (e: GeneralSecurityException) {
            throw SecureStoreUnavailableException("Could not create a keystore key for '$keyAlias'", e)
        }
    }

    companion object {
        private const val ANDROID_KEY_STORE = "AndroidKeyStore"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
        private const val AES_KEY_BITS = 256
        private const val GCM_TAG_BITS = 128

        /** `version || ivLen` prefix in front of `iv || ciphertext`. */
        private const val HEADER_SIZE = 2
        private const val FORMAT_VERSION: Byte = 1

        /** header + a 12-byte GCM IV + a 16-byte tag; anything shorter cannot be a real blob. */
        private const val MIN_BLOB_SIZE = HEADER_SIZE + 12 + 16

        /**
         * Namespace holding the appliance credential (`ci.apiKey`, `ci.apiKeyId`,
         * `ci.apiBaseUrl`), reached from JS through the plugin's `secureGet`/`secureSet`/
         * `secureRemove` methods.
         */
        const val CREDENTIALS_KEY_ALIAS = "com.companionintelligence.localhub.credentials_v1"
        const val CREDENTIALS_PREFERENCES = "ci_local_hub_credentials"

        /**
         * Namespace holding the outbox database key, separate from the credential namespace so
         * the two can be destroyed independently (§5.5's `revoke` vs `wipe`).
         */
        const val OUTBOX_KEY_ALIAS = "com.companionintelligence.localhub.outbox_dek_v1"
        const val OUTBOX_PREFERENCES = "ci_local_hub_outbox_keys"

        /** Store for values the JS layer puts behind `secureStorage*`. */
        fun credentials(context: Context): CompanionSecureStore =
            CompanionSecureStore(context, CREDENTIALS_KEY_ALIAS, CREDENTIALS_PREFERENCES)

        /** Store for the SQLCipher raw key; see [OutboxDatabaseKey]. */
        fun outboxKeys(context: Context): CompanionSecureStore =
            CompanionSecureStore(context, OUTBOX_KEY_ALIAS, OUTBOX_PREFERENCES)
    }
}
