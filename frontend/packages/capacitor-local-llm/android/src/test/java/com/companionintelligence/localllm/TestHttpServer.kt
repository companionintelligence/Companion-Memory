package com.companionintelligence.localllm

import java.io.BufferedOutputStream
import java.io.Closeable
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.Collections
import kotlin.concurrent.thread

/**
 * A real HTTP server on loopback, used instead of a mocked client.
 *
 * Everything worth testing in this module's network code lives *below* the client object —
 * the exact request path (`/api/intents`), the `Range` header a resumed download sends,
 * whether a `Mcp-Session-Id` is echoed on the second call, whether a 206 body is appended or
 * overwritten. A mock of `CompanionIntentClient` or `HttpURLConnection` would assert that we
 * asked for those things in the shape we already believe; a socket asserts what actually goes
 * over the wire.
 *
 * It is hand-rolled on [ServerSocket] rather than built on the JDK's `com.sun.net.httpserver`
 * or on MockWebServer. `com.sun.net.httpserver` is not an option here even though the tests
 * fork a real JVM: the Kotlin Android plugin compiles unit tests with `-no-jdk`, so the compile
 * classpath is `android.jar` plus this module's dependencies and nothing from `jdk.httpserver`
 * resolves (`android.jar` carries `java.net.ServerSocket`, but nothing under `com.sun.net.httpserver`).
 * MockWebServer would be a new dependency and still would not give the handlers direct control
 * over the status line, `Content-Range`/`Mcp-Session-Id` headers and chunked framing that these
 * tests set by hand. The subset of HTTP/1.1 implemented below is exactly what the production
 * `HttpURLConnection` callers exercise; anything more would be untested test code.
 *
 * One request per connection, answered with `Connection: close` — the production clients open a
 * fresh connection per call anyway, and it keeps the framing unambiguous. Robolectric does not
 * instrument `java.net.*`, so this works unchanged inside the sandbox.
 */
class TestHttpServer(
    private val handler: (TestExchange, RecordedRequest) -> Unit,
) : Closeable {

    private val server = ServerSocket(0, 50, InetAddress.getByName("127.0.0.1"))

    /** Every request the server saw, in order. Synchronized: handlers run on the server's thread. */
    val requests: MutableList<RecordedRequest> = Collections.synchronizedList(mutableListOf())

    @Volatile
    private var closed = false

    private val acceptor =
        thread(isDaemon = true, name = "TestHttpServer-${server.localPort}") {
            while (!closed) {
                val socket =
                    try {
                        server.accept()
                    } catch (e: IOException) {
                        // close() closes the ServerSocket out from under accept(); that is the
                        // only way this loop is meant to end.
                        return@thread
                    }

                // Serve on the accepting thread: every test is a single client issuing one call
                // at a time, and serialising here means `requests` is ordered by arrival with no
                // further synchronisation.
                serve(socket)
            }
        }

    val port: Int
        get() = server.localPort

    val baseUrl: String
        get() = "http://127.0.0.1:$port"

    override fun close() {
        closed = true
        server.close()
        acceptor.join(SHUTDOWN_TIMEOUT_MS)
    }

    private fun serve(socket: Socket) {
        try {
            socket.use {
                // A handler that never responds, or a client that never finishes its body, must
                // fail the test rather than hang the build forever.
                socket.soTimeout = READ_TIMEOUT_MS

                val input = socket.getInputStream().buffered()
                val output = BufferedOutputStream(socket.getOutputStream())
                val recorded = readRequest(input) ?: return
                requests.add(recorded)

                val exchange = TestExchange(output)
                try {
                    handler(exchange, recorded)
                } finally {
                    exchange.finish()
                    output.flush()
                }
            }
        } catch (e: IOException) {
            // A client that hangs up without draining the body (`HttpURLConnection` does exactly
            // that for an error status it only reads the code of) surfaces here as a broken pipe.
            // The assertion the test cares about has already been recorded.
        } catch (e: Throwable) {
            // A handler that throws (a malformed frame reaching `JSONObject`, say) must not take
            // the accept loop down with it: the client would then block until its read timeout and
            // the test would report a hang instead of the real fault. `finish()` has already put a
            // 500 on the wire, so the assertion fails immediately; this makes the cause visible.
            e.printStackTrace()
        }
    }

    private fun readRequest(input: InputStream): RecordedRequest? {
        val requestLine = readAsciiLine(input) ?: return null
        val parts = requestLine.split(' ')
        if (parts.size < 2) {
            return null
        }

        val headers = LinkedHashMap<String, MutableList<String>>()
        while (true) {
            val line = readAsciiLine(input) ?: break
            if (line.isEmpty()) {
                break
            }

            val separator = line.indexOf(':')
            if (separator <= 0) {
                continue
            }

            // Lower-cased so assertions do not depend on how the client capitalises a header;
            // HTTP header names are case-insensitive anyway.
            val name = line.substring(0, separator).trim().lowercase()
            headers.getOrPut(name) { mutableListOf() }.add(line.substring(separator + 1).trim())
        }

        // Both production callers hand `HttpURLConnection` a fully-buffered body (no
        // `setChunkedStreamingMode`), so a request body always arrives with a Content-Length.
        val declaredLength = headers["content-length"]?.firstOrNull()?.toIntOrNull() ?: 0
        val body = ByteArray(declaredLength)
        var read = 0
        while (read < declaredLength) {
            val n = input.read(body, read, declaredLength - read)
            if (n == -1) {
                break
            }
            read += n
        }

        return RecordedRequest(
            method = parts[0],
            path = parts[1],
            headers = headers.mapValues { it.value.toList() },
            body = String(body, 0, read, Charsets.UTF_8),
        )
    }

    /** Reads one CRLF-terminated line as ASCII, byte at a time so no request body is swallowed. */
    private fun readAsciiLine(input: InputStream): String? {
        val line = StringBuilder()
        while (true) {
            val b = input.read()
            if (b == -1) {
                return if (line.isEmpty()) null else line.toString()
            }
            if (b == '\n'.code) {
                return line.toString().removeSuffix("\r")
            }
            line.append(b.toChar())
        }
    }

    companion object {
        private const val READ_TIMEOUT_MS = 10_000
        private const val SHUTDOWN_TIMEOUT_MS = 5_000L

        /** A base URL nothing is listening on — bound to claim a port, then released. */
        fun unreachableBaseUrl(): String {
            val server = TestHttpServer { _, _ -> }
            val url = server.baseUrl
            server.close()

            return url
        }
    }
}

