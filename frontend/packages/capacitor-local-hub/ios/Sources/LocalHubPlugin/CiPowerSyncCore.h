#ifndef CiPowerSyncCore_h
#define CiPowerSyncCore_h

/// Registers PowerSync's core (`powersync-sqlite-core`) as an auto extension of SQLCipher, so
/// every connection opened afterwards has `powersync_control` and friends. What
/// `@powersync/capacitor`'s `registerCore()` does from JavaScript; the background replica sync
/// calls it itself because a background launch runs no JavaScript. Repeat calls are no-ops
/// (SQLite ignores an entry point already on its list). Returns an SQLite result code.
int ci_register_powersync_core(void);

#endif /* CiPowerSyncCore_h */
