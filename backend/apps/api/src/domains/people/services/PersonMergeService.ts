import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager } from 'typeorm';
import { v7 as uuid7 } from 'uuid';

import { LoggerService } from '@ci/common/logging';
import { EventService } from '@ci/domains/events';
import { PersonRemovedEvent, PersonUpdatedEvent } from '@ci/domains/memory/events';

/** Max tombstone hops when resolving a merged-away id to its survivor. */
const MAX_TOMBSTONE_DEPTH = 10;

/**
 * Keys of a Person's `properties` a user explicitly edited (via updatePerson).
 * Tracked as `properties.user_edited_fields: string[]`; user-edited values win
 * over source-derived ones during a merge.
 */
export const USER_EDITED_FIELDS_KEY = 'user_edited_fields';

export interface MergeOptions {
  /**
   * 'user' (default): an explicit user/agent action — overrides (and clears)
   * a person/person distinction for the pair. 'auto': identity chaining —
   * a recorded distinction aborts the merge instead.
   */
  initiator?: 'user' | 'auto';
}

export interface MergeResult {
  /** The surviving Person's entity id (post-tombstone-resolution). */
  winnerEntityId: string;
  /** The merged-away Person's entity id. */
  loserEntityId: string;
  /** False when the merge was skipped (same person, or 'auto' hit a distinction). */
  merged: boolean;
  /** Why a non-merge happened, when merged=false. */
  skippedReason?: 'same-person' | 'distinction';
}

interface PersonRow {
  entity_id: string;
  name: string | null;
  properties: Record<string, unknown>;
  merged_into_entity_id: string | null;
}

/**
 * Formerly split across two implementations (this one and a memory-domain
 * PersonMergeService from the parallel #1810 branch); unified here so every
 * merge — GraphQL mergePeople, duplicate-suggestion accept, promotion
 * auto-chaining, agent people.merge — runs the same transaction: repointing,
 * distinction/suggestion bookkeeping, ci.entity_merges audit row, embeddings
 * cleanup, and is_active tombstoning.
 */

/**
 * Transactional Person merge (loser -> winner): the single place a person can
 * be consumed by another. Repoints every table that references the loser's
 * entity_id (person_profiles, entity_identifiers, relationships with edge
 * dedupe, communications from/to, events organizer/participants,
 * users.entity_id), merges `properties` with user-edited fields winning,
 * writes the loser's tombstone (`merged_into_entity_id`), compresses existing
 * tombstone chains onto the winner, retargets distinctions, and settles
 * duplicate suggestions. Emits PersonUpdatedEvent(winner) +
 * PersonRemovedEvent(loser) after commit so search reindexes the survivor and
 * drops the tombstone.
 *
 * Lifts the "merge is a separate chip" deferral noted in
 * PersonStubBackfillService: identifier collisions across Persons can now
 * actually collapse them.
 */
