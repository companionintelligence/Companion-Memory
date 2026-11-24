import type { EntityManager } from 'typeorm';

import { purgeGraphEntities } from './graphEntityPurge';
import { PLACE_REFERENCES } from './purgeTeardown';

/** What one purge removed, for the caller to announce once the transaction has committed. */
export interface PurgedPlaces {
  /** The places that were asked for and went. */
  placeIds: string[];
  /**
   * The duplicates that had been merged into those and went with them, which nobody asked for: the
   * tombstones a merge leaves behind. The caller says so, because they were deleted unnamed.
   */
  duplicateIds: string[];
}

/**
 * Permanently deletes places, and everything that has no meaning without them,
 * inside the caller's transaction. See {@link purgeGraphEntities} for the half
 * every graph entity shares: the lock, the duplicates that were merged into them,
 * the rows that name them with no foreign key, their merge history and the node.
 *
 * What is specific to a place, and why:
 *
 * ── Its children are grafted onto its parent ───────────────────────────────
 *
 * `ci.entities.parent_place_id` is `ON DELETE SET NULL`, and nulling a child's parent
 * is not harmless: a city, region or country is unique per (owner, kind, name,
 * parent) in `entities_admin_place_uniq`, with a missing parent counting as its own
 * value. A city whose region is deleted collides with a parentless city of the
 * same name, the delete is refused, and the place is undeletable. So each child is
 * moved up to the nearest ancestor that is NOT going, before the delete, which is
 * what `PlaceService.remove` does and for the same reason: it also keeps the
 * containment chain, so a city keeps its country when its region is removed. With
 * several places named in one call the climb skips every one of them, and a chain
 * of them lands its survivors on the first ancestor that stays.
 *
 * The graft can itself collide, with a sibling of the same name already under the
 * ancestor. That raises the same unique violation and rolls the whole purge back,
 * as `remove` would: nothing changes, and the places are two duplicates somebody
 * should merge. The `PART_OF` edge from a grafted child to its new parent is
 * derived by the edge stage when it next re-decides the row, as it is after a
 * place merge; the edge to the deleted parent goes with the parent.
 *
 * ── What points at it is left to the schema ────────────────────────────────
 *
 * An event's `location_entity_id`, a position fix's location, a receipt's place, an
 * item's last-seen place and a sighting's place are all `ON DELETE SET NULL`, and
 * the schema's answer is the right one: the event, the fix and the receipt are
 * records in their own right.
 *
 * A place is not a source, though. It is DERIVED from those events' coordinates
 * and names, which this does not touch, and `promote.place` mints a place from them
 * again, for any new event at the same spot and for the old ones whenever the
 * stage's version moves. Forgetting a place does not forget where the events were.
 */
export async function purgePlaceAggregates(
  manager: EntityManager,
  userId: string,
  requestedPlaceIds: string[],
): Promise<PurgedPlaces> {
  const purged = await purgeGraphEntities(manager, userId, requestedPlaceIds, {
    kind: 'place',
    references: PLACE_REFERENCES,
    prepare: (em, { ids }) => graftChildren(em, userId, ids),
  });

  return { placeIds: purged.ids, duplicateIds: purged.duplicateIds };
}

/**
 * Moves every surviving child of a place that is going up to the nearest ancestor that is not.
 *
 * `climb` walks each doomed place's parent chain while the parent is itself going, and the
 * `UNION` stops a loop from spinning. The child is then re-pointed at wherever the climb
 * stopped, which is `NULL` when the whole chain is going.
 */
async function graftChildren(manager: EntityManager, userId: string, ids: string[]): Promise<void> {
  await manager.query(
    `WITH RECURSIVE climb AS (
       SELECT entity_id AS doomed, parent_place_id AS up
         FROM ci.entities
        WHERE entity_id = ANY($1::uuid[]) AND owner_user_id = $2
       UNION
       SELECT climb.doomed, e.parent_place_id
         FROM climb
         JOIN ci.entities e ON e.entity_id = climb.up AND e.owner_user_id = $2
        WHERE climb.up = ANY($1::uuid[])
     )
     UPDATE ci.entities child
        SET parent_place_id = landing.up
       FROM climb landing
      WHERE child.parent_place_id = landing.doomed
        AND child.owner_user_id = $2
        AND NOT (child.entity_id = ANY($1::uuid[]))
        AND (landing.up IS NULL OR NOT (landing.up = ANY($1::uuid[])))`,
    [ids, userId],
  );
}
