/**
 * The device's copy of the search documents, and the full-text index over it.
 *
 * `mobile_search_documents` is a PowerSync *raw table*: a plain SQLite table
 * this module creates and owns, which the sync client writes into directly
 * with the `put` / `delete` statements declared in {@link DOCUMENTS_RAW_TABLE}
 * (schema.ts attaches them). PowerSync's managed tables store every row as a
 * JSON blob in a `ps_data__*` table and expose it through a view; for 600k
 * rows that was a second copy of the text, a `json_extract` per read, and a
 * checkpoint apply measured at ~850 KB/s. A raw table takes the columns as
 * columns, and the FTS5 index below is an *external-content* index over it,
 * so the text exists once (plus the oplog PowerSync keeps for every table).
 *
 * Raw tables are the application's to create, before `connect()`: the sync
 * client's first `put` fails if the table is missing. {@link ensureDocumentsTable}
 * does that, and adopts rows PowerSync parked in `ps_untyped` when the table
 * stopped being a managed one (its documented migration path).
 *
 * ## The index: build after the first sync, not before
 *
 * On a device that has never synced, {@link ensureSearchIndex} WAITS for the
 * first full sync and builds afterwards. Measured 2026-10-19 on the S23U:
 * with triggers in place before the download, the checkpoint apply fired them
 * for each of 582k rows and crawled at ~200 KB/s of WAL, every other plugin
 * call queued behind the one long write for over half an hour. One
 * `rebuild` over the finished table is a sort, not 582k b-tree updates. A
 * device that already synced (an upgrade adding this index) builds at once.
 *
 * The same applies to any later bulk download — a sync-rules change, which
 * re-downloads the whole bucket, or an import that adds a hundred thousand
 * rows. {@link watchBulkDownloads} drops the triggers when a download of more
 * than {@link BULK_DOWNLOAD_OPERATIONS} operations starts and, once it has
 * applied, rebuilds the index and puts them back. Measured 2026-10-20 on the
 * S23U with the triggers left in place through a 1.08M-operation re-download:
 * the apply was still writing after three hours.
 *
 * Tokenizer: `unicode61` with diacritics folded, so "Zoë" is found by "zoe".
 * SQLite does not stem the way Postgres' `english` configuration does;
 * `localSearch.ts` narrows that gap with prefix matching.
 */
import type { AbstractPowerSyncDatabase, RawTableType } from '@powersync/web';

export const DOCUMENTS_TABLE = 'mobile_search_documents';
export const DOCUMENTS_FTS_TABLE = 'mobile_search_documents_fts';

/**
 * The columns the device keeps, in the order the `put` statement binds them.
 * The sync rule also sends `user_id`, `created_at` and `updated_at`; nothing on
 * the device reads them (the replica is one user's, wiped on sign-out), so
 * they are not stored.
 */
export const DOCUMENTS_COLUMNS = ['entity_type', 'entity_id', 'title', 'body', 'occurred_at'] as const;

/** The FTS5 columns, in order — `bm25()` weights in localSearch.ts follow this order. */
export const DOCUMENTS_FTS_COLUMNS = ['title', 'body'] as const;

/**
 * A download of at least this many operations is applied without the index
 * triggers (see the module comment). A routine sync is a few hundred
 * operations; a re-download of the bucket is a million. The size is the
 * download's total since the last applied checkpoint, not what is left to
 * fetch: an app killed mid-apply comes back with every operation already
 * downloaded and the whole apply still ahead of it.
 */
export const BULK_DOWNLOAD_OPERATIONS = 5_000;

const FTS_TRIGGER_SUFFIXES = ['insert', 'update', 'delete'] as const;

/**
 * The table itself. `id` is the server's `ci_search.vectors` row id. Not
 * `WITHOUT ROWID`: the FTS index is keyed by this table's rowid, and the
 * upsert in {@link DOCUMENTS_RAW_TABLE} keeps a row's rowid across updates.
 */
export const DOCUMENTS_TABLE_DDL = `CREATE TABLE IF NOT EXISTS ${DOCUMENTS_TABLE} (
  id TEXT PRIMARY KEY NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  occurred_at TEXT
)`;

/**
 * How the sync client writes this table. `put` is an upsert, deliberately not
 * `INSERT OR REPLACE`: REPLACE deletes and re-inserts the row, which changes
 * its rowid and — unless recursive triggers are on — skips the delete
 * trigger, leaving the FTS index pointing at a rowid that no longer exists.
 * `ON CONFLICT DO UPDATE` keeps the rowid and fires the update trigger.
 * `clear` runs on `disconnectAndClear()` (sign-out); the delete trigger keeps
 * the index in step with it, as it does for every row PowerSync evicts.
 */
