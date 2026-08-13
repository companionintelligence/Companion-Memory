package com.companionintelligence.localhub

import android.content.ContentValues
import android.content.Context
import android.database.Cursor
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import java.util.UUID

/** One row of the durable capture outbox. [payload] is only populated by single-item reads. */
data class OutboxItem(
    val id: String,
    val kind: String,
    val capturedAt: String,
    val seq: Long,
    val status: String,
    val attempts: Int,
    val lastError: String?,
    /** Raw JSON text exactly as it was enqueued, or `null` on projections that omit it. */
    val payload: String?,
)

/** Aggregate counts backing the `counts` block of `GET /api/outbox`. */
data class OutboxCounts(val pending: Int, val needsAttention: Int, val total: Int)

/**
 * Result of an enqueue attempt. [Duplicate] is what makes the enqueue endpoint idempotent:
 * a client that retries a POST it never saw the response to gets the original row back
 * rather than a second copy of the user's capture.
 */
sealed class EnqueueOutcome {
    data class Created(val item: OutboxItem) : EnqueueOutcome()

    data class Duplicate(val item: OutboxItem) : EnqueueOutcome()

    /** The queue is at [OutboxStore.MAX_ITEMS]; the caller must surface this, never drop the capture. */
    object AtCapacity : EnqueueOutcome()
}

/**
 * Durable, on-disk store behind the Local Hub's `/api/outbox` routes.
 *
 * **Durability is the entire point of this class**, so a few properties are load-bearing
 * rather than incidental:
 *
 * - Rows live in real SQLite in app-private internal storage (`/data/data/<pkg>/databases/`,
 *   via [SQLiteOpenHelper]'s standard naming), which the OS already isolates from other
 *   apps. Nothing is buffered in memory: [enqueue] commits its transaction before it
 *   returns, so a force-quit or reboot immediately after the HTTP 201 cannot lose the item.
 * - Ordering is strict FIFO by [COLUMN_SEQ], an `INTEGER PRIMARY KEY AUTOINCREMENT`. The
 *   `AUTOINCREMENT` keyword is deliberate: without it SQLite reuses the rowids of deleted
 *   rows, so after a successful flush drained the tail a new item could be handed a seq
 *   *lower* than one already issued and silently jump the queue. Ordering never consults
 *   the wall clock -- `capturedAt` is client time and can move backwards (NTP correction,
 *   manual clock change) without disturbing replay order.
 * - Capacity is a hard cap ([MAX_ITEMS]) that rejects, never evicts. Callers watch
 *   [WARN_AT] (80%) via the `capacity` block on the list endpoint so a full queue is a
 *   visible condition rather than a surprise.
 *
 * **Encryption at rest is deliberately NOT implemented in this pass.** The database is
 * plaintext SQLite protected only by Android's app sandbox + full-disk encryption. Wrapping
 * it in SQLCipher (with the key in the Android Keystore) is a follow-up slice -- see this
 * package's `README.md`. TODO(local-hub): SQLCipher-backed encryption at rest.
 *
 * **Threading**: the HTTP server hands requests to NanoHTTPD worker threads, so several
 * calls can land here at once. A single [SQLiteDatabase] instance is shared for the life of
 * this object ([SQLiteOpenHelper] caches it) rather than opening a connection per request;
 * that instance is internally synchronized. On top of that, every mutating method holds
 * [writeLock] for its whole read-then-write sequence, which is what actually makes
 * "check idempotency key, then insert" and "read attempts, then increment" atomic against
 * each other -- SQLite's own locking alone would let two enqueues of the same key both
 * observe "no existing row" before either inserts.
 */
