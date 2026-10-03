import type { EntityManager } from 'typeorm';

import { GRAPH_ENTITY_TYPES, type GraphEntityKind } from '../graph.types';

import { type BareReferenceKind, deleteBareReferences, deleteMergeBookkeeping } from './purgeTeardown';

/** What a purge of one kind of graph entity does that the others do not. */
export interface GraphEntityPurge {
  kind: GraphEntityKind;
  /** What names a node of this kind by id and has no foreign key to say so. */
  references: BareReferenceKind;
  /**
   * Whatever is specific to the kind. Runs once the nodes are locked and the
   * duplicates found, before ANY row is deleted, so it still sees the identifiers,
   * the pointers and the children it needs. `ids` is every node about to go,
   * duplicates included.
   */
  prepare?: (manager: EntityManager, scope: { userId: string; ids: string[] }) => Promise<void>;
}

/** What one purge removed, for the caller to announce once the transaction has committed. */
export interface PurgedGraphEntities {
  /** The nodes that were asked for and went. */
  ids: string[];
  /**
   * The duplicates that had been merged into those and went with them, which nobody
   * asked for: the tombstones a merge leaves behind. The caller says so, because they
   * were deleted unnamed.
   */
  duplicateIds: string[];
}

/**
 * Permanently deletes people, places or concepts, and everything that has no
 * meaning without them, inside the caller's transaction. The part of the three
 * purges that is the same; {@link GraphEntityPurge.prepare} is the part that is not.
 *
 * Unlike an event, an item or a communication these are not a detail row behind a
 * node: the `ci.entities` row IS the record, so there is no cascade to lean on and
 * nothing the delete can be refused over but the foreign keys onto `ci.entities`
 * itself. Those that matter here are `ci.users.entity_id` (the user's own Person
 * must stay), which refuses the delete and rolls the whole transaction back, and
 * the `ON DELETE SET NULL` ones, which the schema decided long ago: an event's or a
 * photo's place, a receipt's merchant, an item's last-seen place and, for a place,
 * its children's parent.
 *
 * What it deletes, in order:
 *
 *  1. Whatever the kind prepares ({@link GraphEntityPurge.prepare}).
 *  2. **Everything that names the id with no foreign key**
 *     ({@link deleteBareReferences}): the edges in both directions and their
 *     deltas, the pipeline state and dead letters, the tags, categories and search
 *     rows, the node's own deltas, which carry its name, and, because the identifier
 *     index resolves to these, its identifiers and the resolution of every claim
 *     that named it.
 *  3. **The merge bookkeeping** ({@link deleteMergeBookkeeping}): the snapshot of
 *     every row a merge folded away, which for a person is their emails and phone
 *     numbers, and the pairs somebody ruled on.
 *  4. **Its staged import mappings.** `ci_import.entity_mappings` maps a staged
 *     entity onto the node it became, and `PushStage` reads it to write a staged
 *     message's participants. A mapping left behind would put the dead id into
 *     messages pushed after this.
 *  5. The nodes.
 *
 * ── The duplicates that were merged into it go with it ─────────────────────
 *
 * A merge folds a person or a place into a survivor and leaves it behind as a
 * hidden tombstone: an inactive node with `merged_into_entity_id` set, still holding
 * the name and the emails and phone numbers it had. That pointer is `ON DELETE SET
 * NULL`, so deleting the survivor the old way turned each tombstone into an
 * archived node of its own, with all of it. The user decided this once for items
 * and it is the same hazard here, worse for a person: the duplicates are the same
 * person as the survivor, nobody sees a tombstone to name it, and what it holds is
 * exactly what was to be forgotten. They go in the same transaction, to any depth
 * of legacy chain. They are looked up after the survivor is locked, and a merge
 * locks its target, so one that was committing into it is either seen or waits and
 * finds it gone.
 *
 * A tombstone asked for by name goes alone: its survivor already has what was folded
 * into it, and is not this call's to delete. What a merge folded INTO a survivor
 * stays with the survivor.
 *
 * What it deliberately leaves alone is every record that merely MENTIONS the node:
 * the messages and events that name a person by address, and the period summaries
 * and text that mention one. Those are records in their own right.
 *
 * Only the caller's own nodes are purged, in any state: an archived node or a
 * tombstone is purged like any other. An id that does not exist, that belongs to
 * someone else or that is a node of another kind is left out of the result rather
 * than raising.
 */
export async function purgeGraphEntities(
  manager: EntityManager,
  userId: string,
  requestedIds: string[],
  purge: GraphEntityPurge,
): Promise<PurgedGraphEntities> {
  const types = GRAPH_ENTITY_TYPES[purge.kind];

  // Locked, and in a fixed order, so two purges cannot deadlock each other. A merge into one of them
  // locks its target first, so it waits here, or is waited for.
  const asked: Array<{ id: string }> = await manager.query(
    `SELECT entity_id AS id
       FROM ci.entities
      WHERE entity_id = ANY($1::uuid[])
        AND owner_user_id = $2
        AND entity_type = ANY($3::text[])
      ORDER BY entity_id
        FOR UPDATE`,
    [requestedIds, userId, types],
  );

  if (asked.length === 0) {
    return { ids: [], duplicateIds: [] };
  }

  const ids = asked.map((row) => row.id);

  // Whatever was merged into them, however many merges deep a legacy chain goes. `UNION` and not `UNION
  // ALL`, so a pointer that loops back cannot spin.
  const duplicates: Array<{ id: string }> = await manager.query(
    `WITH RECURSIVE family AS (
       SELECT entity_id FROM ci.entities WHERE entity_id = ANY($1::uuid[]) AND owner_user_id = $2
       UNION
       SELECT e.entity_id
         FROM ci.entities e
         JOIN family f ON e.merged_into_entity_id = f.entity_id
        WHERE e.owner_user_id = $2
          AND e.entity_type = ANY($3::text[])
     )
     SELECT entity_id AS id
       FROM family
      WHERE NOT (entity_id = ANY($1::uuid[]))
      ORDER BY entity_id`,
    [ids, userId, types],
  );
  const duplicateIds = duplicates.map((row) => row.id);
  const everyId = [...ids, ...duplicateIds];

  await purge.prepare?.(manager, { userId, ids: everyId });
  await deleteBareReferences(manager, everyId, purge.references);
  await deleteMergeBookkeeping(manager, everyId);
  await manager.query(
    `DELETE FROM ci_import.entity_mappings WHERE user_id = $1 AND server_entity_id = ANY($2::uuid[])`,
    [userId, everyId],
  );

  // The nodes. This is where `ci.users.entity_id` refuses the user's own Person, and with it everything above.
  await manager.query(
    `DELETE FROM ci.entities
      WHERE entity_id = ANY($1::uuid[])
        AND owner_user_id = $2
        AND entity_type = ANY($3::text[])`,
    [everyId, userId, types],
  );

  return { ids, duplicateIds };
}
