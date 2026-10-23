/**
 * The people list answered from this phone: the person records among the synced
 * `mobile_search_documents`, by name, or ranked by the FTS index for a query.
 *
 * The appliance's `people` connection orders plausible names first and carries
 * identifiers and interaction counts; the device record has a title (the name),
 * a body (what the person's record says) and `detail`. Enough for a list that
 * opens the saved record page.
 */
import type { AbstractPowerSyncDatabase } from '@powersync/web';

import {
  type DocumentRow,
  type LocalDocument,
  FTS_RANK_WEIGHTS,
  ftsMatchExpression,
  toLocalDocument,
} from './localSearch';
import { DOCUMENTS_FTS_TABLE, DOCUMENTS_TABLE } from './searchIndex';

export const LOCAL_PEOPLE_PAGE_SIZE = 30;

const COLUMNS = 'd.id, d.entity_type, d.entity_id, d.title, d.body, d.occurred_at, d.related_id, d.detail';

/** The SQL for one page. Exported for the test; `listLocalPeople` runs it. */
export function localPeopleStatement(
  query: string,
  page: { limit: number; offset: number },
): { sql: string; params: unknown[] } | null {
  const match = ftsMatchExpression(query);

  if (query.trim().length > 0 && match == null) {
    return null;
  }

  if (match == null) {
    // The type index hands over the ~2k person rows; sorting them by name is
    // nothing. Unnamed people last, not first, which is where SQLite puts NULL.
    return {
      sql: `SELECT ${COLUMNS}
              FROM ${DOCUMENTS_TABLE} d
             WHERE d.entity_type = 'person'
             ORDER BY d.title IS NULL, d.title COLLATE NOCASE, d.id
             LIMIT ? OFFSET ?`,
      params: [page.limit, page.offset],
    };
  }

  // The FTS scan drives, the type term stays off its index (see localList.ts).
  return {
    sql: `SELECT ${COLUMNS}
            FROM ${DOCUMENTS_FTS_TABLE}
            JOIN ${DOCUMENTS_TABLE} d ON d.rowid = ${DOCUMENTS_FTS_TABLE}.rowid
           WHERE ${DOCUMENTS_FTS_TABLE} MATCH ?
             AND +d.entity_type = 'person'
           ORDER BY bm25(${DOCUMENTS_FTS_TABLE}, ${FTS_RANK_WEIGHTS}), d.id
           LIMIT ? OFFSET ?`,
    params: [match, page.limit, page.offset],
  };
}

export function localPeopleCountStatement(query: string): { sql: string; params: unknown[] } | null {
  const match = ftsMatchExpression(query);

  if (query.trim().length > 0 && match == null) {
    return null;
  }

  if (match == null) {
    return {
      sql: `SELECT count(*) AS n FROM ${DOCUMENTS_TABLE} d WHERE d.entity_type = 'person'`,
      params: [],
    };
  }

  return {
    sql: `SELECT count(*) AS n
            FROM ${DOCUMENTS_FTS_TABLE}
            JOIN ${DOCUMENTS_TABLE} d ON d.rowid = ${DOCUMENTS_FTS_TABLE}.rowid
           WHERE ${DOCUMENTS_FTS_TABLE} MATCH ?
             AND +d.entity_type = 'person'`,
    params: [match],
  };
}

export async function listLocalPeople(
  db: AbstractPowerSyncDatabase,
  query: string,
  page: { limit?: number; offset?: number } = {},
): Promise<LocalDocument[]> {
  const statement = localPeopleStatement(query, {
    limit: page.limit ?? LOCAL_PEOPLE_PAGE_SIZE,
    offset: page.offset ?? 0,
  });

  if (statement == null) {
    return [];
  }

  const rows = await db.getAll<DocumentRow>(statement.sql, statement.params);

  return rows.map(toLocalDocument);
}

export async function countLocalPeople(db: AbstractPowerSyncDatabase, query: string): Promise<number> {
  const statement = localPeopleCountStatement(query);

  if (statement == null) {
    return 0;
  }

  const row = await db.get<{ n: number }>(statement.sql, statement.params);

  return row?.n ?? 0;
}
