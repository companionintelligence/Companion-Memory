package com.companionintelligence.localhub

import com.companionintelligence.localhub.DeviceAccessTokenResult.Status
import fi.iki.elonen.NanoHTTPD
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/** An in-memory [SecureValueStore], as the plugin's credential namespace. */
private class MapStore(vararg entries: Pair<String, String>) : SecureValueStore {
    val values = mutableMapOf(*entries)

    override fun get(key: String): String? = values[key]

    override fun set(key: String, value: String) {
        values[key] = value
    }

    override fun remove(key: String) {
        values.remove(key)
    }
}

private val KEY = "a".repeat(64)
private const val ORIGIN = "https://memory.example.lan"

private fun signedIn(origin: String = ORIGIN) = MapStore(
    DeviceCredentialKeys.API_KEY to KEY,
    DeviceCredentialKeys.API_KEY_ID to "key-1",
    DeviceCredentialKeys.API_KEY_CAPABILITY to "full",
    DeviceCredentialKeys.API_BASE_URL to origin,
)

/** A [TokenExchange] that answers from a script and counts calls. */
private class ScriptedExchange(private val answer: (Int) -> ExchangeResponse) : TokenExchange {
    val calls = AtomicInteger()
    val seen = mutableListOf<Pair<String, String>>()

    override fun exchange(origin: String, apiKey: String): ExchangeResponse {
        synchronized(seen) { seen += origin to apiKey }
        return answer(calls.incrementAndGet())
    }
}

private fun issued(token: String = "tok", expiresIn: Int = 300) =
    ExchangeResponse(200, """{"token":"$token","expiresAt":"2026-11-27T00:05:00.000Z","expiresIn":$expiresIn}""")

