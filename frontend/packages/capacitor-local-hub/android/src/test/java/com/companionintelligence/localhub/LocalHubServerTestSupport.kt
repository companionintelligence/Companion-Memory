package com.companionintelligence.localhub

import fi.iki.elonen.NanoHTTPD
import java.io.ByteArrayInputStream
import java.io.InputStream

// Test doubles that let LocalHubServer's router be driven without binding a socket or opening
// SQLCipher.
//
// The router is reached through its real entry point, serve(IHTTPSession), so everything under
// test -- the CORS wrapper, the preflight-before-auth ordering, the bearer check, the path
// split, JSON typing, the catch-all 500 -- is the production code path. What is NOT covered
// here, by construction, is NanoHTTPD's own plumbing (socket binding, keep-alive reuse, header
// lowercasing, the status line it builds from getDescription()) and whether a real WebView
// accepts the CORS headers. Those stay in the instrumented suite, which talks to a real port.

/** Long enough that a truncated or one-character-off variant is a meaningful forgery. */
internal const val TEST_TOKEN = "u9Q3-token-value-with-length"

/**
 * A hand-written [NanoHTTPD.IHTTPSession].
 *
 * Deliberately not a mock: the router reads five of these twelve members and a stubbing
 * framework would express the same thing at more cost. It also lets the header map preserve the
 * casing the caller chose, which a real NanoHTTPD session never does -- that is the whole point
 * of the case-insensitive `Authorization` lookup, and the reason a device test cannot check it.
 */
internal class FakeSession(
    private val httpMethod: NanoHTTPD.Method,
    private val requestUri: String,
    private val headerMap: MutableMap<String, String>,
    private val queryParameters: MutableMap<String, MutableList<String>>,
    private val bodyText: String?,
) : NanoHTTPD.IHTTPSession {

    /** How many times the router drained the request body; see the keep-alive comment in serve(). */
    var parseBodyCalls: Int = 0
        private set

    override fun execute() = Unit

    override fun getCookies(): NanoHTTPD.CookieHandler? = null

    override fun getHeaders(): MutableMap<String, String> = headerMap

    override fun getInputStream(): InputStream =
        ByteArrayInputStream((bodyText ?: "").toByteArray(Charsets.UTF_8))

    override fun getMethod(): NanoHTTPD.Method = httpMethod

    override fun getParms(): MutableMap<String, String> =
        queryParameters.mapValues { it.value.firstOrNull() ?: "" }.toMutableMap()

    override fun getParameters(): MutableMap<String, MutableList<String>> = queryParameters

    override fun getQueryParameterString(): String? = null

    override fun getUri(): String = requestUri

    override fun parseBody(files: MutableMap<String, String>) {
        parseBodyCalls++
        // NanoHTTPD stashes a non-form POST body under exactly this key.
        bodyText?.let { files["postData"] = it }
    }

    override fun getRemoteIpAddress(): String = "127.0.0.1"

    override fun getRemoteHostName(): String = "localhost"
}

/**
 * An [OutboxQueue] whose every answer is scripted, so the router's own behaviour is what the
 * assertions see.
 *
 * [thrown] is the reason this exists at all: with a real store nothing in `route()` throws, so
 * the catch-all 500 -- the one response the WebView cannot tell apart from a CORS failure if it
 * loses its headers -- has no coverage anywhere else.
 */
