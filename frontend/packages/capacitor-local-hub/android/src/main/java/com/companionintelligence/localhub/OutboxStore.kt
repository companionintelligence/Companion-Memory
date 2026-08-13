package com.companionintelligence.localhub

import android.content.ContentValues
import android.content.Context
import android.database.Cursor
import java.io.File
import java.io.IOException
import java.io.RandomAccessFile
import java.security.SecureRandom
import java.util.UUID
import net.zetetic.database.DatabaseErrorHandler
import net.zetetic.database.sqlcipher.SQLiteDatabase
import net.zetetic.database.sqlcipher.SQLiteDatabase.CursorFactory
import net.zetetic.database.sqlcipher.SQLiteDatabaseHook
import net.zetetic.database.sqlcipher.SQLiteOpenHelper
import android.database.sqlite.SQLiteDatabase as PlaintextSQLiteDatabase
import android.database.sqlite.SQLiteException as PlaintextSQLiteException

/**
 * Loads `libsqlcipher.so` exactly once, before anything can reach a SQLCipher native entry
 * point.
 *
 * `sqlcipher-android` ships its own SQLite + crypto in that library and, unlike the legacy
 * `net.sqlcipher` artifact, provides no `SQLiteDatabase.loadLibs(context)` helper -- the caller
 * is responsible for the `System.loadLibrary` call. A `by lazy` holder rather than a companion
 * `init` because Kotlin `const val`s are inlined at their use sites and therefore never trigger
 * companion initialisation, which would leave the load happening at an unpredictable moment.
 */
private object SqlCipherLibrary {
    private val loaded: Unit by lazy { System.loadLibrary("sqlcipher") }

