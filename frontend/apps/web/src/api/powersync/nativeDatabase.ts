/**
 * Native PowerSync database: Capacitor SQLite on disk, encrypted with SQLCipher.
 *
 * The working set is this one file. Eviction is unsubscribe (a later cutoff), never
 * a second LRU database.
 *
 * ## Why the adapter is subclassed
 *
 * `@powersync/capacitor` (0.5.x, and still 0.9.4) opens its two connections with
 * `'no-encryption'` and a `TODO support encryption eventually`. The SQLite plugin
 * underneath it has supported SQLCipher all along: `createConnection(…, true,
 * 'secret', …)` opens with a passphrase the plugin keeps in Android's
 * EncryptedSharedPreferences (Keystore-wrapped) or the iOS Keychain, and the
 * `'encryption'` mode converts an existing plaintext file in place. So the fix is
 * the adapter's `init()` with the connection lines swapped — nothing else about
 * how PowerSync drives SQLite changes.
 *
 * `init` is declared `private` in the adapter's typings, so a subclass cannot
 * declare it; it is installed on the prototype instead (see the bottom of this
 * file). The base constructor dispatches `this.init()` through the prototype
 * chain, so ours is what runs. The body is a copy of the adapter's — the drift
 * guard in `nativeDatabase.drift.node.test.ts` pins the vendored original, so an
 * adapter upgrade fails a test here instead of silently diverging.
 *
 * ## Key custody
 *
 * The passphrase is 32 random bytes, minted once in JS and handed to the plugin's
 * `setEncryptionSecret`, which stores it natively; JS never reads it back and
 * every later open resolves it on the native side. On Android the file is also
 * kept out of backups (`allowBackup="false"`); on iOS the plugin's keychain item
 * carries no `ThisDeviceOnly` accessibility, so it can travel with an encrypted
 * backup — see `frontend/apps/ios/SECURITY_ARCHITECTURE.md` §2.3.
 *
 * A key that is gone while the file is still encrypted (a Keystore reset, app data
 * cleared selectively) makes the replica unreadable. That is reported, not
 * repaired: nothing here deletes a database on its own. The server holds the
 * truth; clearing the app's storage starts a fresh replica.
 *
 * Both `capacitor.config.ts` files must enable the plugin's encryption
 * (`androidIsEncryption` / `iosIsEncryption`, plus `iosKeychainPrefix`), or every
 * encrypted call fails with "No Encryption set in capacitor.config".
 */
import { Capacitor } from '@capacitor/core';
import { CapacitorSQLite, SQLiteConnection, type SQLiteDBConnection } from '@capacitor-community/sqlite';
import { CapacitorSQLiteAdapter, CapacitorSQLiteOpenFactory, PowerSyncDatabase } from '@powersync/capacitor';

import { AppSchema } from './schema';

export const NATIVE_DB_FILENAME = 'ci-powersync.db';

/**
 * The same replica as the SQLite plugin names it on disk: the name without its extension plus
 * `SQLite.db` (`databases/ci-powersyncSQLite.db`, checked on the S23U). What the on-device model's
 * search is handed to open the file itself (`@ci/capacitor-local-llm`, `localSearch.databaseFile`).
 */
export const NATIVE_DB_ON_DISK_FILENAME = `${NATIVE_DB_FILENAME.replace(/\.db$/, '')}SQLite.db`;

/** The adapter's own defaults, which it does not export. Same values, same meaning. */
const DEFAULT_SQLITE_OPTIONS = {
  journalSizeLimit: 6 * 1024 * 1024,
  synchronous: 'NORMAL',
  cacheSizeKb: 50 * 1024,
} as const;

/** How the write connection opens: with the stored key, or converting a plaintext file first. */
export type EncryptionMode = 'secret' | 'encryption';

/** The slice of the SQLite plugin's connection manager the key decision reads. */
export interface EncryptionStore {
  isDatabase(database: string): Promise<{ result?: boolean }>;
  isDatabaseEncrypted(database: string): Promise<{ result?: boolean }>;
  isSecretStored(): Promise<{ result?: boolean }>;
  setEncryptionSecret(passphrase: string): Promise<void>;
}