/** Robolectric for the real org.json the token answer is parsed with. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class DeviceAccessTokensTest {
    @Test
    fun `mints a token for the stored key at its own origin, with the outbox owner stamp`() {
        val exchange = ScriptedExchange { issued() }
        val tokens = DeviceAccessTokens(signedIn("$ORIGIN/"), exchange) { 1_000_000L }

        val result = tokens.get(refresh = false)

        assertEquals(Status.OK, result.status)
        assertEquals("tok", result.token)
        assertEquals(1_000_000L + 300_000L, result.expiresAt)
        assertEquals("key-1", result.keyId)
        assertEquals(com.companionintelligence.localhub.upload.OutboxOwnerStamp.of(ORIGIN, KEY), result.ownerStamp)
        assertEquals(listOf(ORIGIN to KEY), exchange.seen)
    }

    @Test
    fun `reuses a token until a minute before it runs out, or when asked to refresh`() {
        var now = 0L
        val exchange = ScriptedExchange { n -> issued("tok-$n") }
        val tokens = DeviceAccessTokens(signedIn(), exchange) { now }

        assertEquals("tok-1", tokens.get(false).token)
        now = 239_000L
        assertEquals("tok-1", tokens.get(false).token)
        now = 240_000L
        assertEquals("tok-2", tokens.get(false).token)
        assertEquals("tok-3", tokens.get(true).token)
        assertEquals(3, exchange.calls.get())
    }

    @Test
    fun `a changed key is a new credential, so the cached token is not handed out for it`() {
        val store = signedIn()
        val exchange = ScriptedExchange { n -> issued("tok-$n") }
        val tokens = DeviceAccessTokens(store, exchange) { 0L }

        assertEquals("tok-1", tokens.get(false).token)
        store.set(DeviceCredentialKeys.API_KEY, "b".repeat(64))
        assertEquals("tok-2", tokens.get(false).token)
    }

    @Test
    fun `signed out is none, with nothing else, and asks nothing`() {
        val exchange = ScriptedExchange { issued() }
        val result = DeviceAccessTokens(MapStore(), exchange).get(false)

        assertEquals(DeviceAccessTokenResult(Status.NONE, null, null, null, null), result)
        assertEquals(0, exchange.calls.get())
    }

    @Test
    fun `a key with no origin, or one that is not http, is unreachable and asks nothing`() {
        val exchange = ScriptedExchange { issued() }
        val noOrigin = signedIn().apply { remove(DeviceCredentialKeys.API_BASE_URL) }

        val missing = DeviceAccessTokens(noOrigin, exchange).get(false)
        assertEquals(Status.UNREACHABLE, missing.status)
        assertEquals("key-1", missing.keyId)
        assertNull(missing.ownerStamp)

        val ftp = DeviceAccessTokens(signedIn("ftp://memory.example.lan"), exchange).get(false)
        assertEquals(Status.UNREACHABLE, ftp.status)
        assertEquals(0, exchange.calls.get())
    }

    @Test
    fun `401 and 403 are revoked, and drop the cached token without touching the key`() {
        var now = 0L
        val answers = ArrayDeque(listOf(issued("tok"), ExchangeResponse(401, null), ExchangeResponse(403, null)))
        val store = signedIn()
        val tokens = DeviceAccessTokens(store, ScriptedExchange { answers.removeFirst() }) { now }

        assertEquals(Status.OK, tokens.get(false).status)
        val revoked = tokens.get(true)
        assertEquals(Status.REVOKED, revoked.status)
        assertNull(revoked.token)
        assertEquals(Status.REVOKED, tokens.get(false).status)
        assertEquals(KEY, store.get(DeviceCredentialKeys.API_KEY))
    }

    @Test
    fun `a Memory without the route is legacy and the page gets no token, never the key, uncached`() {
        val store = signedIn()
        val exchange = ScriptedExchange { ExchangeResponse(404, null) }
        val tokens = DeviceAccessTokens(store, exchange)

        val result = tokens.get(false)
        assertEquals(Status.LEGACY, result.status)
        assertNull(result.token)
        assertEquals(KEY, store.get(DeviceCredentialKeys.API_KEY))
        assertNull(result.expiresAt)
        tokens.get(false)
        assertEquals(2, exchange.calls.get())
    }

    @Test
    fun `no answer, a redirect, a server error or an unusable body is unreachable`() {
        val answers = listOf(
            ExchangeResponse(null, null),
            ExchangeResponse(302, null),
            ExchangeResponse(500, "oops"),
            ExchangeResponse(200, "not json"),
            ExchangeResponse(200, """{"token":"","expiresIn":300}"""),
            ExchangeResponse(200, """{"token":"t","expiresIn":0}"""),
            ExchangeResponse(200, """{"token":"t"}"""),
            ExchangeResponse(200, """{"token":"${"t".repeat(4097)}","expiresIn":300}"""),
        )
        for (answer in answers) {
            val result = DeviceAccessTokens(signedIn(), ScriptedExchange { answer }).get(false)
            assertEquals("$answer", Status.UNREACHABLE, result.status)
            assertNull(result.token)
            assertEquals(com.companionintelligence.localhub.upload.OutboxOwnerStamp.of(ORIGIN, KEY), result.ownerStamp)
        }
    }

    @Test
    fun `an exchange that throws is unreachable, not a crash`() {
        val result = DeviceAccessTokens(signedIn(), ScriptedExchange { throw IllegalStateException("boom") }).get(false)

        assertEquals(Status.UNREACHABLE, result.status)
    }

    @Test
    fun `takes at most an hour from whatever lifetime Memory states`() {
        val result = DeviceAccessTokens(signedIn(), ScriptedExchange { issued(expiresIn = 86_400) }) { 0L }.get(false)

        assertEquals(3_600_000L, result.expiresAt)
    }

    @Test
    fun `concurrent calls share one request`() {
        val release = CountDownLatch(1)
        val exchange = ScriptedExchange {
            release.await(5, TimeUnit.SECONDS)
            issued()
        }
        val tokens = DeviceAccessTokens(signedIn(), exchange)
        val pool = Executors.newFixedThreadPool(4)
        val results = (1..4).map { pool.submit<DeviceAccessTokenResult> { tokens.get(true) } }
        Thread.sleep(200)
        release.countDown()

        assertTrue(results.all { it.get(5, TimeUnit.SECONDS).token == "tok" })
        assertEquals(1, exchange.calls.get())
        pool.shutdown()
    }

    @Test
    fun `never prints the key or the token`() {
        val result = DeviceAccessTokens(signedIn(), ScriptedExchange { issued("secret-token") }).get(false)

        assertFalse(result.toString().contains("secret-token"))
        assertFalse(StoredDeviceCredential.from(signedIn()).toString().contains(KEY))
    }
}

class DeviceCredentialBindingTest {
    @Test
    fun `a different origin drops the key it was stored for`() {
        val store = signedIn()

        assertTrue(DeviceCredentialBinding.beforeSet(store, DeviceCredentialKeys.API_BASE_URL, "https://evil.example"))
        for (entry in DeviceCredentialKeys.KEY_ENTRIES) assertNull(entry, store.get(entry))
    }

    @Test
    fun `the same origin, with or without a trailing slash, keeps the key`() {
        val store = signedIn()

        assertFalse(DeviceCredentialBinding.beforeSet(store, DeviceCredentialKeys.API_BASE_URL, ORIGIN))
        assertFalse(DeviceCredentialBinding.beforeSet(store, DeviceCredentialKeys.API_BASE_URL, "$ORIGIN/"))
        assertEquals(KEY, store.get(DeviceCredentialKeys.API_KEY))
    }

    @Test
    fun `a first origin for a key stored before origins were mirrored keeps the key`() {
        val store = signedIn().apply { remove(DeviceCredentialKeys.API_BASE_URL) }

        assertFalse(DeviceCredentialBinding.beforeSet(store, DeviceCredentialKeys.API_BASE_URL, ORIGIN))
        assertEquals(KEY, store.get(DeviceCredentialKeys.API_KEY))
    }

    @Test
    fun `a new origin with no key stored has nothing to drop`() {
        val store = MapStore(DeviceCredentialKeys.API_BASE_URL to ORIGIN)

        assertFalse(DeviceCredentialBinding.beforeSet(store, DeviceCredentialKeys.API_BASE_URL, "https://other.example"))
    }

    @Test
    fun `other keys are written as they are`() {
        val store = signedIn()

        assertFalse(DeviceCredentialBinding.beforeSet(store, DeviceCredentialKeys.API_KEY, "b".repeat(64)))
        assertFalse(DeviceCredentialBinding.beforeRemove(store, DeviceCredentialKeys.API_KEY_ID))
        assertEquals(KEY, store.get(DeviceCredentialKeys.API_KEY))
    }

    @Test
    fun `removing the origin removes the key too`() {
        val store = signedIn()

        assertTrue(DeviceCredentialBinding.beforeRemove(store, DeviceCredentialKeys.API_BASE_URL))
        for (entry in DeviceCredentialKeys.KEY_ENTRIES) assertNull(entry, store.get(entry))
    }

    @Test
    fun `a key that no longer decrypts counts as stored, so it cannot follow a new origin`() {
        val store = object : SecureValueStore by signedIn() {
            val removed = mutableListOf<String>()

            override fun get(key: String): String? =
                if (key == DeviceCredentialKeys.API_KEY) throw IllegalStateException("bad blob") else ORIGIN

            override fun remove(key: String) {
                removed += key
            }
        }

        assertTrue(DeviceCredentialBinding.beforeSet(store, DeviceCredentialKeys.API_BASE_URL, "https://evil.example"))
        assertEquals(DeviceCredentialKeys.KEY_ENTRIES, store.removed)
    }

    @Test
    fun `the background senders may use the key only at its own origin`() {
        val store = signedIn()

        assertTrue(DeviceCredentialBinding.keyMaySendTo(store, ORIGIN))
        assertTrue(DeviceCredentialBinding.keyMaySendTo(store, "$ORIGIN/"))
        assertFalse(DeviceCredentialBinding.keyMaySendTo(store, "https://evil.example"))
        assertFalse(DeviceCredentialBinding.keyMaySendTo(store, null))
        assertFalse(DeviceCredentialBinding.keyMaySendTo(signedIn().apply { remove(DeviceCredentialKeys.API_BASE_URL) }, ORIGIN))
    }

    @Test
    fun `the stored credential for native callers needs a key and an http origin`() {
        assertEquals(ORIGIN, StoredDeviceCredential.from(signedIn("$ORIGIN/"))?.baseUrl)
        assertNull(StoredDeviceCredential.from(MapStore(DeviceCredentialKeys.API_BASE_URL to ORIGIN)))
        assertNull(StoredDeviceCredential.from(signedIn().apply { remove(DeviceCredentialKeys.API_BASE_URL) }))
        assertNull(StoredDeviceCredential.from(signedIn("javascript:alert(1)")))
    }
}

/** The real HTTP exchange against a local server: what it sends, and that it follows no redirect. */
class HttpTokenExchangeTest {
    private fun serve(handler: (NanoHTTPD.IHTTPSession) -> NanoHTTPD.Response, block: (String) -> Unit) {
        val server = object : NanoHTTPD("127.0.0.1", 0) {
            override fun serve(session: IHTTPSession): Response = handler(session)
        }
        server.start(NanoHTTPD.SOCKET_READ_TIMEOUT, true)
        try {
            block("http://127.0.0.1:${server.listeningPort}")
        } finally {
            server.stop()
        }
    }

