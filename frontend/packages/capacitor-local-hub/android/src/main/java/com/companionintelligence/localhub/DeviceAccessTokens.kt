package com.companionintelligence.localhub

import android.content.Context
import com.companionintelligence.localhub.upload.OutboxOwnerStamp
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.util.concurrent.FutureTask
import org.json.JSONObject

/**
 * The device key stays native; the web page gets short-lived access tokens for it.
 *
 * The app signs in once and keeps a durable, full-capability API key in [CompanionSecureStore].
 * The page inside the WebView used to read that key back and send it on every request, so any
 * script that ever ran in the page could carry off a credential that worked from anywhere until
 * someone revoked it. Now `secureGet` refuses the key, and the page asks `deviceAccessToken`,
 * which trades the key with Memory (`POST <origin>/api/keys/access-token`) for a token that
 * works for five minutes.
 *
 * The key only ever goes to the origin it is stored with ([DeviceCredentialBinding]): changing
 * that origin drops the key, so a script in the page cannot point the token mint, or the
 * background uploader and replica sync, at a server of its own.
 */
object DeviceCredentialKeys {
    const val API_KEY = "ci.apiKey"
    const val API_KEY_ID = "ci.apiKeyId"
    const val API_KEY_CAPABILITY = "ci.apiKeyCapability"
    const val API_BASE_URL = "ci.apiBaseUrl"

    /** What goes with the key: the three entries a sign-in writes and a sign-out removes. */
    val KEY_ENTRIES = listOf(API_KEY, API_KEY_ID, API_KEY_CAPABILITY)
}

/** An origin as the app stores it: no trailing slash, so `https://m.example/` and `https://m.example` are one origin. */
internal fun normalizedOrigin(origin: String?): String? = origin?.trim()?.trimEnd('/')?.takeIf { it.isNotEmpty() }

/**
 * Keeps the device key bound to the origin it was stored for. Applied by `secureSet` and
 * `secureRemove` before they write.
 */
object DeviceCredentialBinding {
    /**
     * Before `key` is set to `value`: a different origin, while a key is stored for another one,
     * first removes the key entries. Returns whether it did. The same origin (or a first one, for
     * a key stored before the origin was mirrored) leaves the key alone.
     *
     * A key that cannot be read (a blob that no longer decrypts) counts as stored: removing it
     * loses nothing, and keeping it could let it follow the new origin.
     */
    fun beforeSet(store: SecureValueStore, key: String, value: String): Boolean {
        if (key != DeviceCredentialKeys.API_BASE_URL) return false
        val stored = normalizedOrigin(store.get(key)) ?: return false
        if (stored == normalizedOrigin(value) || !hasKey(store)) return false
        removeKeyEntries(store)
        return true
    }

    /** Before `key` is removed: removing the origin while a key is stored removes the key entries too. */
    fun beforeRemove(store: SecureValueStore, key: String): Boolean {
        if (key != DeviceCredentialKeys.API_BASE_URL || !hasKey(store)) return false
        removeKeyEntries(store)
        return true
    }

    /**
     * Whether the stored key may be sent to [origin]: only when it is the origin stored with the
     * key. The background uploader and replica sync take their origin from configuration the
     * page hands them, so they ask this before sending the key anywhere.
     */
    fun keyMaySendTo(store: SecureValueStore, origin: String?): Boolean {
        val bound = normalizedOrigin(store.get(DeviceCredentialKeys.API_BASE_URL)) ?: return false
        return bound == normalizedOrigin(origin)
    }

    private fun hasKey(store: SecureValueStore): Boolean =
        try {
            !store.get(DeviceCredentialKeys.API_KEY).isNullOrEmpty()
        } catch (_: Exception) {
            true
        }

    private fun removeKeyEntries(store: SecureValueStore) {
        for (entry in DeviceCredentialKeys.KEY_ENTRIES) store.remove(entry)
    }
}

/**
 * The key and the origin it is bound to, for native code that calls Memory itself (the on-device
 * model's intent tools). Null when either is missing or the origin is not http(s).
 */
class StoredDeviceCredential(val baseUrl: String, val apiKey: String) {
    override fun toString(): String = "StoredDeviceCredential(baseUrl=$baseUrl, apiKey=<redacted>)"

    companion object {
        /** Reads the app's credential store. Throws when the keystore is unusable, like every read of it. */
        @JvmStatic
        fun read(context: Context): StoredDeviceCredential? = from(CompanionSecureStore.credentials(context))

        internal fun from(store: SecureValueStore): StoredDeviceCredential? {
            val apiKey = store.get(DeviceCredentialKeys.API_KEY)?.takeIf { it.isNotEmpty() } ?: return null
            val baseUrl = normalizedOrigin(store.get(DeviceCredentialKeys.API_BASE_URL)) ?: return null
            if (!isHttpOrigin(baseUrl)) return null
            return StoredDeviceCredential(baseUrl, apiKey)
        }
    }
}

