package com.companionintelligence.localhub

import android.content.Intent
import android.net.Uri
import androidx.activity.result.ActivityResultLauncher
import androidx.browser.auth.AuthTabIntent
import com.getcapacitor.BridgeActivity
import java.lang.ref.WeakReference
import kotlin.jvm.JvmStatic

/**
 * Chrome Auth Tab for Portal and appliance sign-in.
 *
 * This is the Android sheet that matches iOS `ASWebAuthenticationSession`: an
 * in-app browser that shares the real browser's cookies and returns
 * `companion://` to the app, instead of an embedded WebView (which Play treats
 * as a credential-phishing surface) or a full handoff into Chrome.
 *
 * The launcher has to be registered from [BridgeActivity.onCreate] before the
 * activity is started. [LocalHubPlugin.openUrl] only launches it. When the
 * sheet finishes, the callback URL is replayed as an `ACTION_VIEW` intent so
 * Capacitor's existing `appUrlOpen` listener finishes login. A cancel is
 * ignored on purpose: browsers without Auth Tab fall back to a Custom Tab,
 * and that path delivers `companion://` through the real intent filter. A
 * cancel result racing that delivery must not look like a failed login.
 */
object AuthTabSession {
    const val REDIRECT_SCHEME = "companion"

    private var launcher: ActivityResultLauncher<Intent>? = null
    private var host: WeakReference<BridgeActivity>? = null

    @JvmStatic
    fun register(activity: BridgeActivity) {
        host = WeakReference(activity)
        launcher = AuthTabIntent.registerActivityResultLauncher(activity) { result ->
            deliver(result.resultCode, result.resultUri)
        }
    }

    @JvmStatic
    fun isRegistered(): Boolean = launcher != null

    /** @return false when the activity never registered a launcher. */
    @JvmStatic
    fun launch(url: Uri): Boolean {
        val registered = launcher ?: return false
        AuthTabIntent.Builder().build().launch(registered, url, REDIRECT_SCHEME)
        return true
    }

    /**
     * Returns the callback to hand to `appUrlOpen`, or null when the sheet
     * closed without our scheme. Public for the unit test; the activity
     * result callback is the only production caller.
     */
    @JvmStatic
    fun callbackUri(resultCode: Int, uri: Uri?): Uri? {
        if (resultCode != AuthTabIntent.RESULT_OK || uri == null) {
            return null
        }
        val scheme = uri.scheme ?: return null
        if (!scheme.equals(REDIRECT_SCHEME, ignoreCase = true)) {
            return null
        }
        return uri
    }

    private fun deliver(resultCode: Int, uri: Uri?) {
        val callback = callbackUri(resultCode, uri) ?: return
        val activity = host?.get() ?: return
        val intent = Intent(Intent.ACTION_VIEW, callback)
        activity.intent = intent
        activity.getBridge()?.onNewIntent(intent)
    }
}