internal class FakeOutbox(
    override val maxItems: Int = 100,
    override val warnAt: Int = 80,
) : OutboxQueue {

    /** When set, every queue call throws it. */
    var thrown: RuntimeException? = null

    var nextEnqueueOutcome: EnqueueOutcome = EnqueueOutcome.Created(outboxItem())
    var listResult: List<OutboxItem> = emptyList()
    var countsResult: OutboxCounts = OutboxCounts(pending = 0, needsAttention = 0, total = 0)
    var getResult: OutboxItem? = null
    var deleteResult: Boolean = false
    var recordFailedAttemptResult: OutboxItem? = outboxItem()
    var retryResult: OutboxItem? = outboxItem()

    /** `[kind, payloadJson, capturedAt, idempotencyKey]` per accepted enqueue. */
    val enqueueCalls = mutableListOf<List<String>>()
    val listFilters = mutableListOf<String?>()
    val fetchedIds = mutableListOf<String>()
    val deletedIds = mutableListOf<String>()
    val recordedAttempts = mutableListOf<Triple<String, String, Boolean>>()
    val retriedIds = mutableListOf<String>()

    /** True when the router reached the store at all -- the assertion for "rejected first". */
    val wasTouched: Boolean
        get() = enqueueCalls.isNotEmpty() || listFilters.isNotEmpty() || fetchedIds.isNotEmpty() ||
            deletedIds.isNotEmpty() || recordedAttempts.isNotEmpty() || retriedIds.isNotEmpty()

    override fun enqueue(
        kind: String,
        payloadJson: String,
        capturedAt: String,
        idempotencyKey: String,
    ): EnqueueOutcome {
        thrown?.let { throw it }
        enqueueCalls += listOf(kind, payloadJson, capturedAt, idempotencyKey)
        return nextEnqueueOutcome
    }

    override fun list(statusFilter: String?): List<OutboxItem> {
        thrown?.let { throw it }
        listFilters += statusFilter
        return listResult
    }

    override fun get(id: String): OutboxItem? {
        thrown?.let { throw it }
        fetchedIds += id
        return getResult
    }

    override fun delete(id: String): Boolean {
        thrown?.let { throw it }
        deletedIds += id
        return deleteResult
    }

    override fun recordFailedAttempt(id: String, error: String, permanent: Boolean): OutboxItem? {
        thrown?.let { throw it }
        recordedAttempts += Triple(id, error, permanent)
        return recordFailedAttemptResult
    }

    override fun retry(id: String): OutboxItem? {
        thrown?.let { throw it }
        retriedIds += id
        return retryResult
    }

    override fun counts(): OutboxCounts {
        thrown?.let { throw it }
        return countsResult
    }
}

internal fun outboxItem(
    id: String = "item-1",
    kind: String = "note",
    capturedAt: String = "2026-01-01T00:00:00.000Z",
    seq: Long = 1,
    status: String = OutboxStore.STATUS_PENDING,
    attempts: Int = 0,
    lastError: String? = null,
    payload: String? = null,
): OutboxItem = OutboxItem(
    id = id,
    kind = kind,
    capturedAt = capturedAt,
    seq = seq,
    status = status,
    attempts = attempts,
    lastError = lastError,
    payload = payload,
)

/**
 * Builds a session. [authorization] is the raw header value, so a test can present a wrongly
 * cased scheme or omit the header entirely; [authorizationHeaderName] carries the casing a real
 * NanoHTTPD session would have already flattened away.
 */
internal fun request(
    method: NanoHTTPD.Method,
    uri: String,
    body: String? = null,
    authorization: String? = "Bearer $TEST_TOKEN",
    authorizationHeaderName: String = "authorization",
    parameters: Map<String, List<String>> = emptyMap(),
): FakeSession {
    val headers = LinkedHashMap<String, String>()
    if (authorization != null) {
        headers[authorizationHeaderName] = authorization
    }
    val query = LinkedHashMap<String, MutableList<String>>()
    parameters.forEach { (name, values) -> query[name] = values.toMutableList() }
    return FakeSession(method, uri, headers, query, body)
}

internal fun serve(
    session: FakeSession,
    outbox: OutboxQueue = FakeOutbox(),
    token: String = TEST_TOKEN,
): NanoHTTPD.Response = LocalHubServer(token, outbox).serve(session)

/** A body every enqueue field accepts, so a test can vary exactly one of them. */
internal fun validEnqueueBody(
    kind: String = "\"note\"",
    payload: String = "{\"text\":\"hello\"}",
    capturedAt: String = "\"2026-01-01T00:00:00.000Z\"",
    idempotencyKey: String = "\"idem-1\"",
): String = """{"kind":$kind,"payload":$payload,"capturedAt":$capturedAt,"idempotencyKey":$idempotencyKey}"""

internal fun NanoHTTPD.Response.code(): Int = status.requestStatus

internal fun NanoHTTPD.Response.text(): String = data.readBytes().toString(Charsets.UTF_8)