    fun ensureLoaded() = loaded
}

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
 * Durable, **encrypted**, on-disk store behind the Local Hub's `/api/outbox` routes.
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
 * ### Encryption at rest
 *
 * The database file is **SQLCipher (AES-256)**, not plain SQLite. The base class is
 * `net.zetetic.database.sqlcipher.SQLiteOpenHelper`; everything else about this class --
 * the schema, the FIFO/`AUTOINCREMENT` semantics, the [writeLock] discipline, the
 * transaction boundaries -- is unchanged by that swap, which is why the swap was chosen over
 * a rewrite.
 *
 * The key is 32 bytes of `SecureRandom` held in the AndroidKeyStore-wrapped
 * [CompanionSecureStore], passed to SQLCipher as a raw key so no PBKDF2 runs; see
 * [OutboxDatabaseKey]. If that key cannot be produced, **construction throws** -- there is no
 * unencrypted fallback, so `LocalHubPlugin.start()` fails visibly rather than quietly writing
 * user captures in the clear.
 *
 * **What this does and does not protect.** It protects the file at rest: an attacker with
 * filesystem access (a rooted device, a forensic image, a recovered flash page) sees
 * ciphertext, and destroying the keystore entry makes every copy of the file permanently
 * unopenable. It does **not** protect a running, unlocked app -- once the sidecar has opened
 * the database, anything with code execution inside this process can read the rows, and the
 * loopback HTTP surface still answers to whoever holds the per-launch bearer token.
 *
 * ### Threading
 *
 * The HTTP server hands requests to NanoHTTPD worker threads, so several calls can land here
 * at once. A single [SQLiteDatabase] instance is shared for the life of this object
 * ([SQLiteOpenHelper] caches it) rather than opening a connection per request; that instance
 * is internally synchronized. On top of that, every mutating method holds [writeLock] for its
 * whole read-then-write sequence, which is what actually makes "check idempotency key, then
 * insert" and "read attempts, then increment" atomic against each other -- SQLite's own
 * locking alone would let two enqueues of the same key both observe "no existing row" before
 * either inserts.
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
    /**
     * Plaintext database left behind by a pre-encryption install, imported and then shredded
     * on first open. `null` disables the import entirely (used by tests that want a store with
     * no legacy history); the name is a parameter so tests can drive a real migration without
     * touching the production file.
     */
    private val legacyPlaintextDatabaseName: String? = LEGACY_PLAINTEXT_DATABASE_NAME,
    keyProvider: OutboxDatabaseKey = OutboxDatabaseKey(CompanionSecureStore.outboxKeys(context)),
) : SQLiteOpenHelper(
    context.applicationContext,
    databaseName,
    // Evaluated before the base class opens anything, so a keystore failure prevents the
    // database from existing at all rather than producing an unencrypted one.
    keyProvider.rawKeySpec(context.applicationContext.getDatabasePath(databaseName)),
    null as CursorFactory?,
    DATABASE_VERSION,
    // minimumSupportedVersion: 0 on purpose. A non-zero value tells the base class to DELETE
    // and recreate any database older than it -- exactly the silent data loss onUpgrade
    // refuses to perform.
    0,
    null as DatabaseErrorHandler?,
    null as SQLiteDatabaseHook?,
    // Write-ahead logging left off, matching the pre-encryption behaviour: the queue's write
    // rate is low and rollback-journal mode keeps `synchronous = FULL` semantics on commit.
    false,
) {

    /** 80% of [maxItems]; reported to callers so queue pressure is visible before the wall. */
    val warnAt: Int = maxItems * 8 / 10

    private val appContext = context.applicationContext
    private val legacyDatabaseFile: File? =
        legacyPlaintextDatabaseName?.let { appContext.getDatabasePath(it) }

    private val writeLock = Any()
    private val migrationLock = Any()

    @Volatile
    private var legacyImportComplete = false

    /**
     * Opens the database (creating it, and importing any plaintext predecessor, on first call)
     * and returns the live handle.
     *
     * Called eagerly by `LocalHubPlugin.start()` so that a missing key, a corrupt database, or
     * a failed migration is a visible start failure rather than a surprise on the first
     * capture -- and so the disk I/O is not paid for by a NanoHTTPD worker mid-request.
     */
    fun open(): SQLiteDatabase = database()

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

    /**
     * v1 is the first schema *of the encrypted database*, which is a different file from the
     * plaintext one ([LEGACY_PLAINTEXT_DATABASE_NAME]) -- the plaintext -> encrypted cutover is
     * a file-level import in [importLegacyPlaintextOutbox], not a `SQLiteOpenHelper` version
     * step, because the plain driver cannot open a SQLCipher file at all and vice versa.
     *
     * So this stays at v1 and still refuses to run: this table holds user captures that have
     * not reached the server yet, so a destructive upgrade would be exactly the silent data
     * loss the whole design exists to prevent. Future versions MUST migrate rather than drop.
     */
    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
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
        val db = database()
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
        val db = database()
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
    fun get(id: String): OutboxItem? = queryOne(database(), "$COLUMN_ID = ?", id, includePayload = true)

    /** Removes one item. Returns false if [id] was already gone. */
    fun delete(id: String): Boolean = synchronized(writeLock) {
        database().delete(TABLE_NAME, "$COLUMN_ID = ?", arrayOf(id)) > 0
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
        val db = database()
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
        val db = database()
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
        val db = database()
        val pending = countWhere(db, STATUS_PENDING)
        val needsAttention = countWhere(db, STATUS_NEEDS_ATTENTION)
        // Counted rather than summed so a row in some future status can't make total lie.
        return OutboxCounts(pending = pending, needsAttention = needsAttention, total = countWhere(db, null))
    }

    // ------------------------------------------------------------------ plaintext -> encrypted

    /**
     * Every read/write goes through here so the one-time import of a pre-encryption plaintext
     * database happens before any caller can observe an empty queue.
     */
    private fun database(): SQLiteDatabase {
        SqlCipherLibrary.ensureLoaded()
        val db = writableDatabase
        if (!legacyImportComplete) {
            synchronized(migrationLock) {
                if (!legacyImportComplete) {
                    importLegacyPlaintextOutbox(db)
                    legacyImportComplete = true
                }
            }
        }
        return db
    }

    /**
     * Copies every row of a pre-encryption plaintext outbox into [db], then shreds the
     * plaintext file.
     *
     * Order of operations is the whole safety argument: the copy commits **first**, and only
     * a committed copy is followed by the overwrite-and-delete. If anything throws, the
     * plaintext file is left exactly where it was and the failure propagates out of
     * `LocalHubPlugin.start()` -- a visible, retryable error rather than a queue that came
     * back mysteriously empty. These rows have never reached any server; losing them here
     * would be precisely the failure the outbox exists to prevent.
     */
    private fun importLegacyPlaintextOutbox(db: SQLiteDatabase) {
        val legacy = legacyDatabaseFile ?: return
        if (!legacy.exists()) {
            return
        }

        // The try covers only the open, so a failure while *copying* propagates with its own
        // message instead of being relabelled as an open failure. Either way the plaintext file
        // survives -- the shred below is unreachable unless the copy committed.
        val plaintext = try {
            // OPEN_READWRITE rather than OPEN_READONLY: a hot rollback journal from an
            // interrupted write can only be replayed by a writable open, and a read-only open
            // would simply fail on a file that is perfectly recoverable.
            PlaintextSQLiteDatabase.openDatabase(
                legacy.path,
                null,
                PlaintextSQLiteDatabase.OPEN_READWRITE,
            )
        } catch (e: PlaintextSQLiteException) {
            throw IllegalStateException(
                "Could not open the plaintext outbox at ${legacy.name} to migrate it; " +
                    "refusing to continue rather than abandon queued captures",
                e,
            )
        }

        plaintext.use { copyLegacyRows(it, db) }

        shred(legacy)
    }

    private fun copyLegacyRows(from: PlaintextSQLiteDatabase, to: SQLiteDatabase) {
        if (!legacyTableExists(from)) {
            return
        }

        // On the normal path the destination is a brand-new empty table, so seq values carry
        // over exactly and replay order is preserved to the row. If the destination somehow
        // already holds rows (a previous import that committed but died before the shred), let
        // AUTOINCREMENT assign fresh seqs instead: reusing an explicit seq that is now taken
        // would make CONFLICT_IGNORE silently drop the legacy row.
        val preserveSeq = countWhere(to, null) == 0

        to.beginTransactionNonExclusive()
        try {
            from.query(TABLE_NAME, MIGRATION_COLUMNS, null, null, null, null, "$COLUMN_SEQ ASC").use { cursor ->
                while (cursor.moveToNext()) {
                    val values = ContentValues().apply {
                        if (preserveSeq) {
                            put(COLUMN_SEQ, cursor.getLong(cursor.getColumnIndexOrThrow(COLUMN_SEQ)))
                        }
                        put(COLUMN_ID, cursor.getString(cursor.getColumnIndexOrThrow(COLUMN_ID)))
                        put(COLUMN_KIND, cursor.getString(cursor.getColumnIndexOrThrow(COLUMN_KIND)))
                        put(COLUMN_PAYLOAD, cursor.getString(cursor.getColumnIndexOrThrow(COLUMN_PAYLOAD)))
                        put(COLUMN_CAPTURED_AT, cursor.getString(cursor.getColumnIndexOrThrow(COLUMN_CAPTURED_AT)))
                        put(
                            COLUMN_IDEMPOTENCY_KEY,
                            cursor.getString(cursor.getColumnIndexOrThrow(COLUMN_IDEMPOTENCY_KEY)),
                        )
                        put(COLUMN_STATUS, cursor.getString(cursor.getColumnIndexOrThrow(COLUMN_STATUS)))
                        put(COLUMN_ATTEMPTS, cursor.getInt(cursor.getColumnIndexOrThrow(COLUMN_ATTEMPTS)))
                        val errorIndex = cursor.getColumnIndexOrThrow(COLUMN_LAST_ERROR)
                        if (!cursor.isNull(errorIndex)) {
                            put(COLUMN_LAST_ERROR, cursor.getString(errorIndex))
                        }
                    }
                    // CONFLICT_IGNORE keys off the UNIQUE id / idempotency_key columns, which
                    // makes a re-run of a partially completed import a no-op rather than a
                    // constraint failure.
                    to.insertWithOnConflict(TABLE_NAME, null, values, SQLiteDatabase.CONFLICT_IGNORE)
                }
            }
            to.setTransactionSuccessful()
        } finally {
            to.endTransaction()
        }
    }

    private fun legacyTableExists(db: PlaintextSQLiteDatabase): Boolean {
        val cursor = db.rawQuery(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
            arrayOf(TABLE_NAME),
        )
        return cursor.use { it.moveToFirst() }
    }

    /**
     * Overwrites a file's bytes before unlinking it. `File.delete()` only detaches the inode --
     * the pages stay on flash until they happen to be reused, which for a database that held
     * unencrypted user captures is the difference between "deleted" and "recoverable".
     *
     * Best-effort by nature: wear-levelling means the controller may write the overwrite to a
     * fresh block and leave the original untouched. It is the right gesture, not a guarantee,
     * and it is the reason encryption-at-rest -- not deletion -- is the control this design
     * actually leans on.
     */
    private fun shred(databaseFile: File) {
        for (file in listOf(
            File(databaseFile.path + "-journal"),
            File(databaseFile.path + "-wal"),
            File(databaseFile.path + "-shm"),
            databaseFile,
        )) {
            overwrite(file)
            file.delete()
        }
    }

    private fun overwrite(file: File) {
        if (!file.exists() || file.length() == 0L) {
            return
        }
        try {
            // "rws" writes through to the device rather than the page cache.
            RandomAccessFile(file, "rws").use { handle ->
                val length = handle.length()
                val buffer = ByteArray(SHRED_BUFFER_BYTES)
                SecureRandom().nextBytes(buffer)
                handle.seek(0)
                var written = 0L
                while (written < length) {
                    val chunk = minOf(buffer.size.toLong(), length - written).toInt()
                    handle.write(buffer, 0, chunk)
                    written += chunk
                }
                handle.fd.sync()
            }
        } catch (e: IOException) {
            // Nothing actionable: the delete below is still worth doing.
        }
    }

    // ------------------------------------------------------------------ queries

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
        /** The SQLCipher-encrypted database. */
        const val DATABASE_NAME = "ci_local_hub_outbox_enc.db"

        /**
         * The plaintext database shipped before encryption landed. Imported into
         * [DATABASE_NAME] and shredded on first open; a fresh install never has one.
         */
        const val LEGACY_PLAINTEXT_DATABASE_NAME = "ci_local_hub_outbox.db"

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

        private const val SHRED_BUFFER_BYTES = 64 * 1024

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

        /** Everything, including the idempotency key, which the API projections never expose. */
        private val MIGRATION_COLUMNS = FULL_COLUMNS + COLUMN_IDEMPOTENCY_KEY
    }
}
