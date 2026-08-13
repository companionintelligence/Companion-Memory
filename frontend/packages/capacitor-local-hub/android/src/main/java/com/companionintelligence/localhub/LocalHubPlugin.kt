package com.companionintelligence.localhub

import android.util.Base64
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import java.security.SecureRandom
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withContext
import org.json.JSONObject

/**
 * Android native half of the Local Hub sidecar. See `src/definitions.ts` for the JS-facing
 * contract this implements and this package's root `README.md` for the full multi-phase
 * design (local inference lands in a later pass behind [LocalHubServer], not here).
 *
 * All mutable state (the running [LocalHubServer] instance, its current bearer token, and
 * the [OutboxStore] handle) is only ever touched while holding [stateMutex], so concurrent
 * start()/stop()/getStatus() calls from JS -- e.g. a status poll racing a stop() -- can't
 * interleave into an inconsistent state.
 *
 * The `secure*` methods are a second, unrelated surface that happens to live here: they expose
 * [CompanionSecureStore] to JS so the appliance API key stops being held by
 * `capacitor-secure-storage-plugin`, which silently degrades to unencrypted Base64 when
 * Keystore initialisation fails. They take no locks -- SharedPreferences and `Cipher` are
 * already safe to use concurrently -- and deliberately share no state with the server
 * lifecycle, so reading a credential does not require the sidecar to be running.
 */
@CapacitorPlugin(name = "LocalHub")
class LocalHubPlugin : Plugin() {
    private val pluginScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val stateMutex = Mutex()

    private var server: LocalHubServer? = null
    private var token: String? = null

    /**
     * Outlives individual server instances on purpose: [stop] tears down the HTTP listener,
     * but the queued captures behind it are durable user data, so the database handle is
     * only released when the plugin itself goes away.
     */
    private var outbox: OutboxStore? = null

    override fun handleOnDestroy() {
        // Synchronous best-effort cleanup: handleOnDestroy has no coroutine to await, but
        // NanoHTTPD#stop() already blocks until its listener thread has joined, so this is
        // a real stop, not a fire-and-forget one.
        server?.stop()
        server = null
        token = null
        // Only closes the handle; every write was already committed to disk before its
        // HTTP response was sent, so there is nothing here left to flush.
        outbox?.close()
        outbox = null
        pluginScope.cancel()
        super.handleOnDestroy()
    }

    /**
     * Starts the embedded server if not already running (fresh port + fresh token), or
     * returns the already-running instance's `baseUrl`/`token` unchanged. Resolves only
     * after the server socket is actually bound -- see [LocalHubServer]'s use of
     * NanoHTTPD's synchronous `start()`.
     */
    @PluginMethod
    fun start(call: PluginCall) {
        pluginScope.launch {
            try {
                val result = stateMutex.withLock { startLocked() }
                call.resolve(result)
            } catch (e: Exception) {
                call.reject("Failed to start Local Hub server: ${e.message}", e)
            }
        }
    }

    @PluginMethod
    fun stop(call: PluginCall) {
        pluginScope.launch {
            try {
                stateMutex.withLock { stopLocked() }
                call.resolve()
            } catch (e: Exception) {
                call.reject("Failed to stop Local Hub server: ${e.message}", e)
            }
        }
    }

    @PluginMethod
    fun getStatus(call: PluginCall) {
        pluginScope.launch {
            val ret = stateMutex.withLock { statusLocked() }
            call.resolve(ret)
        }
    }

    // ------------------------------------------------------------------ secure storage

    /**
     * Reads one value from [CompanionSecureStore], resolving `{ value: null }` when nothing is
     * stored under `key`.
     *
     * Rejects -- rather than resolving null -- when the keystore itself is unusable or a stored
     * blob no longer decrypts, so the two cases stay distinguishable at the bridge. The JS
     * `secureStorageGet` chooses to collapse both into "signed out"; that leniency belongs at
     * the call site, not here.
     */
    @PluginMethod
    fun secureGet(call: PluginCall) {
        val key = call.getString("key")
        if (key.isNullOrEmpty()) {
            call.reject("A non-empty 'key' is required")
            return
        }
        pluginScope.launch {
            try {
                val value = withContext(Dispatchers.IO) { credentialStore.get(key) }
                val ret = JSObject()
                // JSObject.put(String, null) would drop the entry; an explicit JSON null keeps
                // the shape of the resolved object stable for the TS side.
                if (value == null) ret.put("value", JSONObject.NULL) else ret.put("value", value)
                call.resolve(ret)
            } catch (e: Exception) {
                call.reject(e.message ?: "Secure storage read failed", e)
            }
        }
    }