export const DOCUMENTS_RAW_TABLE: RawTableType = {
  put: {
    sql: `INSERT INTO ${DOCUMENTS_TABLE} (id, ${DOCUMENTS_COLUMNS.join(', ')})
          VALUES (?, ?, ?, coalesce(?, ''), coalesce(?, ''), ?)
          ON CONFLICT(id) DO UPDATE SET
            entity_type = excluded.entity_type,
            entity_id = excluded.entity_id,
            title = excluded.title,
            body = excluded.body,
            occurred_at = excluded.occurred_at`,
    params: ['Id', ...DOCUMENTS_COLUMNS.map((column) => ({ Column: column }))],
  },
  delete: { sql: `DELETE FROM ${DOCUMENTS_TABLE} WHERE id = ?`, params: ['Id'] },
  clear: `DELETE FROM ${DOCUMENTS_TABLE}`,
};

/** The statements that install the three triggers, in order. */
export function searchIndexTriggerStatements(): string[] {
  const table = DOCUMENTS_TABLE;
  const fts = DOCUMENTS_FTS_TABLE;
  const columns = DOCUMENTS_FTS_COLUMNS.join(', ');
  const newValues = DOCUMENTS_FTS_COLUMNS.map((column) => `NEW.${column}`).join(', ');
  const oldValues = DOCUMENTS_FTS_COLUMNS.map((column) => `OLD.${column}`).join(', ');

  return [
    `CREATE TRIGGER IF NOT EXISTS ${fts}_insert AFTER INSERT ON ${table} BEGIN
       INSERT INTO ${fts}(rowid, ${columns}) VALUES (NEW.rowid, ${newValues});
     END`,
    `CREATE TRIGGER IF NOT EXISTS ${fts}_update AFTER UPDATE ON ${table} BEGIN
       INSERT INTO ${fts}(${fts}, rowid, ${columns}) VALUES ('delete', OLD.rowid, ${oldValues});
       INSERT INTO ${fts}(rowid, ${columns}) VALUES (NEW.rowid, ${newValues});
     END`,
    `CREATE TRIGGER IF NOT EXISTS ${fts}_delete AFTER DELETE ON ${table} BEGIN
       INSERT INTO ${fts}(${fts}, rowid, ${columns}) VALUES ('delete', OLD.rowid, ${oldValues});
     END`,
  ];
}

/** The statements that drop the triggers, leaving the table and the index. */
export function searchIndexSuspendStatements(): string[] {
  return FTS_TRIGGER_SUFFIXES.map((suffix) => `DROP TRIGGER IF EXISTS ${DOCUMENTS_FTS_TABLE}_${suffix}`);
}

/** Re-index everything from the table (FTS5's `rebuild`), then put the triggers back. */
export function searchIndexResumeStatements(): string[] {
  return [
    `INSERT INTO ${DOCUMENTS_FTS_TABLE}(${DOCUMENTS_FTS_TABLE}) VALUES ('rebuild')`,
    ...searchIndexTriggerStatements(),
  ];
}

/**
 * The statements that create the index and its triggers, in order. Exported
 * for the test.
 *
 * The index is an external-content FTS5 table: it stores only the inverted
 * index and reads the text back from the documents table by rowid, which is
 * also what the `rebuild` command below indexes from. The three triggers are
 * the ones the FTS5 documentation prescribes for external content; the
 * update one is a delete of the old text plus an insert of the new.
 */
export function searchIndexStatements(): string[] {
  const columns = DOCUMENTS_FTS_COLUMNS.join(', ');

  return [
    `CREATE VIRTUAL TABLE IF NOT EXISTS ${DOCUMENTS_FTS_TABLE} USING fts5(${columns}, content='${DOCUMENTS_TABLE}', tokenize = 'unicode61 remove_diacritics 2')`,
    // Rows that synced before the index existed, then the triggers.
    ...searchIndexResumeStatements(),
  ];
}

/**
 * Create the documents table if this file does not have it yet, and adopt
 * any rows PowerSync parked in `ps_untyped` for it. Must complete before
 * `connect()`.
 *
 * `ps_untyped` is where PowerSync moves a table's rows when the table leaves
 * the managed schema — which is what happened to every replica built while
 * `mobile_search_documents` was still a managed table. Adopting them means
 * no re-download; the upsert in `put` then overwrites them row by row as
 * newer data arrives. The copy ignores rows already present, so a second
 * open after a half-finished adoption is safe.
 */
export async function ensureDocumentsTable(db: AbstractPowerSyncDatabase): Promise<void> {
  await db.waitForReady();

  await db.writeTransaction(async (tx) => {
    await tx.execute(DOCUMENTS_TABLE_DDL);
    await tx.execute(
      `INSERT INTO ${DOCUMENTS_TABLE} (id, ${DOCUMENTS_COLUMNS.join(', ')})
         SELECT id,
                json_extract(data, '$.entity_type'),
                json_extract(data, '$.entity_id'),
                coalesce(json_extract(data, '$.title'), ''),
                coalesce(json_extract(data, '$.body'), ''),
                json_extract(data, '$.occurred_at')
           FROM ps_untyped
          WHERE type = ? AND json_extract(data, '$.entity_type') IS NOT NULL
             ON CONFLICT(id) DO NOTHING`,
      [DOCUMENTS_TABLE],
    );
    await tx.execute(`DELETE FROM ps_untyped WHERE type = ?`, [DOCUMENTS_TABLE]);
  });
}