export interface EncryptionPlan {
  mode: EncryptionMode;
  /** A key was minted and stored on this call (first run, or a plaintext file about to be converted). */
  mintedKey: boolean;
}

/** 32 random bytes as 64 hex characters: a raw key for SQLCipher, not a passphrase anyone types. */
export function generatePassphrase(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));

  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Thrown when the file is encrypted but the key that opens it is gone. */
export class ReplicaKeyLostError extends Error {
  constructor(dbFilename: string) {
    super(
      `The local replica ${dbFilename} is encrypted but its key is no longer stored; ` +
        'clear the app’s storage to start a fresh replica (the Memory server holds every row).',
    );
    this.name = 'ReplicaKeyLostError';
  }
}

/**
 * Decide how to open the file and make sure a key exists for it.
 *
 * - No file yet: mint a key (if none), open `secret`.
 * - Plaintext file (a replica from before encryption): mint a key (if none), open
 *   `encryption`, which converts it in place on first open.
 * - Encrypted file with its key: open `secret`.
 * - Encrypted file without a key: refuse — see {@link ReplicaKeyLostError}.
 */
export async function planEncryption(
  store: EncryptionStore,
  dbFilename: string,
  mintPassphrase: () => string = generatePassphrase,
): Promise<EncryptionPlan> {
  const exists = (await store.isDatabase(dbFilename)).result === true;
  const encrypted = exists && (await store.isDatabaseEncrypted(dbFilename)).result === true;
  const keyStored = (await store.isSecretStored()).result === true;

  if (encrypted && !keyStored) {
    throw new ReplicaKeyLostError(dbFilename);
  }

  let mintedKey = false;

  if (!keyStored) {
    await store.setEncryptionSecret(mintPassphrase());
    mintedKey = true;
  }

  return { mode: exists && !encrypted ? 'encryption' : 'secret', mintedKey };
}

interface PowerSyncCorePlugin {
  registerCore(): Promise<{ responseCode: number }>;
}

/**
 * The adapter registers the `PowerSync` Capacitor plugin when its module loads.
 * `registerPlugin` refuses a second registration (a console warning, same proxy
 * back), so read the registered one instead of registering again.
 */
function powerSyncCore(): PowerSyncCorePlugin {
  // `Plugins` is populated by `registerPlugin` at runtime but no longer in
  // Capacitor's public types, hence the cast.
  const registered = (Capacitor as unknown as { Plugins?: Record<string, unknown> }).Plugins;
  const plugin = registered?.PowerSync as PowerSyncCorePlugin | undefined;

  if (!plugin) {
    throw new Error('The PowerSync core plugin is not registered; is @powersync/capacitor loaded?');
  }

  return plugin;
}

type AdapterOptions = ConstructorParameters<typeof CapacitorSQLiteAdapter>[0];

/** The adapter's protected state `init` writes, named so the copy below typechecks. */
interface PoolInternals {
  options: AdapterOptions;
  _writeConnection: SQLiteDBConnection | null;
  _readConnection: SQLiteDBConnection | null;
}

/**
 * `CapacitorConnectionPool.init()` from `@powersync/capacitor` 0.5.3, verbatim
 * except for the blocks marked ENCRYPTION and SOFT HEAP LIMIT. Keep it that way: the drift test
 * compares the vendored original, and a change there is a change to review here.
 */
