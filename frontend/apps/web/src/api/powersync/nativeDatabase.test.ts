import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const connection = () => ({
    open: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    query: vi.fn().mockResolvedValue({ values: [] }),
    getConnectionReadOnly: vi.fn().mockReturnValue(false),
  });

  return {
    platform: 'android',
    registerCore: vi.fn().mockResolvedValue({ responseCode: 0 }),
    store: {
      isDatabase: vi.fn(),
      isDatabaseEncrypted: vi.fn(),
      isSecretStored: vi.fn(),
      setEncryptionSecret: vi.fn().mockResolvedValue(undefined),
      createConnection: vi.fn(),
      closeConnection: vi.fn().mockResolvedValue(undefined),
    },
    write: connection(),
    read: connection(),
  };
});

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    getPlatform: () => mocks.platform,
    Plugins: { PowerSync: { registerCore: mocks.registerCore } },
  },
  registerPlugin: () => ({ registerCore: mocks.registerCore }),
  WebPlugin: class {},
}));

vi.mock('@capacitor-community/sqlite', () => ({
  CapacitorSQLite: {},
  SQLiteConnection: class {
    isDatabase = mocks.store.isDatabase;

    isDatabaseEncrypted = mocks.store.isDatabaseEncrypted;

    isSecretStored = mocks.store.isSecretStored;

    setEncryptionSecret = mocks.store.setEncryptionSecret;

    createConnection = mocks.store.createConnection;

    closeConnection = mocks.store.closeConnection;
  },
}));

import type { EncryptedCapacitorSQLiteAdapter } from './nativeDatabase';
import {
  EncryptedCapacitorSQLiteOpenFactory,
  NATIVE_DB_FILENAME,
  ReplicaKeyLostError,
  generatePassphrase,
  planEncryption,
} from './nativeDatabase';

const HEX_64 = /^[0-9a-f]{64}$/;

// Re-armed here rather than in `vi.hoisted`: the vitest config resets mock
// implementations between tests, so a `mockResolvedValue` set at hoist time is
// gone by the second test.
beforeEach(() => {
  mocks.platform = 'android';
  mocks.registerCore.mockReset().mockResolvedValue({ responseCode: 0 });
  mocks.store.isDatabase.mockReset().mockResolvedValue({ result: false });
  mocks.store.isDatabaseEncrypted.mockReset().mockResolvedValue({ result: false });
  mocks.store.isSecretStored.mockReset().mockResolvedValue({ result: true });
  mocks.store.setEncryptionSecret.mockReset().mockResolvedValue(undefined);
  mocks.store.closeConnection.mockReset().mockResolvedValue(undefined);
  mocks.store.createConnection
    .mockReset()
    .mockImplementation(
      (_name: string, _encrypted: boolean, _mode: string, _version: number, readonly: boolean) =>
        Promise.resolve(readonly ? mocks.read : mocks.write),
    );

  for (const connection of [mocks.write, mocks.read]) {
    connection.open.mockReset().mockResolvedValue(undefined);
    connection.close.mockReset().mockResolvedValue(undefined);
    connection.query.mockReset().mockResolvedValue({ values: [] });
    connection.getConnectionReadOnly.mockReset().mockReturnValue(connection === mocks.read);
  }
});

describe('generatePassphrase', () => {
  it('is a 256-bit raw key in hex, fresh each time', () => {
    const a = generatePassphrase();
    const b = generatePassphrase();

    expect(a).toMatch(HEX_64);
    expect(b).toMatch(HEX_64);
    expect(a).not.toEqual(b);
  });
});

describe('planEncryption', () => {
  it('first run: mints a key and opens with it', async () => {
    mocks.store.isSecretStored.mockResolvedValue({ result: false });

    const plan = await planEncryption(mocks.store, 'db', () => 'k'.repeat(64));

    expect(plan).toEqual({ mode: 'secret', mintedKey: true });
    expect(mocks.store.setEncryptionSecret).toHaveBeenCalledWith('k'.repeat(64));
    // No file yet, so nothing to inspect.
    expect(mocks.store.isDatabaseEncrypted).not.toHaveBeenCalled();
  });

  it('a plaintext replica from before encryption is converted in place', async () => {
    mocks.store.isDatabase.mockResolvedValue({ result: true });
    mocks.store.isDatabaseEncrypted.mockResolvedValue({ result: false });
    mocks.store.isSecretStored.mockResolvedValue({ result: false });

    const plan = await planEncryption(mocks.store, 'db', () => 'k'.repeat(64));

    expect(plan).toEqual({ mode: 'encryption', mintedKey: true });
    expect(mocks.store.setEncryptionSecret).toHaveBeenCalledTimes(1);
  });

  it('an encrypted replica with its key opens normally and mints nothing', async () => {
    mocks.store.isDatabase.mockResolvedValue({ result: true });
    mocks.store.isDatabaseEncrypted.mockResolvedValue({ result: true });

    await expect(planEncryption(mocks.store, 'db')).resolves.toEqual({ mode: 'secret', mintedKey: false });
    expect(mocks.store.setEncryptionSecret).not.toHaveBeenCalled();
  });

  it('an encrypted replica whose key is gone is refused, never re-keyed or deleted', async () => {
    mocks.store.isDatabase.mockResolvedValue({ result: true });
    mocks.store.isDatabaseEncrypted.mockResolvedValue({ result: true });
    mocks.store.isSecretStored.mockResolvedValue({ result: false });

    await expect(planEncryption(mocks.store, 'ci-powersync.db')).rejects.toBeInstanceOf(ReplicaKeyLostError);
    expect(mocks.store.setEncryptionSecret).not.toHaveBeenCalled();
  });
});

