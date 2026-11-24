package com.companionintelligence.localllm.intents

import android.content.Context
import android.util.Log
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import net.zetetic.database.sqlcipher.SQLiteDatabase
import java.io.File

/**
 * Reads the phone's PowerSync replica, which the Capacitor SQLite plugin keeps SQLCipher-encrypted.
 *
 * The key is the plugin's: it stores the passphrase in its own `EncryptedSharedPreferences` file
 * (`sqlite_encrypted_shared_prefs`, under the key `secret`, with the AndroidX master key —
 * `CapacitorSQLite.java` / `UtilsSQLCipher.java` in `@capacitor-community/sqlite`), and this reads
 * it back the same way. That couples this class to a third party's internals, so
 * `SqliteReplicaDriftTest` pins the file name, the key name and the file suffix against the vendored
 * plugin source and fails the build if they move.
 *
 * Opened read-only and closed after every call: the WebView holds the writing connection, and a
 * second long-lived handle would contend with its checkpoints. Nothing here is cached beyond one
 * call, so a replica that was just created, re-keyed or wiped is seen as it is on the next one.
 */
class LocalSearchStore(private val context: Context, private val databaseFile: String = LocalSearch.DEFAULT_DATABASE_FILE) :
    LocalSearchSource {

    private val file: File
        get() = context.getDatabasePath(databaseFile)

    override fun isAvailable(): Boolean = file.isFile && !passphrase().isNullOrEmpty()

    override fun rows(sql: String, params: List<String>): List<LocalSearchRow> =
        open().use { db ->
            db.rawQuery(sql, params.toTypedArray()).use { cursor ->
                buildList {
                    while (cursor.moveToNext()) {
                        add(
                            LocalSearchRow(
                                entityType = cursor.getString(0),
                                entityId = cursor.getString(1),
                                title = cursor.getString(2),
                                body = cursor.getString(3),
                                occurredAt = cursor.getString(4),
                                detail = cursor.getString(5),
                            ),
                        )
                    }
                }
            }
        }

    override fun count(sql: String, params: List<String>): Int =
        open().use { db ->
            db.rawQuery(sql, params.toTypedArray()).use { cursor ->
                if (cursor.moveToFirst()) cursor.getInt(0) else 0
            }
        }

    private fun open(): SQLiteDatabase {
        val key = passphrase() ?: throw IllegalStateException("The replica's key is not stored on this phone")

        loadNativeLibrary()

        return SQLiteDatabase.openDatabase(file.absolutePath, key, null, SQLiteDatabase.OPEN_READONLY, null)
    }

    private fun passphrase(): String? =
        try {
            val masterKey = MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build()
            val prefs =
                EncryptedSharedPreferences.create(
                    context,
                    PREFS_FILE,
                    masterKey,
                    EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                    EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
                )

            prefs.getString(PREFS_KEY, null)
        } catch (e: Exception) {
            Log.w(TAG, "Could not read the replica's key", e)
            null
        }

    companion object {
        private const val TAG = "LocalSearchStore"

        /** The SQLite plugin's preferences file and the key its passphrase sits under. Pinned by `SqliteReplicaDriftTest`. */
        const val PREFS_FILE = "sqlite_encrypted_shared_prefs"
        const val PREFS_KEY = "secret"

        @Volatile
        private var nativeLoaded = false

        private fun loadNativeLibrary() {
            if (!nativeLoaded) {
                synchronized(this) {
                    if (!nativeLoaded) {
                        System.loadLibrary("sqlcipher")
                        nativeLoaded = true
                    }
                }
            }
        }
    }
}