@Injectable()
export class PersonMergeService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly eventService: EventService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(PersonMergeService.name);
  }

  /**
   * Follow `merged_into_entity_id` tombstones to the surviving entity id.
   * Returns the input id unchanged when it was never merged away. Bounded to
   * {@link MAX_TOMBSTONE_DEPTH} hops (merge compresses chains to depth 1, so
   * deeper chains indicate corruption — we stop rather than loop).
   */
  async resolveCanonicalEntityId(ownerUserId: string, entityId: string): Promise<string> {
    let current = entityId;

    for (let depth = 0; depth < MAX_TOMBSTONE_DEPTH; depth += 1) {
      const rows: Array<{ merged_into_entity_id: string | null }> = await this.dataSource.query(
        `SELECT merged_into_entity_id FROM ci.entities
          WHERE entity_id = $1 AND owner_user_id = $2`,
        [current, ownerUserId],
      );

      const next = rows[0]?.merged_into_entity_id ?? null;
      if (next == null) {
        return current;
      }

      current = next;
    }

    return current;
  }

  /**
   * Whether the pair has a recorded person/person distinction ("these are NOT
   * the same person"). Consulted by auto-merge paths before collapsing.
   */
  async hasDistinction(ownerUserId: string, entityIdA: string, entityIdB: string): Promise<boolean> {
    const [a, b] = orderPair(entityIdA, entityIdB);
    const rows: Array<{ exists: boolean }> = await this.dataSource.query(
      `SELECT TRUE AS exists FROM ci.person_distinctions
        WHERE owner_user_id = $1 AND entity_id_a = $2 AND entity_id_b = $3
        LIMIT 1`,
      [ownerUserId, a, b],
    );

    return rows.length > 0;
  }

  /**
   * Merge `loserId` into `winnerId`. Both ids may be tombstones (they resolve
   * to their survivors first). Idempotent: merging an already-merged pair is a
   * no-op. Throws when either id is not a Person owned by the user.
   */
  async merge(
    ownerUserId: string,
    winnerId: string,
    loserId: string,
    options: MergeOptions = {},
  ): Promise<MergeResult> {
    const initiator = options.initiator ?? 'user';

    const winner = await this.resolveCanonicalEntityId(ownerUserId, winnerId);
    const loser = await this.resolveCanonicalEntityId(ownerUserId, loserId);

    if (winner === loser) {
      return { winnerEntityId: winner, loserEntityId: loser, merged: false, skippedReason: 'same-person' };
    }

    if (await this.hasDistinction(ownerUserId, winner, loser)) {
      if (initiator === 'auto') {
        return { winnerEntityId: winner, loserEntityId: loser, merged: false, skippedReason: 'distinction' };
      }

      // Explicit user merge overrides the recorded distinction — they changed
      // their mind, so the pin comes off.
      const [a, b] = orderPair(winner, loser);
      await this.dataSource.query(
        `DELETE FROM ci.person_distinctions
          WHERE owner_user_id = $1 AND entity_id_a = $2 AND entity_id_b = $3`,
        [ownerUserId, a, b],
      );
    }

    await this.dataSource.transaction(async (manager) => {
      // Lock both rows for the duration; deterministic order avoids deadlocks
      // between two concurrent merges touching the same pair.
      const [lockA, lockB] = orderPair(winner, loser);
      const locked: PersonRow[] = await manager.query(
        `SELECT entity_id, name, properties, merged_into_entity_id
           FROM ci.entities
          WHERE owner_user_id = $1 AND entity_type = 'Person' AND entity_id IN ($2, $3)
          FOR UPDATE`,
        [ownerUserId, lockA, lockB],
      );

      const winnerRow = locked.find((row) => row.entity_id === winner);
      const loserRow = locked.find((row) => row.entity_id === loser);
      if (!winnerRow || !loserRow) {
        throw new Error(
          `merge requires two Person entities owned by the user (winner=${winner}, loser=${loser})`,
        );
      }

      // A concurrent merge may have consumed either side between our resolve
      // and the lock — bail out; the caller can retry against the survivors.
      if (winnerRow.merged_into_entity_id != null || loserRow.merged_into_entity_id != null) {
        throw new Error('person was merged concurrently; retry');
      }

      // Historical communications live in COMPRESSED TimescaleDB chunks; the
      // re-point UPDATEs decompress them and can exceed the default per-txn
      // cap (100k tuples), aborting the merge. Lift the cap for this txn only
      // — the compression policy recompacts the touched chunks later.
      await manager.query(
        'SET LOCAL timescaledb.max_tuples_decompressed_per_dml_transaction = 0',
      );

      await this.repointReferences(manager, ownerUserId, winner, loser);
      await this.retargetDistinctions(manager, ownerUserId, winner, loser);
      await this.settleSuggestions(manager, ownerUserId, winner, loser);

      // Properties merge: user-edited values win, then winner's values, then
      // loser's fill the gaps. Identifier arrays union.
      const mergedProperties = mergePersonProperties(winnerRow.properties, loserRow.properties);
      await manager.query(
        `UPDATE ci.entities
            SET properties = $3::jsonb,
                name = COALESCE(NULLIF(name, ''), $4),
                updated_at = now()
          WHERE entity_id = $1 AND owner_user_id = $2`,
        [winner, ownerUserId, JSON.stringify(mergedProperties), loserRow.name],
      );

      // Tombstone the loser (inactive so entity read paths skip it) and
      // compress any chain that pointed at it, so resolution stays depth-1.
      await manager.query(
        `UPDATE ci.entities SET merged_into_entity_id = $3, is_active = FALSE, updated_at = now()
          WHERE entity_id = $1 AND owner_user_id = $2`,
        [loser, ownerUserId, winner],
      );
      await manager.query(
        `UPDATE ci.entities SET merged_into_entity_id = $3, updated_at = now()
          WHERE owner_user_id = $2 AND merged_into_entity_id = $1`,
        [loser, ownerUserId, winner],
      );

      // The tombstone must stop matching in semantic search immediately; the
      // winner re-indexes via the PersonUpdatedEvent emitted after commit.
      await manager.query(
        `DELETE FROM ci_search.embeddings WHERE user_id = $1 AND entity_id = $2`,
        [ownerUserId, loser],
      );

      // Audit row: what a future unmerge (or a confused human) would need.
      await manager.query(
        `INSERT INTO ci.entity_merges (owner_user_id, source_entity_id, target_entity_id, entity_type, details)
         VALUES ($1, $2, $3, 'Person', $4::jsonb)`,
        [
          ownerUserId,
          loser,
          winner,
          JSON.stringify({
            initiator,
            sourceName: loserRow.name,
            sourceProperties: loserRow.properties ?? {},
          }),
        ],
      );
    });

    this.logger.log('Merged person', { ownerUserId, winner, loser, initiator });

    // Reindex the survivor, drop the tombstone from search.
    await this.eventService.send(PersonUpdatedEvent, { personId: winner });
    await this.eventService.send(PersonRemovedEvent, { personId: loser });

    return { winnerEntityId: winner, loserEntityId: loser, merged: true };
  }

  /** Repoint every table that references the loser's entity_id at the winner. */
  private async repointReferences(
    manager: EntityManager,
    ownerUserId: string,
    winner: string,
    loser: string,
  ): Promise<void> {
    // Source profiles follow their person.
    await manager.query(
      `UPDATE ci.person_profiles SET person_entity_id = $3, updated_at = now()
        WHERE owner_user_id = $1 AND person_entity_id = $2`,
      [ownerUserId, loser, winner],
    );

    // Identifier index — the unique key is (owner, kind, value), so repointing
    // entity_id can never collide.
    await manager.query(
      `UPDATE ci.entity_identifiers SET entity_id = $3
        WHERE owner_user_id = $1 AND entity_id = $2`,
      [ownerUserId, loser, winner],
    );

    // Relationships: drop edges that would become self-references or duplicate
    // an existing active winner edge (the directed (from, to, type) unique
    // index is partial on is_active), then repoint the rest.
    await manager.query(
      `DELETE FROM ci.relationships r
        WHERE r.owner_user_id = $1
          AND (r.from_entity_id = $2 OR r.to_entity_id = $2)
          AND (
            (r.from_entity_id = $2 AND r.to_entity_id = $3)
            OR (r.to_entity_id = $2 AND r.from_entity_id = $3)
            OR (
              r.is_active = TRUE
              AND EXISTS (
                SELECT 1 FROM ci.relationships w
                 WHERE w.owner_user_id = r.owner_user_id
                   AND w.relationship_type = r.relationship_type
                   AND w.is_active = TRUE
                   AND w.from_entity_id = CASE WHEN r.from_entity_id = $2 THEN $3::uuid ELSE r.from_entity_id END
                   AND w.to_entity_id = CASE WHEN r.to_entity_id = $2 THEN $3::uuid ELSE r.to_entity_id END
              )
            )
          )`,
      [ownerUserId, loser, winner],
    );
    await manager.query(
      `UPDATE ci.relationships SET from_entity_id = $3
        WHERE owner_user_id = $1 AND from_entity_id = $2`,
      [ownerUserId, loser, winner],
    );
    await manager.query(
      `UPDATE ci.relationships SET to_entity_id = $3
        WHERE owner_user_id = $1 AND to_entity_id = $2`,
      [ownerUserId, loser, winner],
    );

    // Communications: sender pointer + recipients array (de-duped in case the
    // winner was already a recipient).
    await manager.query(
      `UPDATE ci.communications SET from_entity_id = $3
        WHERE user_id = $1 AND from_entity_id = $2`,
      [ownerUserId, loser, winner],
    );
    await manager.query(
      `UPDATE ci.communications
          SET to_entity_ids = (
            SELECT array_agg(DISTINCT x)
              FROM unnest(array_replace(to_entity_ids, $2::uuid, $3::uuid)) AS x
          )
        WHERE user_id = $1 AND $2 = ANY(to_entity_ids)`,
      [ownerUserId, loser, winner],
    );

    // Events: organizer pointer + participants array.
    await manager.query(
      `UPDATE ci.events SET organizer_entity_id = $3
        WHERE user_id = $1 AND organizer_entity_id = $2`,
      [ownerUserId, loser, winner],
    );
    await manager.query(
      `UPDATE ci.events
          SET participant_entity_ids = (
            SELECT array_agg(DISTINCT x)
              FROM unnest(array_replace(participant_entity_ids, $2::uuid, $3::uuid)) AS x
          )
        WHERE user_id = $1 AND $2 = ANY(participant_entity_ids)`,
      [ownerUserId, loser, winner],
    );

    // The owner's self pointer (merging a stub of yourself into your self
    // entity, or vice versa).
    await manager.query(
      `UPDATE ci.users SET entity_id = $3 WHERE id = $1 AND entity_id = $2`,
      [ownerUserId, loser, winner],
    );
  }

  /**
   * Distinctions that referenced the loser transfer to the winner ("X is not
   * the loser" still means "X is not the winner" after the two collapse).
   * Rows that would become self-pairs are dropped; collisions with an existing
   * equivalent row are absorbed.
   */
  private async retargetDistinctions(
    manager: EntityManager,
    ownerUserId: string,
    winner: string,
    loser: string,
  ): Promise<void> {
    interface DistinctionRow {
      distinction_id: string;
      entity_id_a: string;
      entity_id_b: string | null;
      profile_id: string | null;
      reason: string;
    }

    const rows: DistinctionRow[] = await manager.query(
      `SELECT distinction_id, entity_id_a, entity_id_b, profile_id, reason
         FROM ci.person_distinctions
        WHERE owner_user_id = $1 AND (entity_id_a = $2 OR entity_id_b = $2)`,
      [ownerUserId, loser],
    );

    for (const row of rows) {
      if (row.entity_id_b != null) {
        const mappedA = row.entity_id_a === loser ? winner : row.entity_id_a;
        const mappedB = row.entity_id_b === loser ? winner : row.entity_id_b;
        if (mappedA !== mappedB) {
          const [a, b] = orderPair(mappedA, mappedB);
          await manager.query(
            `INSERT INTO ci.person_distinctions (distinction_id, owner_user_id, entity_id_a, entity_id_b, reason)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT DO NOTHING`,
            [uuid7(), ownerUserId, a, b, row.reason],
          );
        }
      } else if (row.profile_id != null) {
        await manager.query(
          `INSERT INTO ci.person_distinctions (distinction_id, owner_user_id, entity_id_a, profile_id, reason)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT DO NOTHING`,
          [uuid7(), ownerUserId, winner, row.profile_id, row.reason],
        );
      }

      await manager.query(`DELETE FROM ci.person_distinctions WHERE distinction_id = $1`, [
        row.distinction_id,
      ]);
    }
  }

  /**
   * Settle duplicate suggestions: the merged pair's own pending suggestion is
   * accepted; every other pending suggestion touching the loser goes stale
   * (the generator re-discovers it against the winner if still relevant).
   */
  private async settleSuggestions(
    manager: EntityManager,
    ownerUserId: string,
    winner: string,
    loser: string,
  ): Promise<void> {
    const [a, b] = orderPair(winner, loser);
    await manager.query(
      `UPDATE ci.person_duplicate_suggestions SET status = 'accepted', updated_at = now()
        WHERE owner_user_id = $1 AND status = 'pending' AND entity_id_a = $2 AND entity_id_b = $3`,
      [ownerUserId, a, b],
    );
    await manager.query(
      `UPDATE ci.person_duplicate_suggestions SET status = 'stale', updated_at = now()
        WHERE owner_user_id = $1 AND status = 'pending' AND (entity_id_a = $2 OR entity_id_b = $2)`,
      [ownerUserId, loser],
    );
  }
}

