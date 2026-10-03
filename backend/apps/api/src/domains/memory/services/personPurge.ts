import type { EntityManager } from 'typeorm';

import { countAffected } from '@ci/common/persistence';

import { purgeGraphEntities } from './graphEntityPurge';
import { PERSON_REFERENCES } from './purgeTeardown';

/** What one purge removed, for the caller to announce once the transaction has committed. */
export interface PurgedPeople {
  /** The people that were asked for and went. */
  personIds: string[];
  /**
   * The duplicates that had been merged into those and went with them, which nobody asked for: the
   * tombstones a merge leaves behind. The caller says so, because they were deleted unnamed.
   */
  duplicateIds: string[];
  /**
   * How many of their identifiers (email addresses, phone numbers, handles) are now on the list the
   * people-minting paths skip, so mail that still names them does not create them again.
   */
  blockedIdentifiers: number;
}

/**
 * Permanently deletes people, and everything that has no meaning without them,
 * inside the caller's transaction. See {@link purgeGraphEntities} for the half
 * every graph entity shares: the lock, the duplicates that were merged into them,
 * the rows that name them with no foreign key, their merge history and the node.
 *
 * What is specific to a person, and why:
 *
 * ── Their identifiers are freed AND remembered ─────────────────────────────
 *
 * Deleting a person's `ci.entity_identifiers` rows is what releases their
 * addresses, but it also removes the only thing that stops two other paths
 * creating them again. `CommunicationParticipantLinkListener` (every new message)
 * and `PersonStubBackfillService` (after every bulk import of communications)
 * mint a stub Person for any participant the index does not know, and the mail
 * that names the person is still there. Measured on a real database with the real
 * services: the first backfill pass after a delete-only forget created an active
 * Person for the same address, and the person-link stage then re-pointed every
 * old claim at it. The forget undid itself, with the whole history re-attached.
 *
 * So each email address, phone number and handle the person held is recorded in
 * `ci.forgotten_identifiers` first, in this transaction, and both paths skip any
 * identifier listed. It is a digest, not the address: the table is a list of the
 * people the user asked the appliance to forget, and must not be a readable one.
 * Display names are not recorded, because a name is shared by many people. A
 * contact card imported again, and a person the language model extracts from
 * text, are not identifier-driven and are not stopped: a source that arrives
 * again can mint the person again.
 *
 * ── The pointers to them are cleared ───────────────────────────────────────
 *
 * `communications.from_entity_id` and `to_entity_ids`, `events.organizer_entity_id`
 * and `participant_entity_ids` hold a person's id with no foreign key, so they
 * would keep naming a node that is gone. They are cleared (the id is taken out of
 * the arrays), exactly as an `ON DELETE SET NULL` key would. The messages and
 * events themselves stay, and still name the person by address in their own
 * metadata: forgetting a person does not forget what they wrote.
 * `ci.peer_links.person_entity_id`, which is nullable on purpose because a peer
 * link works without it, is set to NULL the same way. The link itself is a
 * federation trust relationship and is not this purge's to revoke.
 *
 * ── The user's own node ────────────────────────────────────────────────────
 *
 * `ci.users.entity_id` has no `ON DELETE` action, so the delete of the user's own
 * Person is refused by the database, as it is for the generic delete: the
 * transaction rolls back and nothing above, the recorded identifiers included,
 * is kept.
 */
export async function purgePersonAggregates(
  manager: EntityManager,
  userId: string,
  requestedPersonIds: string[],
): Promise<PurgedPeople> {
  let blockedIdentifiers = 0;

  const purged = await purgeGraphEntities(manager, userId, requestedPersonIds, {
    kind: 'person',
    references: PERSON_REFERENCES,
    prepare: async (em, { ids }) => {
      // First: this reads the identifiers the next step deletes.
      blockedIdentifiers = await blockIdentifiers(em, userId, ids);
      await clearPointers(em, userId, ids);
    },
  });

  return { personIds: purged.ids, duplicateIds: purged.duplicateIds, blockedIdentifiers };
}

/**
 * Records the people's email addresses, phone numbers and handles as forgotten, and answers how many
 * there were, counting those already listed: it is what the caller may say will not be linked again.
 */
function blockIdentifiers(manager: EntityManager, userId: string, ids: string[]): Promise<number> {
  return countAffected(
    manager,
    `WITH held AS (
       SELECT i.owner_user_id, i.kind, i.value_normalized
         FROM ci.entity_identifiers i
        WHERE i.entity_id = ANY($1::uuid[])
          AND i.owner_user_id = $2
          AND i.kind IN ('email', 'phone', 'handle')
     ), listed AS (
       INSERT INTO ci.forgotten_identifiers (owner_user_id, kind, identifier_digest)
       SELECT h.owner_user_id, h.kind, ci.forgotten_identifier_digest(h.owner_user_id, h.kind, h.value_normalized)
         FROM held h
       ON CONFLICT DO NOTHING
       RETURNING 1
     )
     SELECT count(*)::int AS count FROM held`,
    [ids, userId],
  );
}

/** Takes the people out of every column that holds a person's id with no foreign key to clear it. */
async function clearPointers(manager: EntityManager, userId: string, ids: string[]): Promise<void> {
  await manager.query(
    `UPDATE ci.communications SET from_entity_id = NULL WHERE user_id = $1 AND from_entity_id = ANY($2::uuid[])`,
    [userId, ids],
  );
  await manager.query(
    `UPDATE ci.communications
        SET to_entity_ids = ARRAY(SELECT x FROM unnest(to_entity_ids) AS x WHERE x <> ALL($2::uuid[]))
      WHERE user_id = $1 AND to_entity_ids && $2::uuid[]`,
    [userId, ids],
  );
  await manager.query(
    `UPDATE ci.events SET organizer_entity_id = NULL WHERE user_id = $1 AND organizer_entity_id = ANY($2::uuid[])`,
    [userId, ids],
  );
  await manager.query(
    `UPDATE ci.events
        SET participant_entity_ids = ARRAY(SELECT x FROM unnest(participant_entity_ids) AS x WHERE x <> ALL($2::uuid[]))
      WHERE user_id = $1 AND participant_entity_ids && $2::uuid[]`,
    [userId, ids],
  );
  await manager.query(
    `UPDATE ci.peer_links SET person_entity_id = NULL, updated_at = now()
      WHERE owner_user_id = $1 AND person_entity_id = ANY($2::uuid[])`,
    [userId, ids],
  );
}
