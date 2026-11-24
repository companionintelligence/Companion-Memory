/**
 * The tags list answered from this phone: every tag the device has synced (`tags`, a
 * read replica) with how many records carry it (`entity_tag`, likewise), by label.
 *
 * The appliance's `tags` connection reports `entityCount` the same way; what the device
 * cannot do is rename, merge or delete a tag -- those are server writes, and the offline
 * tags page offers none of them.
 */
import type { AbstractPowerSyncDatabase } from '@powersync/web';

export interface LocalTag {
  id: string;
  label: string;
  description: string | null;
  entityCount: number;
}

interface TagRow {
  id: string;
  label: string;
  description: string | null;
  n: number;
}

/** Exported for the test; `listLocalTags` runs it. */
export function localTagsStatement(): { sql: string; params: unknown[] } {
  return {
    // Deleted tags stay in the replica with `deleted_at` set (the server soft-deletes),
    // and their entity_tag rows go with them, so the join is filtered on the tag side.
    // `entity_tag.tag_id` is indexed (schema.ts), so each tag's count is one index range.
    sql: `SELECT t.id, t.label, t.description, count(et.id) AS n
            FROM tags t
            LEFT JOIN entity_tag et ON et.tag_id = t.id
           WHERE t.deleted_at IS NULL
           GROUP BY t.id, t.label, t.description
           ORDER BY t.label COLLATE NOCASE, t.id`,
    params: [],
  };
}

export async function listLocalTags(db: AbstractPowerSyncDatabase): Promise<LocalTag[]> {
  const statement = localTagsStatement();
  const rows = await db.getAll<TagRow>(statement.sql, statement.params);

  return rows.map((row) => ({
    id: row.id,
    label: row.label,
    description: row.description ?? null,
    entityCount: Number(row.n) || 0,
  }));
}
