import { describe, expect, it, vi } from 'vitest';

import {
  DOCUMENTS_TABLE_DDL,
  ensureDocumentsTable,
  ensureSearchIndex,
  searchIndexResumeStatements,
  searchIndexStatements,
  searchIndexSuspendStatements,
  watchBulkDownloads,
} from './searchIndex';

const CURRENT_FTS_SQL =
  "CREATE VIRTUAL TABLE mobile_search_documents_fts USING fts5(title, body, content='mobile_search_documents', tokenize = 'unicode61 remove_diacritics 2')";
const LEGACY_FTS_SQL =
  "CREATE VIRTUAL TABLE mobile_search_documents_fts USING fts5(id UNINDEXED, title, body, tokenize = 'unicode61 remove_diacritics 2')";

/** The slice of AbstractPowerSyncDatabase the builder touches. */
function fakeDatabase({
  hasSynced,
  indexSql,
  triggers = indexSql == null ? 0 : 3,
}: {
  hasSynced: boolean;
  indexSql: string | null;
  /** How many of the three triggers exist; defaults to all of them when the index does. */
  triggers?: number;
}) {
  const executed: Array<{ sql: string; params?: unknown[] }> = [];
  const listeners: Array<{ statusChanged?: (status: unknown) => void }> = [];
  let resolveFirstSync: (() => void) | undefined;
  const firstSync = new Promise<void>((resolve) => {
    resolveFirstSync = resolve;
  });

  const db = {
    waitForReady: vi.fn(async () => undefined),
    getOptional: vi.fn(async (sql: string) =>
      sql.includes('AS triggers')
        ? { table_sql: indexSql, triggers }
        : indexSql == null
          ? null
          : { name: 'mobile_search_documents_fts' },
    ),
    registerListener: vi.fn((listener: { statusChanged?: (status: unknown) => void }) => {
      listeners.push(listener);

      return () => {
        listeners.splice(listeners.indexOf(listener), 1);
      };
    }),
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
      async (fn: (tx: { execute: (sql: string, params?: unknown[]) => Promise<void> }) => Promise<void>) => {
        await fn({
          execute: async (sql: string, params?: unknown[]) => {
            executed.push(params ? { sql, params } : { sql });
          },
        });
      },
    ),
  };

  const emitStatus = (downloading: boolean, downloaded: number, total: number) => {
    for (const listener of listeners) {
      listener.statusChanged?.({
        dataFlowStatus: { downloading },
        downloadProgress: downloading ? { downloadedOperations: downloaded, totalOperations: total } : null,
      });
    }
  };

  return { db: db as never, executed, listeners, emitStatus, finishFirstSync: () => resolveFirstSync?.() };
}

const sqlOf = (executed: Array<{ sql: string }>) => executed.map((e) => e.sql);

describe('ensureDocumentsTable', () => {
  it('creates the raw table, adopts rows PowerSync parked in ps_untyped for it, then drops them there', async () => {
    const { db, executed } = fakeDatabase({ hasSynced: false, indexSql: null });

    await ensureDocumentsTable(db);

    expect(executed[0]).toEqual({ sql: DOCUMENTS_TABLE_DDL });
    expect(executed[1].sql).toMatch(
      /^INSERT INTO mobile_search_documents \(id, entity_type, entity_id, title, body, occurred_at\)/,
    );
    expect(executed[1].sql).toContain('FROM ps_untyped');
    expect(executed[1].sql).toContain('ON CONFLICT(id) DO NOTHING');
    expect(executed[1].params).toEqual(['mobile_search_documents']);
    expect(executed[2]).toEqual({
      sql: 'DELETE FROM ps_untyped WHERE type = ?',
      params: ['mobile_search_documents'],
    });
    expect(executed).toHaveLength(3);
  });
});

