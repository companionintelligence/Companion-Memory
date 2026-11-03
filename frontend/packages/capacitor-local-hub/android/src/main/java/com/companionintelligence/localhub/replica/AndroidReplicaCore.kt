package com.companionintelligence.localhub.replica

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import net.zetetic.database.sqlcipher.SQLiteDatabase

/**
 * The replica opened the way the Capacitor SQLite plugin opens it, so the app and this see the
 * same file: SQLCipher (`net.zetetic:sqlcipher-android`, one copy in the app, shared with that
 * plugin and the outbox), the passphrase that plugin keeps under `secret` in its
 * EncryptedSharedPreferences (`sqlite_encrypted_shared_prefs`, default AES-256-GCM master key),
 * and PowerSync's core loaded with the same `load_extension` call `@powersync/capacitor` makes.
 *
 * [open] answers null rather than throwing when there is nothing to sync: no file yet (never
 * synced, or wiped at sign-out), or no stored passphrase.
 */
class AndroidReplicaCore private constructor(private val db: SQLiteDatabase) : ReplicaCore {
    override fun control(op: String, payload: String?): String {
        db.beginTransactionNonExclusive()
        try {
            val cursor = if (payload == null) {
                db.rawQuery("SELECT powersync_control(?, NULL)", arrayOf(op))
            } else {
                db.rawQuery("SELECT powersync_control(?, ?)", arrayOf(op, payload))
            }
            val reply = cursor.use {
                it.moveToFirst()
                it.getString(0)
            }
            db.setTransactionSuccessful()
            return reply
        } finally {
            db.endTransaction()
        }
    }

    override fun pendingUploads(): Int = scalar(db, "SELECT count(*) FROM ps_crud")?.toIntOrNull() ?: 0

    override fun close() = db.close()

    companion object {
        private const val PLUGIN_PREFERENCES = "sqlite_encrypted_shared_prefs"
        private const val PLUGIN_SECRET_KEY = "secret"

        @Volatile
        private var libraryLoaded = false

        fun open(context: Context, databaseFile: String): AndroidReplicaCore? {
            val file = context.getDatabasePath(databaseFile)
            if (!file.exists()) return null
            val passphrase = EncryptedSharedPreferences.create(
                context,
                PLUGIN_PREFERENCES,
                MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build(),
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
            ).getString(PLUGIN_SECRET_KEY, null)
            if (passphrase.isNullOrEmpty()) return null

            if (!libraryLoaded) {
                System.loadLibrary("sqlcipher")
                libraryLoaded = true
            }
            val db = SQLiteDatabase.openDatabase(file.absolutePath, passphrase, null, SQLiteDatabase.OPEN_READWRITE, null)
            try {
                // The app's connection may be finishing a write as this starts.
                scalar(db, "PRAGMA busy_timeout = 10000")
                scalar(db, "SELECT load_extension('libpowersync.so', 'sqlite3_powersync_init')")
            } catch (e: Exception) {
                db.close()
                throw e
            }
            return AndroidReplicaCore(db)
        }

        private fun scalar(db: SQLiteDatabase, sql: String): String? =
            db.rawQuery(sql, null as Array<String>?).use { if (it.moveToFirst()) it.getString(0) else null }
    }
}