internal fun isHttpOrigin(origin: String): Boolean =
    origin.startsWith("https://", ignoreCase = true) || origin.startsWith("http://", ignoreCase = true)

/** What `deviceAccessToken` resolves. [expiresAt] is ms since the epoch. */
data class DeviceAccessTokenResult(
    val status: Status,
    val token: String?,
    val expiresAt: Long?,
    val keyId: String?,
    val ownerStamp: String?,
) {
    enum class Status(val wire: String) {
        /** No key stored: signed out. */
        NONE("none"),
        OK("ok"),
        /** Memory refused the key (401/403): it was revoked. The key is left where it is. */
        REVOKED("revoked"),
        /** Memory could not be asked, or answered something unusable. Signed in, no token now. */
        UNREACHABLE("unreachable"),
        /**
         * Memory predates the route (404). No token, and never the key itself: the page would hold a
         * credential that works anywhere until revoked. The page asks the person to update Memory;
         * the native uploaders keep sending the key as before.
         */
        LEGACY("legacy"),
    }

    override fun toString(): String =
        "DeviceAccessTokenResult(status=$status, token=${if (token == null) "null" else "<redacted>"}, " +
            "expiresAt=$expiresAt, keyId=$keyId, ownerStamp=$ownerStamp)"
}

/** One exchange with Memory: the status code, or null when no usable answer came back. */
data class ExchangeResponse(val status: Int?, val body: String?)

fun interface TokenExchange {
    fun exchange(origin: String, apiKey: String): ExchangeResponse
}

/**
 * `POST <origin>/api/keys/access-token` over `HttpURLConnection`, the stack CapacitorHttp and the
 * background uploader use (same trust store, same cleartext policy). Redirects are not followed:
 * the key is only for the origin it is bound to, and a redirect would carry it somewhere else.
 */
class HttpTokenExchange(private val timeoutMs: Int = TIMEOUT_MS) : TokenExchange {
    override fun exchange(origin: String, apiKey: String): ExchangeResponse {
        val connection = try {
            URL("$origin$PATH").openConnection() as HttpURLConnection
        } catch (_: Exception) {
            return ExchangeResponse(null, null)
        }
        return try {
            connection.instanceFollowRedirects = false
            connection.requestMethod = "POST"
            connection.connectTimeout = timeoutMs
            connection.readTimeout = timeoutMs
            connection.doOutput = true
            connection.setFixedLengthStreamingMode(0)
            connection.setRequestProperty("Accept", "application/json")
            connection.setRequestProperty(API_KEY_HEADER, apiKey)
            connection.outputStream.close()
            val status = connection.responseCode
            val stream = if (status >= 400) connection.errorStream else connection.inputStream
            val body = stream?.use { input ->
                // Bounded by hand: InputStream.readNBytes is API 33, and this module runs on 24.
                val buffer = ByteArray(MAX_BODY_BYTES + 1)
                var read = 0
                while (read < buffer.size) {
                    val count = input.read(buffer, read, buffer.size - read)
                    if (count < 0) break
                    read += count
                }
                if (read > MAX_BODY_BYTES) null else String(buffer, 0, read, Charsets.UTF_8)
            }
            ExchangeResponse(status, body)
        } catch (_: IOException) {
            ExchangeResponse(null, null)
        } finally {
            connection.disconnect()
        }
    }

    private companion object {
        const val PATH = "/api/keys/access-token"
        const val TIMEOUT_MS = 10_000
        const val API_KEY_HEADER = "x-api-key"
        const val MAX_BODY_BYTES = 16 * 1024
    }
}

/**
 * Hands out access tokens for the stored key, minting one only when the last is within a minute
 * of running out. Blocking: call it off the main thread. Concurrent calls for the same key share
 * one request.
 */