/**
 * Whether the index exists in this file in its current shape, with its
 * triggers. A table of the earlier shape (a contentful index over PowerSync's
 * JSON storage, from before this was a raw table) does not count, and nor
 * does an index whose triggers are missing — the app was killed during a
 * bulk download, after {@link watchBulkDownloads} dropped them — since rows
 * have reached the table unindexed. {@link ensureSearchIndex} rebuilds either.
 */
export async function hasSearchIndex(db: AbstractPowerSyncDatabase): Promise<boolean> {
  const row = await db.getOptional<{ table_sql: string | null; triggers: number }>(
    `SELECT (SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?) AS table_sql,
            (SELECT count(*) FROM sqlite_master WHERE type = 'trigger' AND name IN (?, ?, ?)) AS triggers`,
    [DOCUMENTS_FTS_TABLE, ...FTS_TRIGGER_SUFFIXES.map((suffix) => `${DOCUMENTS_FTS_TABLE}_${suffix}`)],
  );

  return (
    (row?.table_sql?.includes(`content='${DOCUMENTS_TABLE}'`) ?? false) &&
    row?.triggers === FTS_TRIGGER_SUFFIXES.length
  );
}

/**
 * Create the index and its triggers if this file does not have them yet.
 * Resolves `true` when it built them on this call.
 *
 * Waits for the database to be ready first: the documents table is created
 * on open, and the triggers attach to it.
 */
export async function ensureSearchIndex(
  db: AbstractPowerSyncDatabase,
  { signal }: { signal?: AbortSignal } = {},
): Promise<boolean> {
  await db.waitForReady();

  if (await hasSearchIndex(db)) {
    return false;
  }

  if (!db.currentStatus.hasSynced) {
    // See the module comment: the rebuild below is far cheaper than the
    // triggers would be during the first download. On a deployment with no
    // PowerSync service this never resolves, which is right — there is nothing
    // to index — and the caller's abort releases it when the database goes.
    try {
      await db.waitForFirstSync({ signal });
    } catch (error) {
      if (signal?.aborted) {
        return false;
      }

      throw error;
    }
  }

  if (signal?.aborted) {
    return false;
  }

  await db.writeTransaction(async (tx) => {
    // An index of the earlier shape, if any; its triggers went with the
    // managed table they were attached to.
    await tx.execute(`DROP TABLE IF EXISTS ${DOCUMENTS_FTS_TABLE}`);

    for (const statement of searchIndexStatements()) {
      await tx.execute(statement);
    }
  });

  return true;
}

/**
 * Keep the index out of the way of bulk downloads. Registers a sync-status
 * listener: when a download of at least `threshold` operations starts, the
 * triggers are dropped so PowerSync's checkpoint apply writes the table alone;
 * when the download has applied, the index is rebuilt from the table in one
 * pass and the triggers go back. A download below the threshold is left to
 * the triggers. Returns the function that stops watching.
 *
 * `onChange` is told what happened, for the log. The rebuild is skipped when
 * the index does not exist yet ({@link ensureSearchIndex} builds it, with its
 * triggers, after the first sync).
 */
export function watchBulkDownloads(
  db: AbstractPowerSyncDatabase,
  {
    threshold = BULK_DOWNLOAD_OPERATIONS,
    onChange,
  }: { threshold?: number; onChange?: (event: 'suspended' | 'resumed', operations: number) => void } = {},
): () => void {
  let suspended = false;
  let operations = 0;
  // Serialises the two transitions so a resume never overtakes its suspend.
  let chain: Promise<void> = Promise.resolve();

  const run = (step: () => Promise<void>) => {
    chain = chain.then(step).catch((error: unknown) => {
      console.warn('[PowerSync] Could not adjust the on-device search index around a bulk download', error);
    });
  };

  const unregister = db.registerListener({
    statusChanged: (status) => {
      const downloading = status.dataFlowStatus.downloading;
      const total = status.downloadProgress?.totalOperations ?? 0;

      if (!suspended && downloading && total >= threshold) {
        suspended = true;
        operations = total;
        run(async () => {
          await db.writeTransaction(async (tx) => {
            for (const statement of searchIndexSuspendStatements()) {
              await tx.execute(statement);
            }
          });
          onChange?.('suspended', operations);
        });
      } else if (suspended && !downloading) {
        suspended = false;
        run(async () => {
          const exists = await db.getOptional<{ name: string }>(
            `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
            [DOCUMENTS_FTS_TABLE],
          );

          if (!exists) {
            return;
          }

          await db.writeTransaction(async (tx) => {
            for (const statement of searchIndexResumeStatements()) {
              await tx.execute(statement);
            }
          });
          onChange?.('resumed', operations);
        });
      }
    },
  });

  return () => {
    unregister();
  };
}

/** How many documents this device holds — the "there is something to search" signal. */
export async function countDocuments(db: AbstractPowerSyncDatabase): Promise<number> {
  try {
    const row = await db.getOptional<{ n: number }>(`SELECT count(*) AS n FROM ${DOCUMENTS_TABLE}`);

    return typeof row?.n === 'number' ? row.n : 0;
  } catch {
    return 0;
  }
}
