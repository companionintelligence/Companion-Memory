import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, Repository } from 'typeorm';

import { type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { countAffected } from '@ci/common/persistence';
import { EventService } from '@ci/domains/events';
import { PersonUpdatedEvent } from '@ci/domains/memory/events';

import { type Person, PersonEntity } from '../entities/PersonEntity';

import { GraphDeltaWriter } from './GraphDeltaWriter';
import { sweepLeftoverEdges } from './mergeEdgeSweep';

/** Per-table re-point counts recorded in the ci.entity_merges audit row. */
export interface MergeCounts {
  identifiers: number;
  /** `ci.identifier_claims` rows whose resolution moved from a source to the target. */
  claims: number;
  /** `ci.entity_merge_blocks` a source held against someone, newly recorded for the target. */
  blocksCarried: number;
  communicationsFrom: number;
  communicationsTo: number;
  eventsOrganizer: number;
  eventsParticipants: number;
  relationshipsFrom: number;
  relationshipsTo: number;
  relationshipsDropped: number;
  /**
   * Edges a concurrent writer committed to a source AFTER the guarded re-point's
   * snapshot (the edge projection, most often), which the final sweep moved onto
   * the target instead of dropping. Not part of `relationshipsFrom/To`, which
   * count the rows that UPDATE moved. Zero on almost every merge; a non-zero
   * value is the race this count exists to make visible.
   */
  relationshipsRescued: number;
}

/**
 * Merges duplicate Person entities into one canonical row — the missing
 * primitive called out by PersonStubBackfillService ("a real merge is out of
 * scope; tracked separately"). The same human routinely lands as several
 * ci.entities rows (a contacts import, a communications-participant stub, a
 * face tag) because entity idempotency keys on the per-source linked key, and
 * ci.entity_identifiers is first-writer-wins.
 *
 * A merge, in one transaction:
 * 1. re-points ci.entity_identifiers claims to the target, and the
 *    resolution (entity_id) of every ci.identifier_claims row that resolved
 *    to a source; carries each source's ci.entity_merge_blocks over to the
 *    target,
 * 2. re-points communications.from_entity_id / to_entity_ids[],
 * 3. re-points events.organizer_entity_id / participant_entity_ids[],
 * 4. re-points ci.relationships endpoints (dropping edges that would become
 *    self-references or duplicate an existing active edge), then sweeps what
 *    that left behind — moving, not dropping, any edge a concurrent writer
 *    committed to a source after the re-point's snapshot (see
 *    {@link sweepLeftoverEdges}),
 * 5. folds source properties into the target (target wins scalars;
 *    emails/phones/names arrays are unioned),
 * 6. tombstones each source (is_active = FALSE, merged_into_entity_id =
 *    target) and deletes its search-index embedding,
 * 7. re-points any tombstone that already aimed at a source, so
 *    merged_into_entity_id stays exactly one hop deep,
 * 8. writes one ci.entity_merges audit row per source.
 *
 * The audit row is also what re-opens the pipeline's decisions about the
 * target: the pipeline's IdentifierArrivalService re-opens its
 * enrich.person_self_claim and clean.duplicate_detect rows decided before the
 * merge, so the survivor is re-examined with the claims step 1 moved onto it.
 * Nothing here writes ci.pipeline_state — PipelineStateService is its only
 * writer, and the pipeline domain depends on this one, not the reverse.
 *
 * The user's self person may be a merge TARGET (folding a stub of yourself
 * into you) but never a SOURCE — users.entity_id must keep pointing at a live
 * row.
 */
@Injectable()
export class PersonMergeService {
  constructor(
    @InjectRepository(PersonEntity)
    private readonly personRepository: Repository<PersonEntity>,
    private readonly logger: LoggerService,
    private readonly eventService: EventService,
    private readonly graphDeltaWriter: GraphDeltaWriter,
  ) {
    this.logger.setContext(PersonMergeService.name);
  }

  async mergePeople(context: UserServiceContext, sourceIds: string[], targetId: string): Promise<Person> {
    const ownerUserId = context.userId;
    const sources = [...new Set(sourceIds)].filter((id) => id !== targetId);
    if (sources.length === 0) {
      throw new BadRequestException('mergePeople needs at least one source distinct from the target');
    }

    const manager = this.personRepository.manager;

    const merged = await manager.transaction(async (em) => {
      const rows: Array<{
        entity_id: string;
        entity_type: string;
        name: string | null;
        description: string | null;
        properties: Record<string, unknown>;
        merged_into_entity_id: string | null;
      }> = await em.query(
        `SELECT entity_id, entity_type, name, description, properties, merged_into_entity_id
           FROM ci.entities
          WHERE owner_user_id = $1 AND entity_id = ANY($2::uuid[])
          FOR UPDATE`,
        [ownerUserId, [targetId, ...sources]],
      );

      const byId = new Map(rows.map((row) => [row.entity_id, row]));
      const target = byId.get(targetId);
      if (!target) {
        throw new NotFoundException(`Merge target ${targetId} not found`);
      }

      if (target.entity_type !== 'Person' || target.merged_into_entity_id != null) {
        throw new BadRequestException('Merge target must be a live Person entity');
      }

      for (const id of sources) {
        const source = byId.get(id);
        if (!source) {
          throw new NotFoundException(`Merge source ${id} not found`);
        }

        if (source.entity_type !== 'Person' || source.merged_into_entity_id != null) {
          throw new BadRequestException(`Merge source ${id} must be a live Person entity`);
        }
      }

      const [selfRow]: Array<{ entity_id: string | null }> = await em.query(
        `SELECT entity_id FROM ci.users WHERE id = $1`,
        [ownerUserId],
      );
      if (selfRow?.entity_id && sources.includes(selfRow.entity_id)) {
        throw new BadRequestException(
          'The self person cannot be merged away — merge the duplicate INTO it instead',
        );
      }

      const counts = await this.repointReferences(em, ownerUserId, sources, targetId);

      // Fold source attributes into the target: target wins every scalar it
      // already has; emails/phones/names accumulate. This preserves the
      // identifiers a stub carried even though its identifier ROWS were
      // re-pointed above (properties stay the readable record).
      const mergedProperties = foldProperties(
        target.properties ?? {},
        sources.map((id) => byId.get(id)?.properties ?? {}),
      );

      // Target's name always wins when present — a merge SOURCE (e.g. a
      // communications-participant stub) must never overwrite the target's
      // display name, especially when the target is the user's own self
      // person and the merge runs unattended (MergeCandidateService's
      // autoMergeDeterministicPairs). Only fall back to a source's name when
      // the target has none.
      const mergedName = firstNonEmpty([target.name, ...sources.map((id) => byId.get(id)?.name)]);
      const mergedDescription = firstNonEmpty([
        target.description,
        ...sources.map((id) => byId.get(id)?.description),
      ]);

      await em.query(
        `UPDATE ci.entities
            SET properties = $3::jsonb, name = $4, description = $5, updated_at = now()
          WHERE owner_user_id = $1 AND entity_id = $2`,
        [ownerUserId, targetId, JSON.stringify(mergedProperties), mergedName, mergedDescription],
      );

      await em.query(
        `UPDATE ci.entities
            SET merged_into_entity_id = $3, is_active = FALSE, updated_at = now()
          WHERE owner_user_id = $1 AND entity_id = ANY($2::uuid[])`,
        [ownerUserId, sources, targetId],
      );

      await this.graphDeltaWriter.recordMany(
        [
          {
            nodeType: 'entity' as const,
            changeType: 'updated' as const,
            entityId: targetId,
            entityType: 'Person',
            ownerUserId,
            changeSource: 'PersonMergeService.mergePeople',
            changedByUserId: ownerUserId,
            changedFields: {
              name: { new: mergedName },
              description: { new: mergedDescription },
              properties: { new: mergedProperties },
            },
          },
          ...sources.map((sourceId) => ({
            nodeType: 'entity' as const,
            changeType: 'merged' as const,
            entityId: sourceId,
            entityType: 'Person',
            ownerUserId,
            changeSource: 'PersonMergeService.mergePeople',
            changedByUserId: ownerUserId,
            changedFields: {
              name: { old: byId.get(sourceId)?.name ?? null },
              merged_into_entity_id: { new: targetId },
            },
          })),
        ],
        em,
      );

      // Path compression. Merging B into C leaves any tombstone that already
      // pointed at B aiming at a row that is now itself a tombstone, and every
      // resolver in the codebase follows exactly ONE hop (PersonService's
      // resolveTombstone, GraphIngestService's canonicalIdOf). Without this,
      // the second merge in a chain silently re-strands the first one's
      // sources. Re-pointing them here keeps `merged_into_entity_id` one hop
      // deep for good, so readers stay a single lookup.
      await em.query(
        `UPDATE ci.entities
            SET merged_into_entity_id = $3, updated_at = now()
          WHERE owner_user_id = $1 AND merged_into_entity_id = ANY($2::uuid[])`,
        [ownerUserId, sources, targetId],
      );

      // Tombstones must stop matching in search. Person search rows live in
      // TWO stores (PersonSearchIndexListener writes both): the embedding
      // (semantic) and the ci_search.vectors tsvector row (keyword / boosted
      // keyword, queried with no join back to ci.entities) — delete both. The
      // target re-indexes via the PersonUpdatedEvent emitted after commit, and
      // the backfill sweep skips tombstones (merged_into_entity_id filter in
      // the entity source map).
      await em.query(
        `DELETE FROM ci_search.embeddings
          WHERE user_id = $1 AND entity_id = ANY($2::uuid[])`,
        [ownerUserId, sources],
      );

      await em.query(
        `DELETE FROM ci_search.vectors
          WHERE user_id = $1 AND entity_id = ANY($2::uuid[])`,
        [ownerUserId, sources],
      );

      // Tags: move each source's tag links to the target, skipping links the
      // target already has (entity_tag_unique_entry) and collapsing duplicate
      // claims across sources to one row; leftovers are dropped with the
      // tombstone.
      await em.query(
        `UPDATE ci_search.entity_tag t
            SET entity_id = $2
          WHERE t.entity_type = 'person' AND t.entity_id = ANY($1::uuid[])
            AND NOT EXISTS (
              SELECT 1 FROM ci_search.entity_tag d
               WHERE d.entity_type = 'person' AND d.entity_id = $2 AND d.tag_id = t.tag_id)
            AND t.id IN (
              SELECT DISTINCT ON (tag_id) id
                FROM ci_search.entity_tag
               WHERE entity_type = 'person' AND entity_id = ANY($1::uuid[])
               ORDER BY tag_id, id ASC)`,
        [sources, targetId],
      );

      await em.query(
        `DELETE FROM ci_search.entity_tag
          WHERE entity_type = 'person' AND entity_id = ANY($1::uuid[])`,
        [sources],
      );

      for (const id of sources) {
        await em.query(
          `INSERT INTO ci.entity_merges (owner_user_id, source_entity_id, target_entity_id, entity_type, details)
           VALUES ($1, $2, $3, 'Person', $4::jsonb)`,
          [
            ownerUserId,
            id,
            targetId,
            JSON.stringify({ counts, sourceProperties: byId.get(id)?.properties ?? {} }),
          ],
        );
      }

      this.logger.log(`Merged ${sources.length} person(s) into ${targetId}: ${JSON.stringify(counts)}`);

      return counts;
    });

    this.logger.log(`Person merge committed for target ${targetId} (${JSON.stringify(merged)})`);

    await this.eventService.send(PersonUpdatedEvent, { personId: targetId });

    const entity = await this.personRepository.findOne({
      where: { id: targetId, userId: ownerUserId },
    });

    if (!entity) {
      throw new NotFoundException(`Merge target ${targetId} vanished mid-merge`);
    }

    return PersonEntity.toEgressType(entity);
  }

  /**
   * Re-point every dependent reference from the sources to the target. All
   * statements are owner-scoped; array columns are rewritten set-based with a
   * DISTINCT unnest so a row referencing both a source and the target ends up
   * with a single target element.
   *
   * Every count goes through {@link countAffected}, never `….length` of a bare
   * `UPDATE/DELETE … RETURNING`: TypeORM resolves that to `[rows, rowCount]`,
   * which made each of these a constant 2 in the audit row (and
   * `relationshipsDropped` a constant 6).
   *
   * The relationship statements run in a fixed order: the self-reference drop,
   * both guarded re-points, and only THEN the two sweeps. Each statement of a
   * READ COMMITTED transaction takes its own snapshot, and the re-points are the
   * long ones (a person with thousands of edges moves them all in one UPDATE) —
   * the sweeps are short and read last, so the span in which a concurrent commit
   * can slip past every statement is as small as it can be made here.
   */
  private async repointReferences(
    em: EntityManager,
    ownerUserId: string,
    sources: string[],
    targetId: string,
  ): Promise<MergeCounts> {
    const identifiers = await countAffected(
      em,
      `WITH repointed AS (
         UPDATE ci.entity_identifiers SET entity_id = $3
          WHERE owner_user_id = $1 AND entity_id = ANY($2::uuid[])
          RETURNING 1
       )
       SELECT count(*)::int AS count FROM repointed`,
      [ownerUserId, sources, targetId],
    );

    // The EVIDENCE behind those index rows. A claim's entity_id is WHO an
    // observation resolved to, and after a merge that is the target; everything
    // describing the observation stays put. Left on the tombstone, the source's
    // claims stop counting: clean.duplicate_detect joins holders to live
    // entities only. A plain UPDATE cannot collide: entity_id is not part of
    // identifier_claims_observation_uniq. Rejected claims move too and stay
    // rejected; every reader excludes them on both sides.
    const claims = await countAffected(
      em,
      `WITH repointed AS (
         UPDATE ci.identifier_claims SET entity_id = $3
          WHERE owner_user_id = $1 AND entity_id = ANY($2::uuid[])
          RETURNING 1
       )
       SELECT count(*)::int AS count FROM repointed`,
      [ownerUserId, sources, targetId],
    );

    // A human's "these two are NOT the same person" about a source now holds
    // for the target. Carried as a new (target, other) row; the source's own
    // row stays for an unmerge replay, and a block between people this merge
    // folds together is not carried.
    const blocksCarried = await countAffected(
      em,
      `WITH carried AS (
         INSERT INTO ci.entity_merge_blocks (owner_user_id, entity_id_a, entity_id_b, reason)
         SELECT DISTINCT ON (LEAST($3::uuid, blocked.other_id), GREATEST($3::uuid, blocked.other_id))
                $1::uuid, LEAST($3::uuid, blocked.other_id), GREATEST($3::uuid, blocked.other_id),
                blocked.reason
           FROM (
             SELECT CASE WHEN b.entity_id_a = ANY($2::uuid[]) THEN b.entity_id_b ELSE b.entity_id_a END
                      AS other_id,
                    b.reason, b.created_at
               FROM ci.entity_merge_blocks b
              WHERE b.owner_user_id = $1
                AND (b.entity_id_a = ANY($2::uuid[]) OR b.entity_id_b = ANY($2::uuid[]))
           ) blocked
          WHERE blocked.other_id <> $3::uuid AND NOT (blocked.other_id = ANY($2::uuid[]))
          ORDER BY LEAST($3::uuid, blocked.other_id), GREATEST($3::uuid, blocked.other_id),
                   blocked.created_at ASC
         ON CONFLICT (owner_user_id, entity_id_a, entity_id_b) DO NOTHING
         RETURNING 1
       )
       SELECT count(*)::int AS count FROM carried`,
      [ownerUserId, sources, targetId],
    );

    const communicationsFrom = await countAffected(
      em,
      `WITH repointed AS (
         UPDATE ci.communications SET from_entity_id = $3
          WHERE user_id = $1 AND from_entity_id = ANY($2::uuid[])
          RETURNING 1
       )
       SELECT count(*)::int AS count FROM repointed`,
      [ownerUserId, sources, targetId],
    );

    const communicationsTo = await countAffected(
      em,
      `WITH repointed AS (
         UPDATE ci.communications c
            SET to_entity_ids = sub.new_ids
           FROM (
             SELECT time, user_id, id,
                    ARRAY(SELECT DISTINCT CASE WHEN x = ANY($2::uuid[]) THEN $3::uuid ELSE x END
                            FROM unnest(to_entity_ids) AS x) AS new_ids
               FROM ci.communications
              WHERE user_id = $1 AND to_entity_ids && $2::uuid[]
           ) sub
          WHERE c.time = sub.time AND c.user_id = sub.user_id AND c.id = sub.id
          RETURNING 1
       )
       SELECT count(*)::int AS count FROM repointed`,
      [ownerUserId, sources, targetId],
    );

    const eventsOrganizer = await countAffected(
      em,
      `WITH repointed AS (
         UPDATE ci.events SET organizer_entity_id = $3
          WHERE user_id = $1 AND organizer_entity_id = ANY($2::uuid[])
          RETURNING 1
       )
       SELECT count(*)::int AS count FROM repointed`,
      [ownerUserId, sources, targetId],
    );

    const eventsParticipants = await countAffected(
      em,
      `WITH repointed AS (
         UPDATE ci.events e
            SET participant_entity_ids = sub.new_ids
           FROM (
             SELECT event_id,
                    ARRAY(SELECT DISTINCT CASE WHEN x = ANY($2::uuid[]) THEN $3::uuid ELSE x END
                            FROM unnest(participant_entity_ids) AS x) AS new_ids
               FROM ci.events
              WHERE user_id = $1 AND participant_entity_ids && $2::uuid[]
           ) sub
          WHERE e.event_id = sub.event_id
          RETURNING 1
       )
       SELECT count(*)::int AS count FROM repointed`,
      [ownerUserId, sources, targetId],
    );

    // Relationships: drop edges that a re-point would turn into
    // self-references (from and to both land on the target) or that only
    // connected the duplicates to each other.
    const droppedSelfRef = await countAffected(
      em,
      `WITH dropped AS (
         DELETE FROM ci.relationships
          WHERE owner_user_id = $1
            AND ( (from_entity_id = ANY($2::uuid[]) AND (to_entity_id = $3 OR to_entity_id = ANY($2::uuid[])))
               OR (to_entity_id = ANY($2::uuid[]) AND from_entity_id = $3) )
          RETURNING 1
       )
       SELECT count(*)::int AS count FROM dropped`,
      [ownerUserId, sources, targetId],
    );

    // Guarded re-point of the from side. Two guards keep the partial unique
    // index relationships_unique_directed_idx (active edges only) intact
    // within the single set-based statement:
    // 1. skip rows whose re-pointed shape already exists as an active target
    //    edge, and
    // 2. among the candidates themselves, re-point only ONE active row per
    //    (to, type) shape (DISTINCT ON, oldest wins) — two duplicate people
    //    with the same edge would otherwise collapse onto the index mid-UPDATE.
    // Inactive rows are outside the index and re-point unconditionally.
    const relationshipsFrom = await countAffected(
      em,
      `WITH repointed AS (
         UPDATE ci.relationships r SET from_entity_id = $3
          WHERE r.owner_user_id = $1 AND r.from_entity_id = ANY($2::uuid[])
            AND (
              r.is_active IS DISTINCT FROM TRUE
              OR (
                NOT EXISTS (
                  SELECT 1 FROM ci.relationships d
                   WHERE d.from_entity_id = $3 AND d.to_entity_id = r.to_entity_id
                     AND d.relationship_type = r.relationship_type AND d.is_active = TRUE)
                AND r.relationship_id IN (
                  SELECT DISTINCT ON (to_entity_id, relationship_type) relationship_id
                    FROM ci.relationships
                   WHERE owner_user_id = $1 AND from_entity_id = ANY($2::uuid[]) AND is_active = TRUE
                   ORDER BY to_entity_id, relationship_type, created_at ASC)
              )
            )
          RETURNING 1
       )
       SELECT count(*)::int AS count FROM repointed`,
      [ownerUserId, sources, targetId],
    );

    const relationshipsTo = await countAffected(
      em,
      `WITH repointed AS (
         UPDATE ci.relationships r SET to_entity_id = $3
          WHERE r.owner_user_id = $1 AND r.to_entity_id = ANY($2::uuid[])
            AND (
              r.is_active IS DISTINCT FROM TRUE
              OR (
                NOT EXISTS (
                  SELECT 1 FROM ci.relationships d
                   WHERE d.from_entity_id = r.from_entity_id AND d.to_entity_id = $3
                     AND d.relationship_type = r.relationship_type AND d.is_active = TRUE)
                AND r.relationship_id IN (
                  SELECT DISTINCT ON (from_entity_id, relationship_type) relationship_id
                    FROM ci.relationships
                   WHERE owner_user_id = $1 AND to_entity_id = ANY($2::uuid[]) AND is_active = TRUE
                   ORDER BY from_entity_id, relationship_type, created_at ASC)
              )
            )
          RETURNING 1
       )
       SELECT count(*)::int AS count FROM repointed`,
      [ownerUserId, sources, targetId],
    );

    // Any edge that still holds a source after the re-points is swept. This used
    // to be a plain DELETE of every such row, on the premise that the guarded
    // UPDATEs had declined it as a duplicate — true of each row the UPDATEs
    // saw, false of a row committed after their snapshots (see
    // sweepLeftoverEdges). Both sweeps come after both re-points on purpose.
    const sweep = {
      ownerUserId,
      sources,
      targetId,
      changeSource: 'PersonMergeService.mergePeople',
      changeReason: 'person_merge.rescued_edge',
    };
    const sweptFrom = await sweepLeftoverEdges(em, this.graphDeltaWriter, { ...sweep, end: 'from' });
    const sweptTo = await sweepLeftoverEdges(em, this.graphDeltaWriter, { ...sweep, end: 'to' });

    return {
      identifiers,
      claims,
      blocksCarried,
      communicationsFrom,
      communicationsTo,
      eventsOrganizer,
      eventsParticipants,
      relationshipsFrom,
      relationshipsTo,
      relationshipsDropped: droppedSelfRef + sweptFrom.dropped + sweptTo.dropped,
      relationshipsRescued: sweptFrom.rescued + sweptTo.rescued,
    };
  }
}

function firstNonEmpty(values: Array<string | null | undefined>): string | null {
  for (const value of values) {
    if (value != null && value.trim() !== '') {
      return value;
    }
  }

  return null;
}

/** Target wins scalars; emails/phones/names arrays are unioned across all rows. */
function foldProperties(
  target: Record<string, unknown>,
  sources: Array<Record<string, unknown>>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...target };

  for (const source of sources) {
    for (const [key, value] of Object.entries(source)) {
      if (value == null) {
        continue;
      }

      if (out[key] == null || out[key] === '') {
        out[key] = value;
      }
    }
  }

  for (const key of ['emails', 'phones', 'names']) {
    const union = new Set<string>();
    for (const props of [target, ...sources]) {
      const list = props[key];
      if (Array.isArray(list)) {
        for (const item of list) {
          if (typeof item === 'string' && item.trim() !== '') {
            union.add(item);
          }
        }
      }
    }

    if (union.size > 0) {
      out[key] = [...union];
    }
  }

  // The raw `Phones` a contact import kept as typed ("+44 20 7946 0958") are
  // the only place a number's COUNTRY survives; `phones` holds ten-digit keys.
  // Target-wins on this key would drop the source's stated forms while its
  // keys were unioned above, and the phone adjudicator (utils/phoneIdentity.ts)
  // would then read a UK key as an inferred +1. So union it too, de-duplicated
  // on the digit string with the first-seen formatting kept.
  //
  // `Faxes` for the same reason one step on: it is the only record that a
  // number is office equipment, and the adjudicator refuses it as evidence.
  // Target-wins would let the source's fax — often the very number its
  // `phones` key holds — reach the target as an ordinary line.
  for (const key of ['Phones', 'Faxes']) {
    const typed: string[] = [];
    const seenDigits = new Set<string>();

    for (const props of [target, ...sources]) {
      const raw = props[key];
      const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];

      for (const item of list) {
        if (typeof item !== 'string' || item.trim() === '') {
          continue;
        }

        const digits = item.replace(/\D/g, '') || item.trim();

        if (!seenDigits.has(digits)) {
          seenDigits.add(digits);
          typed.push(item);
        }
      }
    }

    if (typed.length > 0) {
      out[key] = typed;
    }
  }

  // A tombstone's self flag must never leak onto the target: gate on the
  // TARGET's original value, not the folded output (the scalar fold above may
  // have already copied a source's is_self into `out`).
  if (target.is_self === true || target.is_self === 'true') {
    out.is_self = target.is_self;
  } else {
    delete out.is_self;
  }

  return out;
}
