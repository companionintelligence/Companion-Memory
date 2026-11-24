import type { EntityManager } from 'typeorm';

import { deleteBareReferences, deleteMergeBookkeeping, ITEM_REFERENCES } from './purgeTeardown';

/** What one purge removed, for the caller to announce once the transaction has committed. */
export interface PurgedItems {
  /** The items that were asked for and went. */
  itemIds: string[];
  /**
   * The duplicates that had been merged into those and went with them, which nobody asked for: the
   * tombstones a merge leaves behind. The caller says so, because they were deleted unnamed.
   */
  duplicateIds: string[];
}

/**
 * Permanently deletes items, and everything that has no meaning without them,
 * inside the caller's transaction.
 *
 * Deleting the `ci.entities` base row of an item is enough to remove the item
 * itself: it cascades to the `ci.objects` detail row. What the old delete left
 * behind was every row that names the item by id with no foreign key to say so,
 * and what it did to the rows that name it WITH one:
 *
 *  1. **Everything that names the id with no foreign key**
 *     ({@link deleteBareReferences}): the edges in both directions, the
 *     provenance ledger, the pipeline state and dead letters, the tags and
 *     categories, the search index and the graph deltas, whose `created` delta
 *     carries the title.
 *  2. **Its identifiers.** `ci.object_identifiers` holds the barcodes, serial
 *     numbers, IMEIs and VINs a unit was recognised by, keyed by the item's id.
 *     Its unique index is over the identifier and not the subject, so a claim
 *     that outlived its item went on CLAIMING the serial number: the next item
 *     with it could not take it, and a scan of it answered with a dead id.
 *  3. **The merge bookkeeping.** `ci.entity_merges` keeps a snapshot of every
 *     row a merge folded away, brand and price included, and the pending,
 *     rejected and "never merge these" pairs name the item in
 *     `ci.merge_candidates` and `ci.entity_merge_blocks`.
 *  4. **Its mentions among other items.** Another item's `related_object_ids`
 *     is an array with no foreign key to hold it, so it would list a dead id.
 *     The id is taken out of it, as `ci.events.parent_event_id` is un-parented
 *     when its parent event goes.
 *
 * ── The duplicates that were merged into it go with it ─────────────────────
 *
 * A merge folds an item into a survivor and leaves it behind as a hidden
 * tombstone (`merged_into_object_id`, an inactive node). Deleting the survivor
 * used to turn each tombstone back into an archived item: `merged_into_object_id`
 * is `ON DELETE SET NULL`, so the row came back with its brand and price, in the
 * scope `ItemService` reads as live. A duplicate is the same physical thing as
 * its survivor, and nobody sees the tombstone to name it, so it goes in the same
 * transaction, with everything above. They are looked up after the survivor is
 * locked, so a merge that was committing into it has either finished, and is
 * seen, or waits for this to end, and then finds the survivor gone.
 *
 * A tombstone that is asked for by name goes alone: its survivor already has its
 * data, and is not this call's to delete.
 *
 * ── What it refuses ────────────────────────────────────────────────────────
 *
 * An item that is another item's PARENT, whose child is not being purged too, is
 * refused, and nothing changes. `objects_parent_object_id_fkey` has no
 * `ON DELETE` action, so the delete of the last statement raises it and the
 * transaction rolls back, as it does for `ItemService.remove`. The caller can name
 * the kit and its parts in one call. Detaching the parts instead is a decision
 * that was put to the user and is not made here.
 *
 * What it deliberately leaves alone is every record that merely MENTIONS the
 * item, whose foreign key is `ON DELETE SET NULL`: the observations that were
 * resolved to it and the receipt lines that minted it. Those are records in their
 * own right, and the schema already chose what happens to them. They are not
 * un-done, so a source that arrives again can mint the item again.
 *
 * It is not {@link ItemService.remove}. That is the app's delete: it writes a
 * `deleted` graph delta, which carries the title, and leaves the edges, ledger
 * rows, identifiers and merge bookkeeping where they are. This is `memory.forget`'s
 * `archive_and_delete`: a node's deltas are deleted with it and none is written.
 *
 * Only the caller's own items are purged, in any state: a tombstone, or an item
 * archived earlier, is purged like any other. An id that does not exist, or that
 * belongs to someone else, is left out of the result rather than raising. So is an
 * `Item` node with no `ci.objects` row behind it, which graph ingest can write:
 * there is nothing here to cascade, and the generic node delete has nothing to be
 * refused over.
 */
export async function purgeItemAggregates(
  manager: EntityManager,
  userId: string,
  requestedItemIds: string[],
): Promise<PurgedItems> {
  // Locked, and in a fixed order, so two purges cannot deadlock each other. This is what a merge, a
  // reparent and a new child all take a lock on the item for: they wait here, or are waited for.
  const asked: Array<{ id: string }> = await manager.query(
    `SELECT object_id AS id
       FROM ci.objects
      WHERE object_id = ANY($1::uuid[])
        AND user_id = $2
      ORDER BY object_id
        FOR UPDATE`,
    [requestedItemIds, userId],
  );

  if (asked.length === 0) {
    return { itemIds: [], duplicateIds: [] };
  }

  const itemIds = asked.map((row) => row.id);

  // Whatever was merged into them, however many merges deep a legacy chain goes. `UNION` and not `UNION
  // ALL`, so a pointer that loops back cannot spin.
  const duplicates: Array<{ id: string }> = await manager.query(
    `WITH RECURSIVE family AS (
       SELECT object_id FROM ci.objects WHERE object_id = ANY($1::uuid[]) AND user_id = $2
       UNION
       SELECT o.object_id
         FROM ci.objects o
         JOIN family f ON o.merged_into_object_id = f.object_id
        WHERE o.user_id = $2
     )
     SELECT o.object_id AS id
       FROM ci.objects o
      WHERE o.object_id IN (SELECT object_id FROM family)
        AND NOT (o.object_id = ANY($1::uuid[]))
      ORDER BY o.object_id`,
    [itemIds, userId],
  );
  const duplicateIds = duplicates.map((row) => row.id);
  const everyId = [...itemIds, ...duplicateIds];

  // 1. What only points at the items, with no foreign key to say so.
  await deleteBareReferences(manager, everyId, ITEM_REFERENCES);
  await manager.query(
    `DELETE FROM ci.object_identifiers WHERE subject_type = 'object_instance' AND subject_id = ANY($1::uuid[])`,
    [everyId],
  );
  await deleteMergeBookkeeping(manager, everyId);

  // 2. Other items that list them as related. An array with no foreign key would keep the dead ids.
  await manager.query(
    `UPDATE ci.objects
        SET related_object_ids = ARRAY(
              SELECT x FROM unnest(related_object_ids) AS x WHERE x <> ALL($1::uuid[])
            ),
            updated_at = now()
      WHERE user_id = $2
        AND related_object_ids && $1::uuid[]
        AND NOT (object_id = ANY($1::uuid[]))`,
    [everyId, userId],
  );

  // 3. The items themselves. The cascade takes the detail rows, and it is here that the parent key refuses
  // an item whose child is not in `everyId`: the whole transaction is rolled back with it.
  await manager.query(`DELETE FROM ci.entities WHERE entity_type = 'Item' AND entity_id = ANY($1::uuid[])`, [
    everyId,
  ]);

  return { itemIds, duplicateIds };
}
