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
 * The columns the device keeps, in the order the `put` statement binds them —
 * and, since 2026-10-22, exactly the columns the sync rule sends. `user_id`,
 * `created_at` and `updated_at` used to arrive and be dropped here; they left
 * the sync rule because PowerSync keeps every synced column a second time in
 * its oplog, where the three cost ~50 MB over 589k rows.
 *
 * `related_id` and `detail` (server migration 20261021203300) are what makes
 * a row a *device record* rather than a search entry: the row it belongs with
 * (a message's conversation, a sub-event's parent, a file's parent) and a
 * small JSON of per-type display fields, which arrives as text. The offline
 * record page reads them; search does not.
 */
export const DOCUMENTS_COLUMNS = [
  'entity_type',
  'entity_id',
  'title',
  'body',
  'occurred_at',
  'related_id',
  'detail',
] as const;

/**
 * The `detail` fields the explorer's filters read, as virtual generated
 * columns: computed from the JSON on read, stored nowhere, but indexable —
 * which is the point. A filter over a JSON field is otherwise a
 * `json_extract` per row of whatever the scan admits: a place name over all
 * 224k events took 20 s on the S23U, the same filter through the partial
 * index below ~0. See localList.ts for which index each filter leans on.
 *
 * `content_type` gets no index: file kinds apply to the 23k files only.
 * `direction` halves a scope already pinned to messages, but its count was a
 * 17 s walk of 200k rows that held up the plugin's one thread, so it has one
 * — carrying the type too, so the count never leaves the index (1.9 s when
 * it had to fetch each row for the type).
 */
export const DOCUMENTS_GENERATED_COLUMNS: ReadonlyArray<{ name: string; ddl: string }> = [
  'source_system',
  'direction',
  'event_type',
  'content_type',
  'location_id',
  'location_name',
  'from_id',
  'to_ids',
  'people',
  'lat',
  'lng',
  'preview_id',
].map((name) => ({
  name,
  ddl: `${name} ${name === 'lat' || name === 'lng' ? 'REAL' : 'TEXT'} GENERATED ALWAYS AS (json_extract(detail, '$.${name}')) VIRTUAL`,
}));

/**
 * The columns added after the table first shipped, which an existing replica
 * gains through `ALTER TABLE` in {@link ensureDocumentsTable}. New columns go
 * here as well as in {@link DOCUMENTS_TABLE_DDL}: SQLite has no
 * `ADD COLUMN IF NOT EXISTS`, so the function checks `pragma_table_xinfo`
 * (the `x` form: plain `table_info` hides generated columns). In order: the
 * generated columns read `detail`, which must exist first.
 */
export const DOCUMENTS_ADDED_COLUMNS: ReadonlyArray<{ name: string; ddl: string }> = [
  { name: 'related_id', ddl: 'related_id TEXT' },
  { name: 'detail', ddl: 'detail TEXT' },
  ...DOCUMENTS_GENERATED_COLUMNS,
];

/**
 * Siblings by `related_id` (a conversation's messages, a parent's sub-events)
 * are what the record page lists, in time order either side of the record
 * (localRecord.ts, `siblingsStatement`). The index carries that order — the
 * same `coalesce(occurred_at, '~')` the statement sorts and seeks by, so the
 * keyset is an index seek and a page is 20 rows read. On `related_id` alone
 * each page sorted the whole conversation first: 5 s per side for a 103,803-
 * message thread on the S23U, 10 s from tap to conversation. Partial, since
 * most rows have no related row and would only pad the index.
 */
export const DOCUMENTS_RELATED_INDEX = 'mobile_search_documents_related_time_idx';
export const DOCUMENTS_RELATED_INDEX_DDL = `CREATE INDEX IF NOT EXISTS ${DOCUMENTS_RELATED_INDEX}
  ON ${DOCUMENTS_TABLE} (related_id, coalesce(occurred_at, '~'), id) WHERE related_id IS NOT NULL`;

/** Indexes an earlier build created under another definition; dropped on startup so they stop costing writes. */
export const DOCUMENTS_RETIRED_INDEXES: readonly string[] = ['mobile_search_documents_related_idx'];

/**
 * The offline browse (localList.ts) orders by time when there is no query to
 * rank by, and the explorer's Newest / Oldest sorts do so always. Two indexes
 * carry that, because one type scope is not like another on a 589k-row table
 * (measured on the S23U, 2026-10-22):
 *
 * - `occurred_at` alone, walked backwards, answers a broad scope (the bare
 *   browse, or any scope that keeps messages, events or content — 95% of the
 *   rows) in milliseconds: nearly every row it meets qualifies.
 * - `(entity_type, occurred_at)` answers a narrow scope (Receipts, Tasks)
 *   from its own range instead of a 5 s walk past every other row, and lets
 *   a count over a type scope and a date range come from the index alone.
 *
 * localList.ts picks which by scope; see its `typeTerm`.
 */
export const DOCUMENTS_OCCURRED_INDEX = 'mobile_search_documents_occurred_idx';
export const DOCUMENTS_OCCURRED_INDEX_DDL = `CREATE INDEX IF NOT EXISTS ${DOCUMENTS_OCCURRED_INDEX}
  ON ${DOCUMENTS_TABLE} (occurred_at)`;
export const DOCUMENTS_TYPE_TIME_INDEX = 'mobile_search_documents_type_time_idx';
/** The located rows, `(lat, lng)` where `lat IS NOT NULL`: the map's set, and what `listLocalPins` names outright. */
export const DOCUMENTS_GEO_INDEX = 'mobile_search_documents_geo_idx';
export const DOCUMENTS_TYPE_TIME_INDEX_DDL = `CREATE INDEX IF NOT EXISTS ${DOCUMENTS_TYPE_TIME_INDEX}
  ON ${DOCUMENTS_TABLE} (entity_type, occurred_at)`;

/**
 * A record by the entity it describes: the offline tag filter joins the
 * tagged (entity_type, entity_id) pairs into this table, and the record page
 * opens a record the same way. The id alone is as good as unique, so the
 * type is checked on the row rather than carried in the index.
 */
export const DOCUMENTS_ENTITY_INDEX = 'mobile_search_documents_entity_idx';
export const DOCUMENTS_ENTITY_INDEX_DDL = `CREATE INDEX IF NOT EXISTS ${DOCUMENTS_ENTITY_INDEX}
  ON ${DOCUMENTS_TABLE} (entity_id)`;

/**
 * The filter indexes over the generated columns, each partial where the
 * field is sparse so it holds only the rows that can match: coordinates
 * (2.7k events), places (a few hundred), an event's people (a few hundred).
 * A message's sender and recipients cover most messages, so those carry
 * time order too, which is what the Who filter sorts by.
 */
export const DOCUMENTS_FILTER_INDEX_DDL: readonly string[] = [
  `CREATE INDEX IF NOT EXISTS ${DOCUMENTS_TABLE}_source_idx ON ${DOCUMENTS_TABLE} (source_system, occurred_at)`,
  `CREATE INDEX IF NOT EXISTS ${DOCUMENTS_TABLE}_direction_idx ON ${DOCUMENTS_TABLE} (direction, occurred_at, entity_type) WHERE direction IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS ${DOCUMENTS_TABLE}_event_type_idx ON ${DOCUMENTS_TABLE} (event_type, occurred_at) WHERE event_type IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS ${DOCUMENTS_TABLE}_location_idx ON ${DOCUMENTS_TABLE} (location_id) WHERE location_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS ${DOCUMENTS_TABLE}_location_name_idx ON ${DOCUMENTS_TABLE} (location_name) WHERE location_name IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS ${DOCUMENTS_TABLE}_from_idx ON ${DOCUMENTS_TABLE} (from_id, occurred_at) WHERE from_id IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS ${DOCUMENTS_TABLE}_to_idx ON ${DOCUMENTS_TABLE} (occurred_at) WHERE to_ids IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS ${DOCUMENTS_TABLE}_people_idx ON ${DOCUMENTS_TABLE} (occurred_at) WHERE people IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS ${DOCUMENTS_GEO_INDEX} ON ${DOCUMENTS_TABLE} (lat, lng) WHERE lat IS NOT NULL`,
  // The photos and videos with a preview on the appliance: what the preview
  // store downloads (previews.ts) and what the offline gallery lists.
  `CREATE INDEX IF NOT EXISTS ${DOCUMENTS_TABLE}_preview_idx ON ${DOCUMENTS_TABLE} (preview_id, occurred_at) WHERE preview_id IS NOT NULL`,
];

/**
 * Every index the app keeps on the table, created after the columns are
 * current. None is needed by the sync client's `put` (its upsert keys on the
 * primary key), so {@link watchBulkDownloads} drops them all for a bulk
 * download and rebuilds them with the FTS index after: thirteen b-trees
 * maintained row by row would slow a 600k-row apply far more than the ~45 s
 * their rebuild takes on the S23U.
 */
export const DOCUMENTS_INDEX_DDL: readonly string[] = [
  DOCUMENTS_RELATED_INDEX_DDL,
  DOCUMENTS_OCCURRED_INDEX_DDL,
  DOCUMENTS_TYPE_TIME_INDEX_DDL,
  DOCUMENTS_ENTITY_INDEX_DDL,
  ...DOCUMENTS_FILTER_INDEX_DDL,
];

/** The names of the indexes above, for dropping. */
export const DOCUMENTS_INDEX_NAMES: readonly string[] = DOCUMENTS_INDEX_DDL.map((ddl) => {
  const match = /CREATE INDEX IF NOT EXISTS (\S+)/.exec(ddl);

  if (!match) {
    throw new Error(`Index DDL without a name: ${ddl}`);
  }

  return match[1];
});

/**
 * The FTS5 columns, in order — `bm25()` weights in localSearch.ts follow this
 * order. `title` and `body` are the text; the other three are the person ids
 * a record names (generated columns, see {@link DOCUMENTS_GENERATED_COLUMNS}),
 * indexed as text so the Who filter is a column-scoped MATCH: a uuid
 * tokenizes into its five hex groups, and the filter asks for them as a
 * phrase. Postings are the cheapest inverted index SQLite offers — 26 MB for
 * 1.56M recipient entries, against 218 MB for a side table of the same —
 * and the match count is nearly free, which the filter uses to pick its
 * plan (localList.ts, `planPeople`).
 */
export const DOCUMENTS_FTS_COLUMNS = ['title', 'body', 'from_id', 'to_ids', 'people'] as const;

/** The FTS columns that hold the record's text, for a column-scoped text query. */
export const DOCUMENTS_FTS_TEXT_COLUMNS = ['title', 'body'] as const;

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
  occurred_at TEXT,
  related_id TEXT,
  detail TEXT,
  ${DOCUMENTS_GENERATED_COLUMNS.map((column) => column.ddl).join(',\n  ')}
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
          VALUES (?, ?, ?, coalesce(?, ''), coalesce(?, ''), ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            entity_type = excluded.entity_type,
            entity_id = excluded.entity_id,
            title = excluded.title,
            body = excluded.body,
            occurred_at = excluded.occurred_at,
            related_id = excluded.related_id,
            detail = excluded.detail`,
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

/**
 * The statements that drop the triggers and the table's own indexes, leaving
 * the table and the FTS index, so a bulk download writes the table alone.
 */
export function searchIndexSuspendStatements(): string[] {
  return [
    ...FTS_TRIGGER_SUFFIXES.map((suffix) => `DROP TRIGGER IF EXISTS ${DOCUMENTS_FTS_TABLE}_${suffix}`),
    ...DOCUMENTS_INDEX_NAMES.map((name) => `DROP INDEX IF EXISTS ${name}`),
  ];
}

/** Re-index everything from the table (FTS5's `rebuild`), rebuild the indexes, then put the triggers back. */
export function searchIndexResumeStatements(): string[] {
  return [
    `INSERT INTO ${DOCUMENTS_FTS_TABLE}(${DOCUMENTS_FTS_TABLE}) VALUES ('rebuild')`,
    ...DOCUMENTS_INDEX_DDL,
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
 * Create the documents table if this file does not have it yet, bring an
 * older one up to the current columns, and adopt any rows PowerSync parked in
 * `ps_untyped` for it. Must complete before `connect()`.
 *
 * A replica built before `related_id` and `detail` existed has the table
 * without them, and `CREATE TABLE IF NOT EXISTS` leaves it that way; the
 * sync client's `put` would then fail on every row. Each missing column is
 * added with `ALTER TABLE`, and the sync-rules change that introduced the
 * columns re-sends every row, so they fill in without any device-side
 * backfill.
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

    const present = new Set(
      (await tx.getAll<{ name: string }>(`SELECT name FROM pragma_table_xinfo(?)`, [DOCUMENTS_TABLE])).map(
        (row) => row.name,
      ),
    );

    for (const column of DOCUMENTS_ADDED_COLUMNS) {
      if (!present.has(column.name)) {
        await tx.execute(`ALTER TABLE ${DOCUMENTS_TABLE} ADD COLUMN ${column.ddl}`);
      }
    }

    for (const name of DOCUMENTS_RETIRED_INDEXES) {
      await tx.execute(`DROP INDEX IF EXISTS ${name}`);
    }

    for (const statement of DOCUMENTS_INDEX_DDL) {
      await tx.execute(statement);
    }

    await tx.execute(
      `INSERT INTO ${DOCUMENTS_TABLE} (id, ${DOCUMENTS_COLUMNS.join(', ')})
         SELECT id,
                json_extract(data, '$.entity_type'),
                json_extract(data, '$.entity_id'),
                coalesce(json_extract(data, '$.title'), ''),
                coalesce(json_extract(data, '$.body'), ''),
                json_extract(data, '$.occurred_at'),
                json_extract(data, '$.related_id'),
                json_extract(data, '$.detail')
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
 * triggers. A table of an earlier shape (a contentful index over PowerSync's
 * JSON storage, from before this was a raw table; or one without the person
 * columns) does not count, and nor does an index whose triggers are missing — the app was killed during a
 * bulk download, after {@link watchBulkDownloads} dropped them — since rows
 * have reached the table unindexed. {@link ensureSearchIndex} rebuilds either.
 */
export async function hasSearchIndex(db: AbstractPowerSyncDatabase): Promise<boolean> {
  const row = await db.getOptional<{ table_sql: string | null; triggers: number }>(
    `SELECT (SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?) AS table_sql,
            (SELECT count(*) FROM sqlite_master WHERE type = 'trigger' AND name IN (?, ?, ?)) AS triggers`,
    [DOCUMENTS_FTS_TABLE, ...FTS_TRIGGER_SUFFIXES.map((suffix) => `${DOCUMENTS_FTS_TABLE}_${suffix}`)],
  );

  // The current shape names every column: an index from before the person-id
  // columns is rebuilt (the FTS rebuild took 11 s for 589k rows on the S23U).
  const currentShape = `fts5(${DOCUMENTS_FTS_COLUMNS.join(', ')}, content='${DOCUMENTS_TABLE}'`;

  return (row?.table_sql?.includes(currentShape) ?? false) && row?.triggers === FTS_TRIGGER_SUFFIXES.length;
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
