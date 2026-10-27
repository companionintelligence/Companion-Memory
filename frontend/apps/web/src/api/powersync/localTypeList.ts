/**
 * One entity type's list answered from this phone: the records of that type among the
 * synced `mobile_search_documents`, in a browse order, or ranked by the FTS index for a
 * query. The per-type pages (places, things, receipts, content) read it while the Memory
 * server does not answer; `localPeople.ts` is the same shape for people.
 *
 * Two browse orders, chosen per type by the caller:
 *
 * - `title`: by name, unnamed last. For the small sets (places, things), where sorting
 *   every row of the type is nothing.
 * - `newest`: by time, undated last. For the bulk sets (content, receipts), where the
 *   (entity_type, occurred_at) index walks the rows in order and nothing is sorted.
 *
 * A single type is the narrow scope the planner rules in `localList.ts` describe: the
 * bare type term uses the type index for a browse, and the `+` prefix keeps it off that
 * index when the FTS scan drives.
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

export const LOCAL_TYPE_LIST_PAGE_SIZE = 30;

export type LocalTypeOrder = 'title' | 'newest';

const COLUMNS = 'd.id, d.entity_type, d.entity_id, d.title, d.body, d.occurred_at, d.related_id, d.detail';

const ORDER_BY: Record<LocalTypeOrder, string> = {
  title: 'ORDER BY d.title IS NULL, d.title COLLATE NOCASE, d.id',
  // NULL sorts below every value in SQLite, so DESC puts the undated rows last.
  newest: 'ORDER BY d.occurred_at DESC, d.id',
};

/** The SQL for one page. Exported for the test; `listLocalByType` runs it. */
export function localTypeListStatement(
  entityType: string,
  order: LocalTypeOrder,
  query: string,
  page: { limit: number; offset: number },
): { sql: string; params: unknown[] } | null {
  const match = ftsMatchExpression(query);

  if (query.trim().length > 0 && match == null) {
    return null;
  }

  if (match == null) {
    return {
      sql: `SELECT ${COLUMNS}
              FROM ${DOCUMENTS_TABLE} d
             WHERE d.entity_type = ?
             ${ORDER_BY[order]}
             LIMIT ? OFFSET ?`,
      params: [entityType, page.limit, page.offset],
    };
  }

  return {
    sql: `SELECT ${COLUMNS}
            FROM ${DOCUMENTS_FTS_TABLE}
            JOIN ${DOCUMENTS_TABLE} d ON d.rowid = ${DOCUMENTS_FTS_TABLE}.rowid
           WHERE ${DOCUMENTS_FTS_TABLE} MATCH ?
             AND +d.entity_type = ?
           ORDER BY bm25(${DOCUMENTS_FTS_TABLE}, ${FTS_RANK_WEIGHTS}), d.id
           LIMIT ? OFFSET ?`,
    params: [match, entityType, page.limit, page.offset],
  };
}

export function localTypeListCountStatement(
  entityType: string,
  query: string,
): { sql: string; params: unknown[] } | null {
  const match = ftsMatchExpression(query);

  if (query.trim().length > 0 && match == null) {
    return null;
  }

  if (match == null) {
    return {
      sql: `SELECT count(*) AS n FROM ${DOCUMENTS_TABLE} d WHERE d.entity_type = ?`,
      params: [entityType],
    };
  }

  return {
    sql: `SELECT count(*) AS n
            FROM ${DOCUMENTS_FTS_TABLE}
            JOIN ${DOCUMENTS_TABLE} d ON d.rowid = ${DOCUMENTS_FTS_TABLE}.rowid
           WHERE ${DOCUMENTS_FTS_TABLE} MATCH ?
             AND +d.entity_type = ?`,
    params: [match, entityType],
  };
}

export async function listLocalByType(
  db: AbstractPowerSyncDatabase,
  entityType: string,
  order: LocalTypeOrder,
  query: string,
  page: { limit?: number; offset?: number } = {},
): Promise<LocalDocument[]> {
  const statement = localTypeListStatement(entityType, order, query, {
    limit: page.limit ?? LOCAL_TYPE_LIST_PAGE_SIZE,
    offset: page.offset ?? 0,
  });

  if (statement == null) {
    return [];
  }

  const rows = await db.getAll<DocumentRow>(statement.sql, statement.params);

  return rows.map(toLocalDocument);
}

export async function countLocalByType(
  db: AbstractPowerSyncDatabase,
  entityType: string,
  query: string,
): Promise<number> {
  const statement = localTypeListCountStatement(entityType, query);

  if (statement == null) {
    return 0;
  }

  const row = await db.get<{ n: number }>(statement.sql, statement.params);

  return row?.n ?? 0;
}