class DeviceAccessTokens(
    private val store: SecureValueStore,
    private val exchange: TokenExchange = HttpTokenExchange(),
    private val clock: () -> Long = System::currentTimeMillis,
) {
    private class Cached(val credential: String, val token: String, val expiresAt: Long)

    private class InFlight(val credential: String, val task: FutureTask<DeviceAccessTokenResult>)

    private val lock = Any()
    private var cached: Cached? = null
    private var inFlight: InFlight? = null

    /** Forgets the cached token: the credential it was minted for changed or went away. */
    fun invalidate() {
        synchronized(lock) { cached = null }
    }

    fun get(refresh: Boolean): DeviceAccessTokenResult {
        val apiKey = store.get(DeviceCredentialKeys.API_KEY)?.takeIf { it.isNotEmpty() }
            ?: return DeviceAccessTokenResult(DeviceAccessTokenResult.Status.NONE, null, null, null, null)
        val keyId = store.get(DeviceCredentialKeys.API_KEY_ID)?.takeIf { it.isNotEmpty() }
        val origin = normalizedOrigin(store.get(DeviceCredentialKeys.API_BASE_URL))
            ?: return DeviceAccessTokenResult(DeviceAccessTokenResult.Status.UNREACHABLE, null, null, keyId, null)
        val ownerStamp = OutboxOwnerStamp.of(origin, apiKey)
        val unreachable = DeviceAccessTokenResult(DeviceAccessTokenResult.Status.UNREACHABLE, null, null, keyId, ownerStamp)
        if (!isHttpOrigin(origin)) return unreachable

        val credential = fingerprint(apiKey, origin)
        val task: FutureTask<DeviceAccessTokenResult>
        val runsHere: Boolean
        synchronized(lock) {
            val hit = cached
            if (!refresh && hit != null && hit.credential == credential && hit.expiresAt - REFRESH_MARGIN_MS > clock()) {
                return DeviceAccessTokenResult(DeviceAccessTokenResult.Status.OK, hit.token, hit.expiresAt, keyId, ownerStamp)
            }
            val running = inFlight
            if (running != null && running.credential == credential) {
                task = running.task
                runsHere = false
            } else {
                task = FutureTask { mint(origin, apiKey, credential, keyId, ownerStamp) }
                inFlight = InFlight(credential, task)
                runsHere = true
            }
        }
        if (runsHere) {
            try {
                task.run()
            } finally {
                synchronized(lock) { if (inFlight?.task === task) inFlight = null }
            }
        }
        return try {
            task.get()
        } catch (_: Exception) {
            unreachable
        }
    }

    private fun mint(
        origin: String,
        apiKey: String,
        credential: String,
        keyId: String?,
        ownerStamp: String,
    ): DeviceAccessTokenResult {
        val response = try {
            exchange.exchange(origin, apiKey)
        } catch (_: Exception) {
            ExchangeResponse(null, null)
        }
        fun result(status: DeviceAccessTokenResult.Status, token: String? = null, expiresAt: Long? = null) =
            DeviceAccessTokenResult(status, token, expiresAt, keyId, ownerStamp)

        return when (response.status) {
            200 -> {
                val parsed = parse(response.body) ?: return result(DeviceAccessTokenResult.Status.UNREACHABLE)
                val expiresAt = clock() + parsed.second * 1000
                synchronized(lock) { cached = Cached(credential, parsed.first, expiresAt) }
                result(DeviceAccessTokenResult.Status.OK, parsed.first, expiresAt)
            }
            401, 403 -> {
                synchronized(lock) { if (cached?.credential == credential) cached = null }
                result(DeviceAccessTokenResult.Status.REVOKED)
            }
            404 -> result(DeviceAccessTokenResult.Status.LEGACY)
            else -> result(DeviceAccessTokenResult.Status.UNREACHABLE)
        }
    }

    /** `{ token, expiresIn }` from a 200, or null when either is missing or out of range. */
    private fun parse(body: String?): Pair<String, Long>? {
        if (body.isNullOrEmpty()) return null
        return try {
            val json = JSONObject(body)
            val token = json.opt("token") as? String
            val expiresIn = (json.opt("expiresIn") as? Number)?.toDouble()
            if (token.isNullOrEmpty() || token.length > MAX_TOKEN_CHARS || expiresIn == null || !(expiresIn > 0)) {
                null
            } else {
                token to minOf(expiresIn, MAX_LIFETIME_SECONDS.toDouble()).toLong().coerceAtLeast(1)
            }
        } catch (_: Exception) {
            null
        }
    }

    private fun fingerprint(apiKey: String, origin: String): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(apiKey.toByteArray(Charsets.UTF_8))
        return digest.joinToString("") { "%02x".format(it) } + "\n" + origin
    }

    companion object {
        /** A token is renewed this long before it runs out, so a request never leaves with one about to. */
        const val REFRESH_MARGIN_MS = 60_000L
        /** However long Memory says a token lasts, this side treats it as at most an hour. */
        const val MAX_LIFETIME_SECONDS = 3600L
        const val MAX_TOKEN_CHARS = 4096
    }
}