class RecordedRequest(
    val method: String,
    /** Path plus query exactly as it appeared on the request line. */
    val path: String,
    /** Request headers, keys lower-cased. */
    val headers: Map<String, List<String>>,
    val body: String,
)

/** Response headers a handler adds before responding, in the order it added them. */
class TestHeaders {
    private val entries = mutableListOf<Pair<String, String>>()

    fun add(name: String, value: String) {
        entries.add(name to value)
    }

    internal fun all(): List<Pair<String, String>> = entries.toList()
}

/**
 * The server side of one request: extra headers to send, and the response stream.
 *
 * Mirrors the slice of `com.sun.net.httpserver.HttpExchange` the tests used, including
 * `sendResponseHeaders`'s convention that a length of 0 means "streamed, length unknown".
 */
class TestExchange internal constructor(private val output: OutputStream) {

    val responseHeaders = TestHeaders()

    private var headersSent = false
    private var body: OutputStream? = null

    /**
     * [contentLength] > 0 sends that `Content-Length`; 0 switches to `Transfer-Encoding: chunked`
     * (which is what makes `HttpURLConnection.contentLengthLong` return -1 on the client);
     * negative sends no body at all.
     */
    fun sendResponseHeaders(status: Int, contentLength: Long) {
        check(!headersSent) { "response headers were already sent" }
        headersSent = true

        val head = StringBuilder("HTTP/1.1 $status ${reasonPhrase(status)}\r\n")
        responseHeaders.all().forEach { head.append("${it.first}: ${it.second}\r\n") }

        val chunked = contentLength == 0L
        if (chunked) {
            head.append("Transfer-Encoding: chunked\r\n")
        } else {
            head.append("Content-Length: ${maxOf(contentLength, 0L)}\r\n")
        }
        head.append("Connection: close\r\n\r\n")

        output.write(head.toString().toByteArray(Charsets.US_ASCII))
        body = if (chunked) ChunkedOutputStream(output) else output
    }

    val responseBody: OutputStream
        get() = body ?: error("sendResponseHeaders() must be called before writing a response body")

    /** Terminates a chunked body and flushes. Called for every exchange, responded to or not. */
    internal fun finish() {
        if (!headersSent) {
            sendResponseHeaders(500, -1)
        }
        (body as? ChunkedOutputStream)?.finish()
        output.flush()
    }

    private fun reasonPhrase(status: Int): String =
        when (status) {
            200 -> "OK"
            206 -> "Partial Content"
            404 -> "Not Found"
            500 -> "Internal Server Error"
            else -> "Status $status"
        }
}

/** Writes each `write` as one HTTP/1.1 chunk, and the terminating zero-chunk on [finish]. */
private class ChunkedOutputStream(private val sink: OutputStream) : OutputStream() {

    private var finished = false

    override fun write(b: Int) = write(byteArrayOf(b.toByte()), 0, 1)

    override fun write(b: ByteArray, off: Int, len: Int) {
        if (len == 0) {
            // A zero-length chunk would terminate the body early.
            return
        }

        sink.write("${len.toString(16)}\r\n".toByteArray(Charsets.US_ASCII))
        sink.write(b, off, len)
        sink.write("\r\n".toByteArray(Charsets.US_ASCII))
    }

    override fun flush() = sink.flush()

    fun finish() {
        if (finished) {
            return
        }
        finished = true
        sink.write("0\r\n\r\n".toByteArray(Charsets.US_ASCII))
        sink.flush()
    }
}

/** Responds with an explicit `Content-Length`. */
fun TestExchange.respond(status: Int, body: ByteArray) {
    sendResponseHeaders(status, body.size.toLong())
    responseBody.write(body)
    responseBody.flush()
}

fun TestExchange.respond(status: Int, body: String) = respond(status, body.toByteArray(Charsets.UTF_8))

/**
 * Responds with `Transfer-Encoding: chunked` — a length of 0 in `sendResponseHeaders` is the
 * "streamed, length unknown" convention, which is what makes
 * `HttpURLConnection.contentLengthLong` return -1 on the client.
 */
fun TestExchange.respondChunked(status: Int, body: ByteArray) {
    sendResponseHeaders(status, 0)
    responseBody.write(body)
    responseBody.flush()
}
