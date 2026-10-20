import { describe, expect, it, vi } from 'vitest';

import { ensureSearchIndex, searchIndexStatements } from './searchIndex';

/** The slice of AbstractPowerSyncDatabase the builder touches. */
function fakeDatabase({ hasSynced, indexExists }: { hasSynced: boolean; indexExists: boolean }) {
  const executed: string[] = [];
  let resolveFirstSync: (() => void) | undefined;
  const firstSync = new Promise<void>((resolve) => {
    resolveFirstSync = resolve;
  });

  const db = {
    waitForReady: vi.fn(async () => undefined),
    getOptional: vi.fn(async () => (indexExists ? { name: 'documents_fts' } : null)),
    currentStatus: { hasSynced },
    waitForFirstSync: vi.fn(({ signal }: { signal?: AbortSignal } = {}) => {
      // Like the SDK: an aborted signal settles the wait rather than hanging it.
      if (signal?.aborted) {
        return Promise.reject(new DOMException('aborted', 'AbortError'));
      }

      signal?.addEventListener('abort', () => resolveFirstSync?.());

      return firstSync;
    }),
    writeTransaction: vi.fn(
      async (fn: (tx: { execute: (sql: string) => Promise<void> }) => Promise<void>) => {
        await fn({
          execute: async (sql: string) => {
            executed.push(sql);
          },
        });
      },
    ),
  };

  return { db: db as never, executed, finishFirstSync: () => resolveFirstSync?.() };
}

describe('ensureSearchIndex', () => {
  it('on a device that already synced, builds at once: the table, the bulk copy, then the triggers', async () => {
    const { db, executed } = fakeDatabase({ hasSynced: true, indexExists: false });

    await expect(ensureSearchIndex(db)).resolves.toBe(true);

    expect(executed).toEqual(searchIndexStatements());
    expect(executed[0]).toMatch(/^CREATE VIRTUAL TABLE/);
    expect(executed[1]).toMatch(/^INSERT INTO documents_fts/);
    expect(executed.slice(2).every((sql) => sql.startsWith('CREATE TRIGGER'))).toBe(true);
  });

  it('on a device that has never synced, waits for the first sync so the download is not paid for row by row', async () => {
    const { db, executed, finishFirstSync } = fakeDatabase({ hasSynced: false, indexExists: false });

    let settled = false;
    const building = ensureSearchIndex(db).then((built) => {
      settled = true;

      return built;
    });

    await Promise.resolve();
    expect(settled).toBe(false);
    expect(executed).toEqual([]);

    finishFirstSync();

    await expect(building).resolves.toBe(true);
    expect(executed).toHaveLength(searchIndexStatements().length);
  });

  it('an abort while waiting builds nothing', async () => {
    const { db, executed } = fakeDatabase({ hasSynced: false, indexExists: false });
    const controller = new AbortController();

    const building = ensureSearchIndex(db, { signal: controller.signal });

    controller.abort();

    await expect(building).resolves.toBe(false);
    expect(executed).toEqual([]);
  });

  it('does nothing when the index already exists, synced or not', async () => {
    const { db, executed } = fakeDatabase({ hasSynced: false, indexExists: true });

    await expect(ensureSearchIndex(db)).resolves.toBe(false);
    expect(executed).toEqual([]);
  });
});
