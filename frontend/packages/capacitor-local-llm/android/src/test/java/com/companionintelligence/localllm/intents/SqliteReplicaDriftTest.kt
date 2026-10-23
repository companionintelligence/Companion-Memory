package com.companionintelligence.localllm.intents

import com.companionintelligence.localllm.RepoFiles
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * `LocalSearchStore` reads the PowerSync replica with the key `@capacitor-community/sqlite` stores
 * for it, which couples this module to that plugin's internals: the EncryptedSharedPreferences
 * file, the key the passphrase sits under, the master-key scheme, and the `SQLite.db` suffix the
 * plugin appends to a database name. None is part of the plugin's public API. This pins each one
 * against the vendored source, so a plugin upgrade that moves them fails here rather than on a
 * phone that silently answers "could not be searched".
 */
class SqliteReplicaDriftTest {
    private val plugin = "frontend/apps/android/node_modules/@capacitor-community/sqlite/android/src/main/java/com/getcapacitor/community/database/sqlite"

    @Test
    fun the_passphrase_file_and_key_are_what_the_sqlite_plugin_uses() {
        val sqlite = RepoFiles.read("$plugin/CapacitorSQLite.java")
        val cipher = RepoFiles.read("$plugin/SQLite/UtilsSQLCipher.java")

        assertTrue(sqlite.contains("\"${LocalSearchStore.PREFS_FILE}\""))
        assertTrue(sqlite.contains("MasterKey.KeyScheme.AES256_GCM"))
        assertTrue(sqlite.contains("PrefKeyEncryptionScheme.AES256_SIV"))
        assertTrue(sqlite.contains("PrefValueEncryptionScheme.AES256_GCM"))
        assertTrue(cipher.contains("getString(\"${LocalSearchStore.PREFS_KEY}\""))
        // Read-only, with the passphrase as the second argument: the call this store makes.
        assertTrue(cipher.contains("SQLiteDatabase.openDatabase(dbPath.getAbsolutePath(), passphrase, null, SQLiteDatabase.OPEN_READONLY, null)"))
    }

    @Test
    fun the_replica_file_is_the_database_name_plus_the_plugin_s_suffix() {
        val sqlite = RepoFiles.read("$plugin/CapacitorSQLite.java")

        assertTrue(sqlite.contains("dbName + \"SQLite.db\""))
        assertTrue(LocalSearch.DEFAULT_DATABASE_FILE.endsWith("SQLite.db"))
    }

    @Test
    fun the_dependency_pins_match_the_plugin_s_so_the_app_links_one_copy_of_each() {
        val theirs = RepoFiles.read("frontend/apps/android/node_modules/@capacitor-community/sqlite/android/build.gradle")
        val ours = RepoFiles.read("frontend/packages/capacitor-local-llm/android/build.gradle")

        for (pin in listOf("net.zetetic:sqlcipher-android:4.10.0@aar", "androidx.sqlite:sqlite:2.4.0", "androidx.security:security-crypto:1.1.0-alpha06")) {
            assertTrue("the SQLite plugin no longer pins $pin", theirs.contains(pin))
            assertTrue("this module does not pin $pin", ours.contains(pin))
        }
    }
}
