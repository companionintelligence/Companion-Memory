/**
 * The device's full-text index over the synced `documents` table.
 *
 * PowerSync carries rows; it does not index them. This builds an FTS5 table
 * beside PowerSync's own storage and keeps it current with triggers on the
 * table PowerSync actually writes (`ps_data__documents`, one JSON blob per
 * row), which is PowerSync's documented full-text pattern. The index lives in
 * the same file as the rows, so every reader of that file — the web app here,
 * a native tool later — gets one index and never rebuilds it.
 *
 * Idempotent: the virtual table's existence is the marker. The build copies
 * whatever rows are already synced in one `INSERT … SELECT`, then installs the
 * triggers that keep the index current row by row from there on.
 *
 * ## Build after the first sync, not before
 *
 * On a device that has never synced, the build WAITS for the first full sync
 * and runs afterwards. Measured 2026-10-19 on the S23U: with the triggers in
 * place before the download, PowerSync's checkpoint apply fired them for each
 * of 582k document rows and crawled at ~200 KB/s of WAL — the plain download
 * had run ten times faster — with every other plugin call queued behind the
 * one long write for over half an hour. One bulk insert over the finished
 * table is a sort, not 582k b-tree updates. A device that already synced
 * (an upgrade adding this index) builds immediately from what it holds.
 *
 * The one case this does not cover is a sync-rules change on a device that
 * already has the triggers: PowerSync re-downloads the whole bucket through
 * them. Rare, and still correct — only slow.
 *
 * Tokenizer: `unicode61` with diacritics folded, so "Zoë" is found by "zoe".
 * SQLite does not stem the way Postgres' `english` configuration does;
 * `localSearch.ts` narrows that gap with prefix matching.
 */
import type { AbstractPowerSyncDatabase } from '@powersync/web';

export const DOCUMENTS_TABLE = 'documents';
export const DOCUMENTS_FTS_TABLE = 'documents_fts';

/** PowerSync's internal table for a schema table: `id` plus a JSON `data` column. */
const DOCUMENTS_STORAGE_TABLE = `ps_data__${DOCUMENTS_TABLE}`;

/** The FTS5 columns, in order — `bm25()` weights in localSearch.ts follow this order. */
export const DOCUMENTS_FTS_COLUMNS = ['id UNINDEXED', 'title', 'body'] as const;

/** The statements that create the index and its triggers, in order. Exported for the test. */
export function searchIndexStatements(): string[] {
  const storage = DOCUMENTS_STORAGE_TABLE;
  const fts = DOCUMENTS_FTS_TABLE;

  return [
    `CREATE VIRTUAL TABLE IF NOT EXISTS ${fts} USING fts5(${DOCUMENTS_FTS_COLUMNS.join(', ')}, tokenize = 'unicode61 remove_diacritics 2')`,
    // Rows that synced before the index existed.
    `INSERT INTO ${fts}(rowid, id, title, body)
       SELECT rowid, id, json_extract(data, '$.title'), json_extract(data, '$.body') FROM ${storage}`,
    `CREATE TRIGGER IF NOT EXISTS ${fts}_insert AFTER INSERT ON ${storage} BEGIN
       INSERT INTO ${fts}(rowid, id, title, body)
       VALUES (NEW.rowid, NEW.id, json_extract(NEW.data, '$.title'), json_extract(NEW.data, '$.body'));
     END`,
    `CREATE TRIGGER IF NOT EXISTS ${fts}_update AFTER UPDATE ON ${storage} BEGIN
       UPDATE ${fts}
          SET id = NEW.id, title = json_extract(NEW.data, '$.title'), body = json_extract(NEW.data, '$.body')
        WHERE rowid = NEW.rowid;
     END`,
    `CREATE TRIGGER IF NOT EXISTS ${fts}_delete AFTER DELETE ON ${storage} BEGIN
       DELETE FROM ${fts} WHERE rowid = OLD.rowid;
     END`,
  ];
}

/** Whether the FTS table exists in this file yet. */
export async function hasSearchIndex(db: AbstractPowerSyncDatabase): Promise<boolean> {
  const row = await db.getOptional<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`,
    [DOCUMENTS_FTS_TABLE],
  );

  return row != null;
}

/**
 * Create the index and its triggers if this file does not have them yet.
 * Resolves `true` when it built them on this call.
 *
 * Waits for the database to be ready first: PowerSync creates its storage
 * tables when the schema is applied on open, and the triggers attach to one of
 * them.
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
    // See the module comment: the bulk insert below is far cheaper than the
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
    for (const statement of searchIndexStatements()) {
      await tx.execute(statement);
    }
  });

  return true;
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
