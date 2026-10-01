import type { EntityManager } from 'typeorm';

import { purgeGraphEntities } from './graphEntityPurge';
import { CONCEPT_REFERENCES } from './purgeTeardown';

/** What one purge removed, for the caller to announce once the transaction has committed. */
export interface PurgedConcepts {
  /** The concepts that were asked for and went. */
  conceptIds: string[];
  /**
   * The duplicates that had been merged into those and went with them, which nobody asked for. Nothing
   * merges concepts today, so this is empty unless a node was retyped into one after it had been merged.
   */
  duplicateIds: string[];
}

/**
 * Permanently deletes concepts, and everything that has no meaning without them,
 * inside the caller's transaction. A concept is the plain case of
 * {@link purgeGraphEntities}: nothing points at one but the rows every graph
 * entity is named by, so there is nothing kind-specific to prepare.
 *
 * It owns identifiers all the same. `ci.entity_identifiers` takes the `names` of
 * any entity an import carries, and a name that resolved a message participant to
 * a concept would keep resolving it to a node that is gone.
 *
 * What it leaves alone is what a concept is made from. A concept is minted from the
 * messages, documents and imports that mention it, which stay, and the same text
 * mints it again.
 */
export async function purgeConceptAggregates(
  manager: EntityManager,
  userId: string,
  requestedConceptIds: string[],
): Promise<PurgedConcepts> {
  const purged = await purgeGraphEntities(manager, userId, requestedConceptIds, {
    kind: 'concept',
    references: CONCEPT_REFERENCES,
  });

  return { conceptIds: purged.ids, duplicateIds: purged.duplicateIds };
}