/** Stable (a < b) ordering for pair keys. */
function orderPair(x: string, y: string): [string, string] {
  return x < y ? [x, y] : [y, x];
}

/**
 * Merge a loser's properties into a winner's. Precedence per key:
 * 1. A winner value the user edited (listed in winner's user_edited_fields).
 * 2. A loser value the user edited (fills in and stays marked user-edited).
 * 3. The winner's existing non-empty value.
 * 4. The loser's value.
 * Identifier arrays (emails/phones/names) union instead. The merged
 * user_edited_fields is the union of both sides' lists (restricted to keys
 * whose user-edited value actually survived).
 */
export function mergePersonProperties(
  winnerProps: Record<string, unknown>,
  loserProps: Record<string, unknown>,
): Record<string, unknown> {
  const winner = winnerProps ?? {};
  const loser = loserProps ?? {};

  const winnerEdited = new Set(readStringArray(winner[USER_EDITED_FIELDS_KEY]));
  const loserEdited = new Set(readStringArray(loser[USER_EDITED_FIELDS_KEY]));

  const merged: Record<string, unknown> = { ...winner };
  const mergedEdited = new Set(winnerEdited);

  const ARRAY_UNION_KEYS = new Set(['emails', 'phones', 'names']);

  for (const [key, loserValue] of Object.entries(loser)) {
    if (key === USER_EDITED_FIELDS_KEY || loserValue == null) {
      continue;
    }

    if (ARRAY_UNION_KEYS.has(key)) {
      const union = [...new Set([...readStringArray(merged[key]), ...readStringArray(loserValue)])];
      if (union.length > 0) {
        merged[key] = union;
      }

      continue;
    }

    if (winnerEdited.has(key)) {
      continue; // Winner's user-edited value always wins.
    }

    if (loserEdited.has(key)) {
      merged[key] = loserValue;
      mergedEdited.add(key);
      continue;
    }

    const existing = merged[key];
    if (existing == null || existing === '') {
      merged[key] = loserValue;
    }
  }

  if (mergedEdited.size > 0) {
    merged[USER_EDITED_FIELDS_KEY] = [...mergedEdited];
  }

  return merged;
}

function readStringArray(value: unknown): string[] {
  if (typeof value === 'string') {
    return [value];
  }

  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === 'string');
  }

  return [];
}