describe('ensureSearchIndex', () => {
  it('on a device that already synced, builds at once: the index, the rebuild, then the triggers', async () => {
    const { db, executed } = fakeDatabase({ hasSynced: true, indexSql: null });

    await expect(ensureSearchIndex(db)).resolves.toBe(true);

    expect(sqlOf(executed)).toEqual([
      'DROP TABLE IF EXISTS mobile_search_documents_fts',
      ...searchIndexStatements(),
    ]);
    expect(executed[1].sql).toMatch(/^CREATE VIRTUAL TABLE/);
    expect(executed[2].sql).toMatch(
      /^INSERT INTO mobile_search_documents_fts\(mobile_search_documents_fts\) VALUES \('rebuild'\)/,
    );
    expect(executed.slice(3).every((e) => e.sql.startsWith('CREATE TRIGGER'))).toBe(true);
  });

  it('on a device that has never synced, waits for the first sync so the download is not paid for row by row', async () => {
    const { db, executed, finishFirstSync } = fakeDatabase({ hasSynced: false, indexSql: null });

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
    expect(executed).toHaveLength(searchIndexStatements().length + 1);
  });

  it('an abort while waiting builds nothing', async () => {
    const { db, executed } = fakeDatabase({ hasSynced: false, indexSql: null });
    const controller = new AbortController();

    const building = ensureSearchIndex(db, { signal: controller.signal });

    controller.abort();

    await expect(building).resolves.toBe(false);
    expect(executed).toEqual([]);
  });

  it('does nothing when the index already exists in its current shape, synced or not', async () => {
    const { db, executed } = fakeDatabase({ hasSynced: false, indexSql: CURRENT_FTS_SQL });

    await expect(ensureSearchIndex(db)).resolves.toBe(false);
    expect(executed).toEqual([]);
  });

  it('replaces an index of the earlier shape (contentful, over the JSON storage table)', async () => {
    const { db, executed } = fakeDatabase({ hasSynced: true, indexSql: LEGACY_FTS_SQL });

    await expect(ensureSearchIndex(db)).resolves.toBe(true);
    expect(executed[0].sql).toBe('DROP TABLE IF EXISTS mobile_search_documents_fts');
    expect(executed).toHaveLength(searchIndexStatements().length + 1);
  });

  it('rebuilds an index whose triggers are missing (the app died during a bulk download)', async () => {
    const { db, executed } = fakeDatabase({ hasSynced: true, indexSql: CURRENT_FTS_SQL, triggers: 0 });

    await expect(ensureSearchIndex(db)).resolves.toBe(true);
    expect(executed).toHaveLength(searchIndexStatements().length + 1);
  });
});

describe('watchBulkDownloads', () => {
  // A macrotask turn drains every microtask the watcher's chain queues.
  const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

  it('drops the triggers when a large download starts and rebuilds the index once it has applied', async () => {
    const { db, executed, emitStatus } = fakeDatabase({ hasSynced: true, indexSql: CURRENT_FTS_SQL });
    const events: Array<[string, number]> = [];
    const stop = watchBulkDownloads(db, {
      onChange: (event, operations) => events.push([event, operations]),
    });

    emitStatus(true, 1_000, 1_085_673);
    await flush();
    expect(executed.map((e) => e.sql)).toEqual(searchIndexSuspendStatements());
    expect(events).toEqual([['suspended', 1_085_673]]);

    // Progress reports while downloading change nothing.
    emitStatus(true, 900_000, 1_085_673);
    await flush();
    expect(executed).toHaveLength(3);

    emitStatus(false, 0, 0);
    await flush();
    expect(executed.slice(3).map((e) => e.sql)).toEqual(searchIndexResumeStatements());
    expect(executed[3].sql).toContain("VALUES ('rebuild')");
    expect(events).toEqual([
      ['suspended', 1_085_673],
      ['resumed', 1_085_673],
    ]);

    stop();
  });

  it('suspends for an apply that is all that is left of a download (the app came back mid-apply)', async () => {
    const { db, executed, emitStatus } = fakeDatabase({ hasSynced: true, indexSql: CURRENT_FTS_SQL });
    const stop = watchBulkDownloads(db);

    emitStatus(true, 1_085_673, 1_085_673);
    await flush();
    expect(executed.map((e) => e.sql)).toEqual(searchIndexSuspendStatements());

    stop();
  });

  it('leaves a routine sync to the triggers', async () => {
    const { db, executed, emitStatus } = fakeDatabase({ hasSynced: true, indexSql: CURRENT_FTS_SQL });
    const stop = watchBulkDownloads(db);

    emitStatus(true, 0, 400);
    emitStatus(false, 0, 0);
    await flush();
    expect(executed).toEqual([]);

    stop();
  });

  it('does not rebuild an index that does not exist yet', async () => {
    const { db, executed, emitStatus } = fakeDatabase({ hasSynced: false, indexSql: null });
    const stop = watchBulkDownloads(db);

    emitStatus(true, 0, 50_000);
    await flush();
    expect(executed.map((e) => e.sql)).toEqual(searchIndexSuspendStatements());

    emitStatus(false, 0, 0);
    await flush();
    expect(executed).toHaveLength(3);

    stop();
  });

  it('stops listening when told to', () => {
    const { db, listeners } = fakeDatabase({ hasSynced: true, indexSql: CURRENT_FTS_SQL });
    const stop = watchBulkDownloads(db);

    expect(listeners).toHaveLength(1);
    stop();
    expect(listeners).toHaveLength(0);
  });
});
