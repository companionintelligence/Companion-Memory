/**
 * One device record, and the records around it, for the offline record page
 * (`pages/LocalRecordPage`): the row for an entity, and its siblings by
 * `related_id` — a message's conversation, a parent's sub-events — in time
 * order, a window at a time.
 */
import type { AbstractPowerSyncDatabase } from '@powersync/web';

import { type DocumentRow, type LocalDocument, toLocalDocument } from './localSearch';
import { DOCUMENTS_TABLE } from './searchIndex';

const COLUMNS = 'd.id, d.entity_type, d.entity_id, d.title, d.body, d.occurred_at, d.related_id, d.detail';

/** The record for an entity, by its type and raw id (served by the entity_id index), or null. */
export async function getLocalDocument(
  db: AbstractPowerSyncDatabase,
  entityType: string,
  entityId: string,
): Promise<LocalDocument | null> {
  const row = await db.getOptional<DocumentRow>(
    `SELECT ${COLUMNS} FROM ${DOCUMENTS_TABLE} d WHERE d.entity_id = ? AND d.entity_type = ?`,
    [entityId, entityType],
  );

  return row ? toLocalDocument(row) : null;
}

/**
 * The record an id points at, whatever its type — what a `related_id` that
 * is an entity id (a sub-event's parent, a file's parent, content's event)
 * resolves to. A conversation key is not an entity and resolves to nothing.
 */
export async function getLocalDocumentByEntityId(
  db: AbstractPowerSyncDatabase,
  entityId: string,
): Promise<LocalDocument | null> {
  const row = await db.getOptional<DocumentRow>(
    `SELECT ${COLUMNS} FROM ${DOCUMENTS_TABLE} d WHERE d.entity_id = ? LIMIT 1`,
    [entityId],
  );

  return row ? toLocalDocument(row) : null;
}

/** Where a sibling sits in the conversation's order: its time (undated last), then its id. */
export interface SiblingCursor {
  occurredAt: string | null;
  id: string;
}

export const SIBLINGS_PAGE_SIZE = 20;

/**
 * Siblings sharing a `related_id`, ordered by time then id, on one side of a
 * cursor: `before` the cursor, newest first (the caller reverses them), or
 * `after` it, oldest first. The row at the cursor is not included. Undated
 * rows sort last, as the list does.
 */
export function siblingsStatement(
  relatedId: string,
  side: 'before' | 'after',
  cursor: SiblingCursor,
  limit: number,
): { sql: string; params: unknown[] } {
  // `coalesce` keeps NULL times comparable and last: '~' sorts after any digit.
  const key = "coalesce(d.occurred_at, '~')";
  const op = side === 'before' ? '<' : '>';
  const order = side === 'before' ? 'DESC' : 'ASC';

  return {
    sql: `SELECT ${COLUMNS} FROM ${DOCUMENTS_TABLE} d
           WHERE d.related_id = ?
             AND (${key}, d.id) ${op} (?, ?)
           ORDER BY ${key} ${order}, d.id ${order}
           LIMIT ?`,
    params: [relatedId, cursor.occurredAt ?? '~', cursor.id, limit],
  };
}

/** One side of a record's siblings, in reading order (oldest first). */
export async function listSiblings(
  db: AbstractPowerSyncDatabase,
  relatedId: string,
  side: 'before' | 'after',
  cursor: SiblingCursor,
  limit: number = SIBLINGS_PAGE_SIZE,
): Promise<LocalDocument[]> {
  const statement = siblingsStatement(relatedId, side, cursor, limit);
  const rows = await db.getAll<DocumentRow>(statement.sql, statement.params);
  const documents = rows.map(toLocalDocument);

  return side === 'before' ? documents.reverse() : documents;
}

/** How many records share a `related_id`: a conversation's length. */
export async function countSiblings(db: AbstractPowerSyncDatabase, relatedId: string): Promise<number> {
  const row = await db.getOptional<{ n: number }>(
    `SELECT count(*) AS n FROM ${DOCUMENTS_TABLE} WHERE related_id = ?`,
    [relatedId],
  );

  return row?.n ?? 0;
}
