import type { EntityManager } from 'typeorm';

import { deleteBareReferences, deleteMergeBookkeeping, PRODUCT_REFERENCES } from './purgeTeardown';

/** What one purge removed, for the caller to announce once the transaction has committed. */
export interface PurgedProducts {
  /** The `Product` nodes that were asked for and went with their catalog model. */
  nodeIds: string[];
  /**
   * Every `ci.product_models` row that went: the models behind those nodes and the ones that had
   * been merged into them. The product's search rows are keyed by these, not by the node.
   */
  productIds: string[];
  /**
   * The records that named one of those models and stay, now naming none: the schema's
   * `ON DELETE SET NULL`. The caller says so, because they changed without being named.
   */
  unlinked: { things: number; sightings: number; receiptLines: number };
}

/**
 * Permanently deletes the catalog models behind these `Product` nodes, inside the caller's
 * transaction.
 *
 * A `Product` node is the graph mirror of a `ci.product_models` row, which points at it from
 * `product_entity_id` with no `ON DELETE` action. The generic node delete was refused by that key,
 * so `memory.forget` could not remove a product in any mode. This removes the model first, and the
 * node after it:
 *
 *  1. **Everything that names the model or the node with no foreign key**
 *     ({@link deleteBareReferences}): the edges, the graph deltas, the tags and categories and the
 *     search rows, which are keyed by the model's id.
 *  2. **Its identifiers.** `ci.object_identifiers` holds the barcodes a model was recognised by
 *     under `subject_type = 'product_model'`, and its unique index would keep claiming them.
 *  3. **The models merged into it.** A merge leaves the loser behind as a tombstone
 *     (`merged_into_product_id`). It is the same product, and nobody can name it, so it goes too.
 *  4. **The models, then the nodes.**
 *
 * What it leaves alone is every record that merely MENTIONS the model, whose foreign key is
 * `ON DELETE SET NULL`: the things that are instances of it, the sightings resolved to it and the
 * receipt lines that bought it. They are records in their own right and the schema already chose
 * what happens to them, as {@link purgeItemAggregates} leaves the sightings and receipt lines of an
 * item. They are counted first, so the caller can say what changed.
 *
 * Only the caller's own models are purged. A node that is not the caller's, or has no model behind
 * it, is left out of the result: the generic node delete takes it, and nothing refuses that.
 */
export async function purgeProductAggregates(
  manager: EntityManager,
  userId: string,
  requestedNodeIds: string[],
): Promise<PurgedProducts> {
  const none: PurgedProducts = {
    nodeIds: [],
    productIds: [],
    unlinked: { things: 0, sightings: 0, receiptLines: 0 },
  };

  // Locked, and in a fixed order, so two purges (or a purge and a merge) cannot deadlock each other.
  const asked: Array<{ product_id: string; node_id: string }> = await manager.query(
    `SELECT pm.product_id, pm.product_entity_id AS node_id
       FROM ci.product_models pm
       JOIN ci.entities e ON e.entity_id = pm.product_entity_id
      WHERE pm.product_entity_id = ANY($1::uuid[])
        AND pm.user_id = $2
        AND e.owner_user_id = $2
        AND e.entity_type = 'Product'
      ORDER BY pm.product_id
        FOR UPDATE OF pm`,
    [requestedNodeIds, userId],
  );

  if (asked.length === 0) {
    return none;
  }

  // Whatever was merged into them, however deep. `UNION` and not `UNION ALL`, so a pointer that loops
  // back cannot spin.
  const family: Array<{ product_id: string; node_id: string | null }> = await manager.query(
    `WITH RECURSIVE family AS (
       SELECT product_id FROM ci.product_models WHERE product_id = ANY($1::uuid[]) AND user_id = $2
       UNION
       SELECT pm.product_id
         FROM ci.product_models pm
         JOIN family f ON pm.merged_into_product_id = f.product_id
        WHERE pm.user_id = $2
     )
     SELECT pm.product_id, pm.product_entity_id AS node_id
       FROM ci.product_models pm
      WHERE pm.product_id IN (SELECT product_id FROM family)
      ORDER BY pm.product_id`,
    [asked.map((row) => row.product_id), userId],
  );
  const productIds = family.map((row) => row.product_id);
  const nodeIds = Array.from(new Set(asked.map((row) => row.node_id)));
  const everyNodeId = Array.from(
    new Set([...nodeIds, ...family.map((row) => row.node_id).filter((id): id is string => id !== null)]),
  );

  const [counts]: Array<{ things: string; sightings: string; receipt_lines: string }> = await manager.query(
    `SELECT (SELECT count(*) FROM ci.objects WHERE product_id = ANY($1::uuid[])) AS things,
            (SELECT count(*) FROM ci.object_observations WHERE resolved_product_id = ANY($1::uuid[])) AS sightings,
            (SELECT count(*) FROM ci.receipt_line_items WHERE product_id = ANY($1::uuid[])) AS receipt_lines`,
    [productIds],
  );

  // 1. What only points at the models or their nodes, with no foreign key to say so.
  await deleteBareReferences(manager, [...productIds, ...everyNodeId], PRODUCT_REFERENCES);
  await manager.query(
    `DELETE FROM ci.object_identifiers WHERE subject_type = 'product_model' AND subject_id = ANY($1::uuid[])`,
    [productIds],
  );
  await deleteMergeBookkeeping(manager, everyNodeId);

  // 2. The models. The mentions are set to NULL by their own keys, the tombstones go in the same statement.
  await manager.query('DELETE FROM ci.product_models WHERE product_id = ANY($1::uuid[]) AND user_id = $2', [
    productIds,
    userId,
  ]);

  // 3. The nodes, which nothing refuses now.
  await manager.query(
    `DELETE FROM ci.entities WHERE entity_type = 'Product' AND entity_id = ANY($1::uuid[]) AND owner_user_id = $2`,
    [everyNodeId, userId],
  );

  return {
    nodeIds,
    productIds,
    unlinked: {
      things: Number(counts?.things ?? 0),
      sightings: Number(counts?.sightings ?? 0),
      receiptLines: Number(counts?.receipt_lines ?? 0),
    },
  };
}
