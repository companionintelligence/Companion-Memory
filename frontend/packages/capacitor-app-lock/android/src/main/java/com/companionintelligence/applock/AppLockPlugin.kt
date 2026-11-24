package com.companionintelligence.applock

import android.os.Build
import android.os.SystemClock
import android.view.ViewGroup
import android.view.WindowManager
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_WEAK
import androidx.biometric.BiometricManager.Authenticators.DEVICE_CREDENTIAL
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin

/**
 * The Android half of the app lock. The lock STATE lives here, not in the page: a cold
 * start reads the settings in [load] and shows the overlay before the WebView has loaded
 * anything, and every later decision (grace expiry on resume, lock on pause) is taken
 * here and announced to JS with `lockStateChange`. The web gate mirrors the state; it
 * does not own it.
 *
 * Authentication is the OS prompt with the device credential as fallback —
 * `BIOMETRIC_STRONG | DEVICE_CREDENTIAL` on API 30+, `BIOMETRIC_WEAK | DEVICE_CREDENTIAL`
 * below (the strong+credential combination is not allowed there). A user with no
 * enrolled biometric, or a failed scan, falls back to their PIN rather than being locked
 * out of their own memory. With DEVICE_CREDENTIAL in the set the prompt must have no
 * negative button; it does not.
 *
 * What the lock covers: the view ([LockOverlayView]) and, when `secureScreen` is on,
 * `FLAG_SECURE` so the task switcher and screenshots show nothing. What it does NOT
 * cover: sync. The outbox flush and PowerSync keep running behind the overlay, and no
 * database key is tied to the prompt — SECURITY_ARCHITECTURE.md § 4.4 explains why that
 * is one decision, not two.
 */
@CapacitorPlugin(name = "AppLock")
class AppLockPlugin : Plugin() {
    private lateinit var store: AppLockStore
    private var settings = AppLockSettings()

    @Volatile
    private var locked = false

    /** `SystemClock.elapsedRealtime()` when the activity last paused; null while foregrounded or never backgrounded. */
    private var backgroundedAt: Long? = null

    private var overlay: LockOverlayView? = null
    private var note: String = ""

    /** A prompt is showing. Pause/resume caused by the prompt itself must not re-decide the lock. */
    private var prompting = false

    /** Calls waiting on the prompt that is showing; all resolve with the same outcome. */
    private val pendingUnlocks = ArrayList<PluginCall>()

    override fun load() {
        store = AppLockStore(context)
        settings = store.read()
        applySecureScreen()

        if (AppLockPolicy.locksOnLaunch(settings)) {
            setLocked(true)
        }
    }

    override fun handleOnPause() {
        super.handleOnPause()

        if (prompting) {
            return
        }

        backgroundedAt = SystemClock.elapsedRealtime()

        if (AppLockPolicy.locksOnPause(settings)) {
            setLocked(true)
        }
    }

    override fun handleOnResume() {
        super.handleOnResume()

        if (prompting) {
            return
        }

        if (!locked && AppLockPolicy.locksOnResume(settings, backgroundedAt, SystemClock.elapsedRealtime())) {
            setLocked(true)
        }

        backgroundedAt = null

        if (locked) {
            // Coming back to a locked app: ask at once rather than making the user tap.
            promptUnlock(null)
        }
    }

    override fun handleOnDestroy() {
        overlay = null
        super.handleOnDestroy()
    }

    // ------------------------------------------------------------------ methods

    @PluginMethod
    fun getStatus(call: PluginCall) {
        call.resolve(statusJson())
    }

    @PluginMethod
    fun configure(call: PluginCall) {
        val next =
            AppLockSettings(
                enabled = call.getBoolean("enabled", settings.enabled) ?: settings.enabled,
                grace = if (call.hasOption("grace")) Grace.fromWire(call.getString("grace")) else settings.grace,
                secureScreen = call.getBoolean("secureScreen", settings.secureScreen) ?: settings.secureScreen,
            )

        if (next.enabled && !settings.enabled) {
            // Turning the lock on: prove the user can get back in before it ever engages.
            if (!isAvailable()) {
                call.resolve(statusJson(reason = "This device has no screen lock or biometric to unlock with."))

                return
            }

            authenticate(
                title = "Turn on the app lock",
                subtitle = "Confirm it is you, so you can always get back in",
                onResult = { ok ->
                    if (ok) {
                        apply(next)
                    }

                    call.resolve(statusJson(reason = if (ok) null else "authentication-cancelled"))
                },
            )

            return
        }

        apply(next)

        if (!next.enabled && locked) {
            setLocked(false)
        }

        call.resolve(statusJson())
    }

    @PluginMethod
    fun lock(call: PluginCall) {
        if (settings.enabled) {
            setLocked(true)
        }

        call.resolve(statusJson())
    }

    @PluginMethod
    fun unlock(call: PluginCall) {
        if (!locked) {
            call.resolve(statusJson())

            return
        }

        promptUnlock(call)
    }

    @PluginMethod
    fun setLockScreenNote(call: PluginCall) {
        note = call.getString("text") ?: ""
        val view = overlay

        if (view != null) {
            activity?.runOnUiThread { view.setNote(note) }
        }

        call.resolve()
    }