async function openAdapter(): Promise<EncryptedCapacitorSQLiteAdapter> {
  const adapter = new EncryptedCapacitorSQLiteOpenFactory({ dbFilename: NATIVE_DB_FILENAME }).openDB();

  // Every lock awaits the constructor's init; this is the public way to wait for it.
  await adapter.readLock(async () => undefined);

  return adapter;
}

describe('EncryptedCapacitorSQLiteAdapter', () => {
  it('opens both connections encrypted, then does everything the stock adapter does', async () => {
    await openAdapter();

    expect(mocks.registerCore).toHaveBeenCalled();
    // Stale native connections from a hot reload are closed first, as upstream does.
    expect(mocks.store.closeConnection).toHaveBeenCalledWith(NATIVE_DB_FILENAME, false);
    expect(mocks.store.closeConnection).toHaveBeenCalledWith(NATIVE_DB_FILENAME, true);

    expect(mocks.store.createConnection.mock.calls).toEqual([
      [NATIVE_DB_FILENAME, true, 'secret', 1, false],
      [NATIVE_DB_FILENAME, true, 'secret', 1, true],
    ]);

    const writeSql = mocks.write.query.mock.calls.map(([sql]) => sql);

    expect(writeSql).toEqual([
      'PRAGMA journal_mode = WAL',
      `PRAGMA journal_size_limit = ${6 * 1024 * 1024}`,
      'PRAGMA temp_store = memory',
      'PRAGMA synchronous = NORMAL',
      `PRAGMA cache_size = -${50 * 1024}`,
      'PRAGMA soft_heap_limit = 0',
      "SELECT load_extension('libpowersync.so', 'sqlite3_powersync_init')",
      "SELECT powersync_update_hooks('install')",
    ]);
    expect(mocks.read.query.mock.calls.map(([sql]) => sql)).toEqual([
      "SELECT load_extension('libpowersync.so', 'sqlite3_powersync_init')",
    ]);
    expect(mocks.write.open).toHaveBeenCalledTimes(1);
    expect(mocks.read.open).toHaveBeenCalledTimes(1);
  });

  it('converts a plaintext replica through the write connection only', async () => {
    mocks.store.isDatabase.mockResolvedValue({ result: true });
    mocks.store.isDatabaseEncrypted.mockResolvedValue({ result: false });

    await openAdapter();

    expect(mocks.store.createConnection.mock.calls).toEqual([
      [NATIVE_DB_FILENAME, true, 'encryption', 1, false],
      [NATIVE_DB_FILENAME, true, 'secret', 1, true],
    ]);
  });

  it('iOS registers the extension statically, so no load_extension', async () => {
    mocks.platform = 'ios';

    await openAdapter();

    const allSql = [...mocks.write.query.mock.calls, ...mocks.read.query.mock.calls].map(([sql]) => sql);

    expect(allSql.some((sql: string) => sql.includes('load_extension'))).toBe(false);
    expect(allSql).toContain("SELECT powersync_update_hooks('install')");
    // Same on both platforms: the Android SQLCipher build's 8 MB cap must not be iOS-only knowledge.
    expect(allSql).toContain('PRAGMA soft_heap_limit = 0');
  });

  it('a lost key surfaces as the init failure, with no connection opened', async () => {
    mocks.store.isDatabase.mockResolvedValue({ result: true });
    mocks.store.isDatabaseEncrypted.mockResolvedValue({ result: true });
    mocks.store.isSecretStored.mockResolvedValue({ result: false });

    const adapter = new EncryptedCapacitorSQLiteOpenFactory({ dbFilename: NATIVE_DB_FILENAME }).openDB();

    await expect(adapter.readLock(async () => undefined)).rejects.toBeInstanceOf(ReplicaKeyLostError);
    expect(mocks.store.createConnection).not.toHaveBeenCalled();
  });
});
