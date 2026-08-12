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

/**
 * Android native half of the Local Hub sidecar's Phase 1 skeleton. See `src/definitions.ts`
 * for the JS-facing contract this implements and this package's root `README.md` for the
 * full multi-phase design (outbox, local inference land in later passes behind
 * [LocalHubServer], not here).
 *
 * All mutable state (the running [LocalHubServer] instance and its current bearer token)
 * is only ever touched while holding [stateMutex], so concurrent start()/stop()/getStatus()
 * calls from JS -- e.g. a status poll racing a stop() -- can't interleave into an
 * inconsistent state.
 */
@CapacitorPlugin(name = "LocalHub")
class LocalHubPlugin : Plugin() {
    private val pluginScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private val stateMutex = Mutex()

    private var server: LocalHubServer? = null
    private var token: String? = null

    override fun handleOnDestroy() {
        // Synchronous best-effort cleanup: handleOnDestroy has no coroutine to await, but
        // NanoHTTPD#stop() already blocks until its listener thread has joined, so this is
        // a real stop, not a fire-and-forget one.
        server?.stop()
        server = null
        token = null
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
        val newServer = LocalHubServer(newToken)

        withContext(Dispatchers.IO) {
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
