import { describe, expect, it, vi } from 'vitest';

import {
  DOCUMENTS_ADDED_COLUMNS,
  DOCUMENTS_COLUMNS,
  DOCUMENTS_GENERATED_COLUMNS,
  DOCUMENTS_INDEX_DDL,
  DOCUMENTS_RETIRED_INDEXES,
  DOCUMENTS_INDEX_NAMES,
  DOCUMENTS_TABLE_DDL,
  ensureDocumentsTable,
  ensureSearchIndex,
  searchIndexResumeStatements,
  searchIndexStatements,
  searchIndexSuspendStatements,
  watchBulkDownloads,
} from './searchIndex';

const CURRENT_FTS_SQL =
  "CREATE VIRTUAL TABLE mobile_search_documents_fts USING fts5(title, body, from_id, to_ids, people, content='mobile_search_documents', tokenize = 'unicode61 remove_diacritics 2')";
const LEGACY_FTS_SQL =
  "CREATE VIRTUAL TABLE mobile_search_documents_fts USING fts5(id UNINDEXED, title, body, tokenize = 'unicode61 remove_diacritics 2')";
/** The raw-table shape from before the person-id columns (2026-10-21 → 22). */
const TEXT_ONLY_FTS_SQL =
  "CREATE VIRTUAL TABLE mobile_search_documents_fts USING fts5(title, body, content='mobile_search_documents', tokenize = 'unicode61 remove_diacritics 2')";

