import { afterEach, describe, expect, it, vi } from 'vitest';

import { LEGACY_INDEXEDDB_NAME, purgeLegacyIndexedDbReplica } from './legacyIndexedDb';

/** A minimal `indexedDB` double: a name list and a deleteDatabase that reports success asynchronously. */
function installIndexedDb(names: string[] | null, options: { blocked?: boolean } = {}) {
  const deleted: string[] = [];
  const factory = {
    databases: names === null ? undefined : async () => names.map((name) => ({ name, version: 1 })),
    deleteDatabase: vi.fn((name: string) => {
      const request: Partial<IDBOpenDBRequest> & { onsuccess?: () => void; onblocked?: () => void } = {};

      queueMicrotask(() => {
        if (options.blocked) {
          request.onblocked?.();
        } else {
          deleted.push(name);
          request.onsuccess?.();
        }
      });

      return request as IDBOpenDBRequest;
    }),
  };

  vi.stubGlobal('indexedDB', factory);

  return { deleted, factory };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('purgeLegacyIndexedDbReplica', () => {
  it('deletes the database earlier builds opened, and reports it when the browser listed it', async () => {
    const { deleted } = installIndexedDb([LEGACY_INDEXEDDB_NAME, 'unrelated-app-db']);

    await expect(purgeLegacyIndexedDbReplica()).resolves.toEqual([LEGACY_INDEXEDDB_NAME]);

    expect(deleted).toEqual([LEGACY_INDEXEDDB_NAME]);
  });

  it('still deletes the known name where the browser cannot list databases, and reports nothing', async () => {
    const { deleted } = installIndexedDb(null);

    await expect(purgeLegacyIndexedDbReplica()).resolves.toEqual([]);

    expect(deleted).toEqual([LEGACY_INDEXEDDB_NAME]);
  });

  it('does not hang on a deletion another tab is blocking', async () => {
    installIndexedDb([LEGACY_INDEXEDDB_NAME], { blocked: true });

    await expect(purgeLegacyIndexedDbReplica()).resolves.toEqual([LEGACY_INDEXEDDB_NAME]);
  });

  it('is a no-op without IndexedDB at all', async () => {
    vi.stubGlobal('indexedDB', undefined);

    await expect(purgeLegacyIndexedDbReplica()).resolves.toEqual([]);
  });
});