async function encryptedInit(this: EncryptedCapacitorSQLiteAdapter): Promise<void> {
  const self = this as unknown as PoolInternals;
  const { responseCode: registrationResponseCode } = await powerSyncCore().registerCore();

  if (registrationResponseCode != 0) {
    throw new Error(
      `Could not register PowerSync core extension: SQLite error code ${registrationResponseCode}`,
    );
  }

  const sqlite = new SQLiteConnection(CapacitorSQLite);

  // It seems like the isConnection and retrieveConnection methods
  // only check a JS side map of connections.
  // On hot reload this JS cache can be cleared, while the connection
  // still exists natively. and `createConnection` will fail if it already exists.
  await sqlite.closeConnection(self.options.dbFilename, false).catch(() => {});
  await sqlite.closeConnection(self.options.dbFilename, true).catch(() => {});

  // ENCRYPTION — the adapter opens both with (false, 'no-encryption').
  const { mode, mintedKey } = await planEncryption(sqlite, self.options.dbFilename);

  if (mintedKey) {
    console.info(`[PowerSync] Minted the encryption key for ${self.options.dbFilename}`);
  }

  if (mode === 'encryption') {
    console.info(`[PowerSync] Encrypting the existing plaintext replica ${self.options.dbFilename} in place`);
  }

  self._writeConnection = await sqlite.createConnection(self.options.dbFilename, true, mode, 1, false);
  self._readConnection = await sqlite.createConnection(self.options.dbFilename, true, 'secret', 1, true);
  // END ENCRYPTION

  await self._writeConnection.open();

  const { cacheSizeKb, journalSizeLimit, synchronous } = {
    ...DEFAULT_SQLITE_OPTIONS,
    ...self.options.sqliteOptions,
  };

  await self._writeConnection.query('PRAGMA journal_mode = WAL');
  await self._writeConnection.query(`PRAGMA journal_size_limit = ${journalSizeLimit}`);
  await self._writeConnection.query(`PRAGMA temp_store = memory`);
  await self._writeConnection.query(`PRAGMA synchronous = ${synchronous}`);
  await self._writeConnection.query(`PRAGMA cache_size = -${cacheSizeKb}`);
  // SOFT HEAP LIMIT — not in the adapter.
  // SQLCipher for Android calls sqlite3_soft_heap_limit(8 MB) when its native
  // library loads. The limit is process-wide and caps SQLite's page cache no
  // matter what cache_size says, so the PowerSync checkpoint apply decrypted
  // nearly every oplog page from disk: 97% of CPU in SQLCipher, ~16 min for a
  // 1.08M-op apply on a Galaxy S23 Ultra, ~2 min with the limit lifted.
  // 0 is SQLite's own default (no limit); memory stays bounded by cache_size
  // per connection. Set on every platform so iOS and Android behave alike.
  await self._writeConnection.query('PRAGMA soft_heap_limit = 0');
  // END SOFT HEAP LIMIT
  await self._readConnection.open();

  const platform = Capacitor.getPlatform();

  if (platform == 'android') {
    /**
     * SQLCipher for Android enables dynamic loading of extensions.
     * On iOS we use a static auto extension registration.
     */
    const extensionQuery = "SELECT load_extension('libpowersync.so', 'sqlite3_powersync_init')";

    await self._writeConnection.query(extensionQuery);
    await self._readConnection.query(extensionQuery);
  }

  await self._writeConnection.query("SELECT powersync_update_hooks('install')");
}

/** The adapter, opening the file encrypted. See the module comment. */
export class EncryptedCapacitorSQLiteAdapter extends CapacitorSQLiteAdapter {}

// `init` is private in the adapter's typings, so it cannot be declared on the
// subclass; the base constructor still calls `this.init()`, and the prototype
// chain finds this one first.
Object.defineProperty(EncryptedCapacitorSQLiteAdapter.prototype, 'init', {
  value: encryptedInit,
  writable: true,
  configurable: true,
});

export class EncryptedCapacitorSQLiteOpenFactory extends CapacitorSQLiteOpenFactory {
  override openDB(): EncryptedCapacitorSQLiteAdapter {
    return new EncryptedCapacitorSQLiteAdapter(this.options);
  }
}

export function openNativePowerSyncDatabase(): PowerSyncDatabase {
  return new PowerSyncDatabase({
    schema: AppSchema,
    database: new EncryptedCapacitorSQLiteOpenFactory({
      dbFilename: NATIVE_DB_FILENAME,
    }),
  });
}