    /**
     * Encrypts and commits one value. Rejects if it could not be stored **protected** -- there
     * is no plaintext fallback anywhere below this, which is the whole point of the store.
     */
    @PluginMethod
    fun secureSet(call: PluginCall) {
        val key = call.getString("key")
        val value = call.getString("value")
        if (key.isNullOrEmpty()) {
            call.reject("A non-empty 'key' is required")
            return
        }
        if (value == null) {
            call.reject("A 'value' is required")
            return
        }
        pluginScope.launch {
            try {
                withContext(Dispatchers.IO) { credentialStore.set(key, value) }
                call.resolve()
            } catch (e: Exception) {
                call.reject(e.message ?: "Secure storage write failed", e)
            }
        }
    }

    /** Removes one value. Resolves successfully when it was already absent. */
    @PluginMethod
    fun secureRemove(call: PluginCall) {
        val key = call.getString("key")
        if (key.isNullOrEmpty()) {
            call.reject("A non-empty 'key' is required")
            return
        }
        pluginScope.launch {
            try {
                withContext(Dispatchers.IO) { credentialStore.remove(key) }
                call.resolve()
            } catch (e: Exception) {
                call.reject(e.message ?: "Secure storage remove failed", e)
            }
        }
    }

    /**
     * Lazy, not a field initializer: a `Plugin` is constructed before Capacitor attaches its
     * `Context`, so `context` is only safe to read once a method has actually been called.
     * `by lazy` is thread-safe, which matters because the three secure* methods run on
     * [pluginScope]'s IO dispatcher.
     */
    private val credentialStore: CompanionSecureStore by lazy { CompanionSecureStore.credentials(context) }

    /** Must hold [stateMutex]. */
    private suspend fun startLocked(): JSObject {
        val runningServer = server
        val runningToken = token
        if (runningServer != null && runningServer.isAlive && runningToken != null) {
            val ret = JSObject()
            ret.put("baseUrl", baseUrlFor(runningServer))
            ret.put("token", runningToken)
            return ret
        }

        // Clear out a half-dead previous instance (e.g. its accept thread died) before
        // starting a replacement.
        if (runningServer != null) {
            withContext(Dispatchers.IO) { runningServer.stop() }
        }

        val newToken = generateToken()
        // getContext() is the Capacitor bridge's Context; OutboxStore re-derives the
        // application context from it, so holding this store can't leak an Activity. The
        // database itself lands in app-private internal storage
        // (/data/data/<pkg>/databases/), which is where the durability guarantee comes from.
        val store = outbox ?: OutboxStore(context).also { outbox = it }
        val newServer = LocalHubServer(newToken, store)

        withContext(Dispatchers.IO) {
            // Open (and, on first launch, create) the database here rather than lazily on the
            // first request: it makes a broken/corrupt outbox a start() failure the caller
            // can see, and keeps that disk I/O off the NanoHTTPD worker that would otherwise
            // pay for it mid-request. Since the outbox is encrypted, this is also where a
            // missing keystore key or a failed plaintext->encrypted migration surfaces -- as a
            // rejected start(), never as a silently empty queue.
            store.open()

            // NanoHTTPD#start busy-waits internally until the socket is actually bound (or
            // throws), so getListeningPort() below is valid the moment this call returns --
            // this is what keeps us from resolving a baseUrl before anything is listening.
            newServer.start(NANOHTTPD_SOCKET_READ_TIMEOUT_MS, true)
        }

        server = newServer
        token = newToken

        val ret = JSObject()
        ret.put("baseUrl", baseUrlFor(newServer))
        ret.put("token", newToken)
        return ret
    }

    /** Must hold [stateMutex]. */
    private suspend fun stopLocked() {
        val runningServer = server ?: return
        withContext(Dispatchers.IO) { runningServer.stop() }
        server = null
        token = null
    }

    /** Must hold [stateMutex]. */
    private fun statusLocked(): JSObject {
        val ret = JSObject()
        val runningServer = server?.takeIf { it.isAlive }
        ret.put("running", runningServer != null)
        if (runningServer != null) {
            ret.put("baseUrl", baseUrlFor(runningServer))
        }
        return ret
    }

    private fun baseUrlFor(server: LocalHubServer): String = "http://127.0.0.1:${server.listeningPort}"

    /** [TOKEN_BYTES] bytes from [SecureRandom], base64url-encoded without padding -- never persisted to disk. */
    private fun generateToken(): String {
        val bytes = ByteArray(TOKEN_BYTES)
        SecureRandom().nextBytes(bytes)
        return Base64.encodeToString(bytes, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
    }

    companion object {
        private const val TOKEN_BYTES = 32
        private const val NANOHTTPD_SOCKET_READ_TIMEOUT_MS = 5000
    }
}