/** The slice of AbstractPowerSyncDatabase the builder touches. */
function fakeDatabase({
  hasSynced,
  indexSql,
  triggers = indexSql == null ? 0 : 3,
  tableColumns = [...DOCUMENTS_COLUMNS, ...DOCUMENTS_GENERATED_COLUMNS.map((column) => column.name)],
}: {
  hasSynced: boolean;
  indexSql: string | null;
  /** How many of the three triggers exist; defaults to all of them when the index does. */
  triggers?: number;
  /** What `pragma_table_info` reports for the documents table; defaults to the current shape. */
  tableColumns?: string[];
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
      async (
        fn: (tx: {
          execute: (sql: string, params?: unknown[]) => Promise<void>;
          getAll: (sql: string, params?: unknown[]) => Promise<unknown[]>;
        }) => Promise<void>,
      ) => {
        await fn({
          execute: async (sql: string, params?: unknown[]) => {
            executed.push(params ? { sql, params } : { sql });
          },
          getAll: async (sql: string) =>
            sql.includes('pragma_table_xinfo') ? ['id', ...tableColumns].map((name) => ({ name })) : [],
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
  it('creates the raw table and its index, adopts rows PowerSync parked in ps_untyped for it, then drops them there', async () => {
    const { db, executed } = fakeDatabase({ hasSynced: false, indexSql: null });

    await ensureDocumentsTable(db);

    expect(executed[0]).toEqual({ sql: DOCUMENTS_TABLE_DDL });
    const indexes = DOCUMENTS_INDEX_DDL.length;
    // Indexes an earlier build defined differently go first, then every current one.
    const retired = DOCUMENTS_RETIRED_INDEXES.length;

    expect(sqlOf(executed).slice(1, 1 + retired)).toEqual(
      DOCUMENTS_RETIRED_INDEXES.map((name) => `DROP INDEX IF EXISTS ${name}`),
    );
    expect(sqlOf(executed).slice(1 + retired, 1 + retired + indexes)).toEqual([...DOCUMENTS_INDEX_DDL]);
    expect(executed[1 + retired + indexes].sql).toMatch(
      /^INSERT INTO mobile_search_documents \(id, entity_type, entity_id, title, body, occurred_at, related_id, detail\)/,
    );
    expect(executed[1 + retired + indexes].sql).toContain("json_extract(data, '$.related_id')");
    expect(executed[1 + retired + indexes].sql).toContain("json_extract(data, '$.detail')");
    expect(executed[1 + retired + indexes].sql).toContain('FROM ps_untyped');
    expect(executed[1 + retired + indexes].sql).toContain('ON CONFLICT(id) DO NOTHING');
    expect(executed[1 + retired + indexes].params).toEqual(['mobile_search_documents']);
    expect(executed[2 + retired + indexes]).toEqual({
      sql: 'DELETE FROM ps_untyped WHERE type = ?',
      params: ['mobile_search_documents'],
    });
    expect(executed).toHaveLength(3 + retired + indexes);
  });

  it('adds the record columns to a table from before they existed, in place', async () => {
    // A replica from the first raw-table shape: the five search columns only.
    const { db, executed } = fakeDatabase({
      hasSynced: true,
      indexSql: CURRENT_FTS_SQL,
      tableColumns: ['entity_type', 'entity_id', 'title', 'body', 'occurred_at'],
    });

    await ensureDocumentsTable(db);

    const added = DOCUMENTS_ADDED_COLUMNS.length;

    expect(sqlOf(executed).slice(1, 3)).toEqual([
      'ALTER TABLE mobile_search_documents ADD COLUMN related_id TEXT',
      'ALTER TABLE mobile_search_documents ADD COLUMN detail TEXT',
    ]);
    // The generated columns follow, reading the detail column just added.
    expect(sqlOf(executed)[3]).toBe(
      "ALTER TABLE mobile_search_documents ADD COLUMN source_system TEXT GENERATED ALWAYS AS (json_extract(detail, '$.source_system')) VIRTUAL",
    );
    const retired = DOCUMENTS_RETIRED_INDEXES.length;

    expect(
      sqlOf(executed).slice(1 + added + retired, 1 + added + retired + DOCUMENTS_INDEX_DDL.length),
    ).toEqual([...DOCUMENTS_INDEX_DDL]);
    expect(executed).toHaveLength(3 + added + retired + DOCUMENTS_INDEX_DDL.length);
  });

  it('adds only the columns a replica is missing (one from before the generated columns)', async () => {
    const { db, executed } = fakeDatabase({
      hasSynced: true,
      indexSql: CURRENT_FTS_SQL,
      tableColumns: ['entity_type', 'entity_id', 'title', 'body', 'occurred_at', 'related_id', 'detail'],
    });

    await ensureDocumentsTable(db);

    const alters = sqlOf(executed).filter((sql) => sql.startsWith('ALTER TABLE'));

    expect(alters).toHaveLength(DOCUMENTS_GENERATED_COLUMNS.length);
    expect(alters.every((sql) => sql.includes('GENERATED ALWAYS AS'))).toBe(true);
  });

  it('every added column is also in the CREATE TABLE, so a fresh replica needs no ALTER', () => {
    for (const column of DOCUMENTS_ADDED_COLUMNS) {
      expect(DOCUMENTS_TABLE_DDL).toContain(column.ddl);
    }

    // The sync client binds the stored columns only; a generated one is computed.
    for (const column of DOCUMENTS_GENERATED_COLUMNS) {
      expect(DOCUMENTS_COLUMNS).not.toContain(column.name);
    }

    expect(DOCUMENTS_COLUMNS).toContain('related_id');
    expect(DOCUMENTS_COLUMNS).toContain('detail');
  });

  it('names every index it creates, so a bulk download can drop and rebuild them', () => {
    expect(DOCUMENTS_INDEX_NAMES).toHaveLength(DOCUMENTS_INDEX_DDL.length);
    expect(new Set(DOCUMENTS_INDEX_NAMES).size).toBe(DOCUMENTS_INDEX_NAMES.length);
    expect(DOCUMENTS_INDEX_NAMES.every((name) => name.startsWith('mobile_search_documents_'))).toBe(true);
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
    // Then the table's indexes (back after a suspended download) and the triggers.
    expect(executed.slice(3).every((e) => /^CREATE (INDEX|TRIGGER)/.test(e.sql))).toBe(true);
    expect(executed.slice(-3).every((e) => e.sql.startsWith('CREATE TRIGGER'))).toBe(true);
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

  it('replaces an index without the person-id columns (the raw-table shape of 2026-10-21)', async () => {
    const { db, executed } = fakeDatabase({ hasSynced: true, indexSql: TEXT_ONLY_FTS_SQL });

    await expect(ensureSearchIndex(db)).resolves.toBe(true);
    expect(executed[0].sql).toBe('DROP TABLE IF EXISTS mobile_search_documents_fts');
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

    const suspended = searchIndexSuspendStatements().length;

    // Progress reports while downloading change nothing.
    emitStatus(true, 900_000, 1_085_673);
    await flush();
    expect(executed).toHaveLength(suspended);

    emitStatus(false, 0, 0);
    await flush();
    expect(executed.slice(suspended).map((e) => e.sql)).toEqual(searchIndexResumeStatements());
    expect(executed[suspended].sql).toContain("VALUES ('rebuild')");
    // The table's own indexes go with the triggers and come back with the rebuild.
    expect(searchIndexSuspendStatements().filter((sql) => sql.startsWith('DROP INDEX'))).toHaveLength(
      DOCUMENTS_INDEX_DDL.length,
    );
    expect(searchIndexResumeStatements()).toEqual(expect.arrayContaining([...DOCUMENTS_INDEX_DDL]));
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
    expect(executed).toHaveLength(searchIndexSuspendStatements().length);

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