    private fun answer(status: NanoHTTPD.Response.Status, body: String = "") =
        NanoHTTPD.newFixedLengthResponse(status, "application/json", body)

    @Test
    fun `posts the key to the access-token route and returns the answer`() {
        val method = AtomicReference<String>()
        val path = AtomicReference<String>()
        val key = AtomicReference<String>()
        serve({ session ->
            method.set(session.method.name)
            path.set(session.uri)
            key.set(session.headers["x-api-key"])
            answer(NanoHTTPD.Response.Status.OK, """{"token":"t","expiresIn":300}""")
        }) { origin ->
            val response = HttpTokenExchange().exchange(origin, KEY)

            assertEquals(200, response.status)
            assertEquals("""{"token":"t","expiresIn":300}""", response.body)
        }
        assertEquals("POST", method.get())
        assertEquals("/api/keys/access-token", path.get())
        assertEquals(KEY, key.get())
    }

    @Test
    fun `does not follow a redirect, so the key never goes to another server`() {
        val followed = AtomicInteger()
        serve({ session ->
            if (session.uri == "/elsewhere") {
                followed.incrementAndGet()
                answer(NanoHTTPD.Response.Status.OK)
            } else {
                answer(NanoHTTPD.Response.Status.TEMPORARY_REDIRECT).apply { addHeader("Location", "/elsewhere") }
            }
        }) { origin ->
            assertEquals(307, HttpTokenExchange().exchange(origin, KEY).status)
        }
        assertEquals(0, followed.get())
    }

    @Test
    fun `reports a refusal's status, and no answer as null`() {
        serve({ _ -> answer(NanoHTTPD.Response.Status.UNAUTHORIZED) }) { origin ->
            assertEquals(401, HttpTokenExchange().exchange(origin, KEY).status)
        }
        assertNull(HttpTokenExchange(timeoutMs = 1_000).exchange("http://127.0.0.1:1", KEY).status)
    }

    @Test
    fun `gives up on a Memory that does not answer in time`() {
        val release = CountDownLatch(1)
        serve({ _ ->
            release.await(5, TimeUnit.SECONDS)
            answer(NanoHTTPD.Response.Status.OK)
        }) { origin ->
            assertNull(HttpTokenExchange(timeoutMs = 300).exchange(origin, KEY).status)
            release.countDown()
        }
    }
}