    // ------------------------------------------------------------------ state

    private fun apply(next: AppLockSettings) {
        settings = next
        store.write(next)
        applySecureScreen()
    }

    private fun setLocked(value: Boolean) {
        if (locked == value) {
            return
        }

        locked = value
        activity?.runOnUiThread { if (value) showOverlay() else hideOverlay() }
        notifyListeners("lockStateChange", JSObject().put("locked", value))
    }

    private fun showOverlay() {
        val host = activity ?: return
        val root = host.window.decorView as? ViewGroup ?: return

        if (overlay == null) {
            overlay =
                LockOverlayView(host) { promptUnlock(null) }.also {
                    it.setNote(note)
                    root.addView(
                        it,
                        ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT),
                    )
                }
        }
    }

    private fun hideOverlay() {
        val view = overlay ?: return

        (view.parent as? ViewGroup)?.removeView(view)
        overlay = null
    }

    private fun applySecureScreen() {
        val host = activity ?: return

        host.runOnUiThread {
            if (settings.enabled && settings.secureScreen) {
                host.window.setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)
            } else {
                host.window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
            }
        }
    }

    // ------------------------------------------------------------------ prompt

    private fun promptUnlock(call: PluginCall?) {
        if (call != null) {
            synchronized(pendingUnlocks) { pendingUnlocks.add(call) }
        }

        if (prompting) {
            return
        }

        authenticate(
            title = "Unlock Companion Memory",
            subtitle = null,
            onResult = { ok ->
                if (ok) {
                    setLocked(false)
                }

                val waiting = synchronized(pendingUnlocks) { ArrayList(pendingUnlocks).also { pendingUnlocks.clear() } }
                val status = statusJson(reason = if (ok) null else "authentication-cancelled")

                for (pending in waiting) {
                    pending.resolve(status)
                }
            },
        )
    }

    /**
     * One OS prompt. [onResult] runs once, on the main thread, with whether the user
     * passed. A `FragmentActivity` is required by BiometricPrompt and Capacitor's
     * `BridgeActivity` is one; anything else answers "not passed" rather than crashing.
     */
    private fun authenticate(title: String, subtitle: String?, onResult: (Boolean) -> Unit) {
        val host = activity as? FragmentActivity

        if (host == null || prompting) {
            onResult(false)

            return
        }

        prompting = true

        host.runOnUiThread {
            val callback =
                object : BiometricPrompt.AuthenticationCallback() {
                    override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                        prompting = false
                        onResult(true)
                    }

                    override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                        // Cancelled, timed out, locked out by the OS, or no hardware: the lock stays.
                        prompting = false
                        onResult(false)
                    }

                    override fun onAuthenticationFailed() {
                        // One rejected attempt; the prompt stays up and the OS counts attempts.
                    }
                }

            val info =
                BiometricPrompt.PromptInfo.Builder()
                    .setTitle(title)
                    .apply { if (subtitle != null) setSubtitle(subtitle) }
                    .setAllowedAuthenticators(allowedAuthenticators())
                    .build()

            BiometricPrompt(host, ContextCompat.getMainExecutor(host), callback).authenticate(info)
        }
    }

    // ------------------------------------------------------------------ status

    private fun allowedAuthenticators(): Int =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            BIOMETRIC_STRONG or DEVICE_CREDENTIAL
        } else {
            BIOMETRIC_WEAK or DEVICE_CREDENTIAL
        }

    private fun isAvailable(): Boolean =
        BiometricManager.from(context).canAuthenticate(allowedAuthenticators()) == BiometricManager.BIOMETRIC_SUCCESS

    private fun biometry(): String {
        val manager = BiometricManager.from(context)

        return when {
            manager.canAuthenticate(BIOMETRIC_STRONG) == BiometricManager.BIOMETRIC_SUCCESS -> "strong"
            manager.canAuthenticate(BIOMETRIC_WEAK) == BiometricManager.BIOMETRIC_SUCCESS -> "weak"
            manager.canAuthenticate(DEVICE_CREDENTIAL) == BiometricManager.BIOMETRIC_SUCCESS -> "credential-only"
            else -> "none"
        }
    }

    private fun unavailableReason(): String? {
        if (isAvailable()) {
            return null
        }

        return when (BiometricManager.from(context).canAuthenticate(allowedAuthenticators())) {
            BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED -> "No screen lock is set up on this device."
            BiometricManager.BIOMETRIC_ERROR_NO_HARDWARE -> "This device has no way to authenticate."
            BiometricManager.BIOMETRIC_ERROR_HW_UNAVAILABLE -> "Authentication is unavailable right now."
            else -> "This device cannot authenticate."
        }
    }

    private fun statusJson(reason: String? = null): JSObject {
        val json =
            JSObject()
                .put("enabled", settings.enabled)
                .put("grace", settings.grace.wire)
                .put("secureScreen", settings.secureScreen)
                .put("locked", locked)
                .put("available", isAvailable())
                .put("biometry", biometry())
        val why = reason ?: unavailableReason()

        if (why != null) {
            json.put("reason", why)
        }

        return json
    }
}
