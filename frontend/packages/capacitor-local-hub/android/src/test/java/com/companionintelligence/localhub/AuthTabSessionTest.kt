package com.companionintelligence.localhub

import android.app.Activity
import android.net.Uri
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Auth Tab only forwards `companion://` on RESULT_OK. A cancel, a foreign
 * scheme, or a missing URI must stay null so a Custom Tab fallback (which
 * delivers the real deep link on its own) is not treated as a second outcome.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class AuthTabSessionTest {

    @Test
    fun okCompanionCallback_isForwarded() {
        val uri = Uri.parse("companion://auth/callback?code=abc&state=xyz")
        assertEquals(uri, AuthTabSession.callbackUri(Activity.RESULT_OK, uri))
    }

    @Test
    fun cancel_isIgnored() {
        val uri = Uri.parse("companion://auth/callback?code=abc")
        assertNull(AuthTabSession.callbackUri(Activity.RESULT_CANCELED, uri))
    }

    @Test
    fun foreignScheme_isIgnored() {
        val uri = Uri.parse("https://hub.ci.computer/auth/callback?code=abc")
        assertNull(AuthTabSession.callbackUri(Activity.RESULT_OK, uri))
    }

    @Test
    fun missingUri_isIgnored() {
        assertNull(AuthTabSession.callbackUri(Activity.RESULT_OK, null))
    }
}
