package com.companionintelligence.localllm.intents

/**
 * The Memory origin and device key the intent tools call with.
 *
 * The web page used to pass the key in `configureIntentTools`. It no longer holds the key -- the
 * app keeps it in Local Hub's encrypted credential store and gives the page only short-lived
 * tokens -- so the tools read it natively instead, at request time, through an
 * [IntentCredentialSource] the app installs ([IntentCredentials.install]). This plugin still
 * does not depend on Local Hub: the app module, which has both, does the wiring (`MainActivity`).
 */
class IntentCredential(val baseUrl: String, val apiKey: String) {
    override fun toString(): String = "IntentCredential(baseUrl=$baseUrl, apiKey=<redacted>)"
}

/** Reads the current credential, or null when the app is signed out. May throw when the keystore is unusable. */
fun interface IntentCredentialSource {
    fun current(): IntentCredential?
}

object IntentCredentials {
    @Volatile
    private var source: IntentCredentialSource? = null

    /** Called once by the app before the bridge starts. */
    @JvmStatic
    fun install(source: IntentCredentialSource) {
        this.source = source
    }

    /** The installed source, or null in a build that never installed one (the tools then stay off). */
    @JvmStatic
    fun source(): IntentCredentialSource? = source
}