class OutboxStore(
    context: Context,
    databaseName: String = DATABASE_NAME,
    /**
     * Hard cap on stored items. Overridable only so tests can actually drive the queue into
     * the full state and observe the 507 -- production always uses [MAX_ITEMS], and filling
     * 5000 rows over HTTP per test run would be slow enough that the capacity path would end
     * up untested instead.
     */
    val maxItems: Int = MAX_ITEMS,
) : SQLiteOpenHelper(context.applicationContext, databaseName, null, DATABASE_VERSION) {

    /** 80% of [maxItems]; reported to callers so queue pressure is visible before the wall. */
    val warnAt: Int = maxItems * 8 / 10

    private val writeLock = Any()

    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL(
            """
            CREATE TABLE $TABLE_NAME (
                $COLUMN_SEQ INTEGER PRIMARY KEY AUTOINCREMENT,
                $COLUMN_ID TEXT NOT NULL UNIQUE,
                $COLUMN_KIND TEXT NOT NULL,
                $COLUMN_PAYLOAD TEXT NOT NULL,
                $COLUMN_CAPTURED_AT TEXT NOT NULL,
                $COLUMN_IDEMPOTENCY_KEY TEXT NOT NULL UNIQUE,
                $COLUMN_STATUS TEXT NOT NULL,
                $COLUMN_ATTEMPTS INTEGER NOT NULL DEFAULT 0,
                $COLUMN_LAST_ERROR TEXT
            )
            """.trimIndent(),
        )
        // The flusher's hot query is "oldest pending item(s) first"; this index serves both
        // that and the status-filtered list without a sort step.
        db.execSQL("CREATE INDEX ${TABLE_NAME}_status_seq ON $TABLE_NAME ($COLUMN_STATUS, $COLUMN_SEQ)")
    }

    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        // v1 is the first schema. Future versions MUST migrate rather than drop: this table
        // holds user captures that have not reached the server yet, so a destructive upgrade
        // would be exactly the silent data loss the whole design exists to prevent.
        throw IllegalStateException("No outbox migration path from $oldVersion to $newVersion")
    }

    /**
     * Commits one item and returns it, or reports [EnqueueOutcome.Duplicate] for a replayed
     * [idempotencyKey] / [EnqueueOutcome.AtCapacity] when the queue is full.
     *
     * [capturedAt] is stored verbatim: it is the *client's* capture time and must never be
     * replaced with server/device-receive time, or the timeline the user sees would shift
     * whenever a capture sat in the queue.
     */
    fun enqueue(
        kind: String,
        payloadJson: String,
        capturedAt: String,
        idempotencyKey: String,
    ): EnqueueOutcome = synchronized(writeLock) {
        val db = writableDatabase
        db.beginTransactionNonExclusive()
        try {
            val existing = queryOne(db, "$COLUMN_IDEMPOTENCY_KEY = ?", idempotencyKey, includePayload = true)
            if (existing != null) {
                db.setTransactionSuccessful()
                return EnqueueOutcome.Duplicate(existing)
            }

            if (countWhere(db, null) >= maxItems) {
                db.setTransactionSuccessful()
                return EnqueueOutcome.AtCapacity
            }

            val values = ContentValues().apply {
                put(COLUMN_ID, UUID.randomUUID().toString())
                put(COLUMN_KIND, kind)
                put(COLUMN_PAYLOAD, payloadJson)
                put(COLUMN_CAPTURED_AT, capturedAt)
                put(COLUMN_IDEMPOTENCY_KEY, idempotencyKey)
                put(COLUMN_STATUS, STATUS_PENDING)
                put(COLUMN_ATTEMPTS, 0)
            }
            // seq is an INTEGER PRIMARY KEY, so it aliases the rowid insert() returns.
            val seq = db.insertOrThrow(TABLE_NAME, null, values)
            val created = queryOne(db, "$COLUMN_SEQ = ?", seq.toString(), includePayload = true)
                ?: throw IllegalStateException("Outbox row $seq vanished immediately after insert")

            db.setTransactionSuccessful()
            return EnqueueOutcome.Created(created)
        } finally {
            // endTransaction() is what fsyncs the commit -- it runs before the HTTP response
            // is written, which is the durability guarantee the contract advertises.
            db.endTransaction()
        }
    }

    /** Oldest-first (FIFO) list. [statusFilter] of `null` means every status. Payloads omitted. */
    fun list(statusFilter: String?): List<OutboxItem> {
        val db = readableDatabase
        val cursor = db.query(
            TABLE_NAME,
            LIST_COLUMNS,
            statusFilter?.let { "$COLUMN_STATUS = ?" },
            statusFilter?.let { arrayOf(it) },
            null,
            null,
            "$COLUMN_SEQ ASC",
        )
        return cursor.use {
            buildList {
                while (it.moveToNext()) {
                    add(readItem(it, includePayload = false))
                }
            }
        }
    }

    /** One item *including* its payload, or `null` if [id] is unknown. */
    fun get(id: String): OutboxItem? = queryOne(readableDatabase, "$COLUMN_ID = ?", id, includePayload = true)

    /** Removes one item. Returns false if [id] was already gone. */
    fun delete(id: String): Boolean = synchronized(writeLock) {
        writableDatabase.delete(TABLE_NAME, "$COLUMN_ID = ?", arrayOf(id)) > 0
    }

    /**
     * Records a failed flush attempt: increments `attempts`, stores [error], and moves the
     * item to [STATUS_NEEDS_ATTENTION] if [permanent] is set or the retry budget
     * ([MAX_ATTEMPTS]) is exhausted. Returns the updated item, or `null` if [id] is unknown.
     *
     * A `needs_attention` row is never deleted here -- surfacing it to the user is the whole
     * point, so the only ways out are an explicit retry ([retry]) or an explicit discard
     * ([delete]).
     */
    fun recordFailedAttempt(id: String, error: String, permanent: Boolean): OutboxItem? = synchronized(writeLock) {
        val db = writableDatabase
        db.beginTransactionNonExclusive()
        try {
            val existing = queryOne(db, "$COLUMN_ID = ?", id, includePayload = false)
            if (existing == null) {
                db.setTransactionSuccessful()
                return null
            }

            val attempts = existing.attempts + 1
            val status = if (permanent || attempts >= MAX_ATTEMPTS) STATUS_NEEDS_ATTENTION else STATUS_PENDING
            val values = ContentValues().apply {
                put(COLUMN_ATTEMPTS, attempts)
                put(COLUMN_STATUS, status)
                put(COLUMN_LAST_ERROR, error)
            }
            db.update(TABLE_NAME, values, "$COLUMN_ID = ?", arrayOf(id))
            val updated = queryOne(db, "$COLUMN_ID = ?", id, includePayload = false)

            db.setTransactionSuccessful()
            return updated
        } finally {
            db.endTransaction()
        }
    }

    /**
     * Puts an item back in the pending queue with a fresh retry budget. Applied to any
     * existing item (not only `needs_attention` ones) so it is idempotent. `lastError` is
     * deliberately kept: it is the only record of why the item stalled, and the next failed
     * attempt overwrites it anyway.
     */
    fun retry(id: String): OutboxItem? = synchronized(writeLock) {
        val db = writableDatabase
        db.beginTransactionNonExclusive()
        try {
            val values = ContentValues().apply {
                put(COLUMN_STATUS, STATUS_PENDING)
                put(COLUMN_ATTEMPTS, 0)
            }
            val updatedRows = db.update(TABLE_NAME, values, "$COLUMN_ID = ?", arrayOf(id))
            val updated = if (updatedRows > 0) queryOne(db, "$COLUMN_ID = ?", id, includePayload = false) else null

            db.setTransactionSuccessful()
            return updated
        } finally {
            db.endTransaction()
        }
    }

    fun counts(): OutboxCounts {
        val db = readableDatabase
        val pending = countWhere(db, STATUS_PENDING)
        val needsAttention = countWhere(db, STATUS_NEEDS_ATTENTION)
        // Counted rather than summed so a row in some future status can't make total lie.
        return OutboxCounts(pending = pending, needsAttention = needsAttention, total = countWhere(db, null))
    }

    private fun countWhere(db: SQLiteDatabase, status: String?): Int {
        val sql = buildString {
            append("SELECT COUNT(*) FROM $TABLE_NAME")
            if (status != null) append(" WHERE $COLUMN_STATUS = ?")
        }
        val statement = db.compileStatement(sql)
        return statement.use {
            if (status != null) it.bindString(1, status)
            it.simpleQueryForLong().toInt()
        }
    }

    private fun queryOne(
        db: SQLiteDatabase,
        selection: String,
        selectionArg: String,
        includePayload: Boolean,
    ): OutboxItem? {
        val cursor = db.query(
            TABLE_NAME,
            if (includePayload) FULL_COLUMNS else LIST_COLUMNS,
            selection,
            arrayOf(selectionArg),
            null,
            null,
            null,
            "1",
        )
        return cursor.use { if (it.moveToFirst()) readItem(it, includePayload) else null }
    }

    private fun readItem(cursor: Cursor, includePayload: Boolean): OutboxItem =
        OutboxItem(
            id = cursor.getString(cursor.getColumnIndexOrThrow(COLUMN_ID)),
            kind = cursor.getString(cursor.getColumnIndexOrThrow(COLUMN_KIND)),
            capturedAt = cursor.getString(cursor.getColumnIndexOrThrow(COLUMN_CAPTURED_AT)),
            seq = cursor.getLong(cursor.getColumnIndexOrThrow(COLUMN_SEQ)),
            status = cursor.getString(cursor.getColumnIndexOrThrow(COLUMN_STATUS)),
            attempts = cursor.getInt(cursor.getColumnIndexOrThrow(COLUMN_ATTEMPTS)),
            lastError = cursor.getColumnIndex(COLUMN_LAST_ERROR)
                .takeIf { it >= 0 && !cursor.isNull(it) }
                ?.let { cursor.getString(it) },
            payload = if (includePayload) cursor.getString(cursor.getColumnIndexOrThrow(COLUMN_PAYLOAD)) else null,
        )

    companion object {
        const val DATABASE_NAME = "ci_local_hub_outbox.db"
        private const val DATABASE_VERSION = 1

        const val TABLE_NAME = "outbox"

        const val COLUMN_SEQ = "seq"
        const val COLUMN_ID = "id"
        const val COLUMN_KIND = "kind"
        const val COLUMN_PAYLOAD = "payload"
        const val COLUMN_CAPTURED_AT = "captured_at"
        const val COLUMN_IDEMPOTENCY_KEY = "idempotency_key"
        const val COLUMN_STATUS = "status"
        const val COLUMN_ATTEMPTS = "attempts"
        const val COLUMN_LAST_ERROR = "last_error"

        const val STATUS_PENDING = "pending"
        const val STATUS_NEEDS_ATTENTION = "needs_attention"

        /** Failed attempts tolerated before an item stops retrying and becomes user-visible. */
        const val MAX_ATTEMPTS = 5

        /**
         * Production hard cap. Enqueue returns HTTP 507 at this many rows -- it never evicts
         * an older capture to make room, because the older capture is also user data nobody
         * agreed to lose.
         */
        const val MAX_ITEMS = 5000

        private val LIST_COLUMNS = arrayOf(
            COLUMN_SEQ,
            COLUMN_ID,
            COLUMN_KIND,
            COLUMN_CAPTURED_AT,
            COLUMN_STATUS,
            COLUMN_ATTEMPTS,
            COLUMN_LAST_ERROR,
        )

        private val FULL_COLUMNS = LIST_COLUMNS + COLUMN_PAYLOAD
    }
}
