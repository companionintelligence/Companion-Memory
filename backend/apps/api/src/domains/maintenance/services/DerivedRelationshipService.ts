import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { LoggerService } from '@ci/common/logging';
import { RelationshipType } from '@ci/domains/graph';
import { GraphDeltaWriter } from '@ci/domains/memory';

/**
 * How many separate days at a place make it one the owner FREQUENTS.
 *
 * Days rather than visits: `ci.position` is the only repeat-visit signal the
 * schema carries, and it counts GPS fixes, not arrivals.
 */
const FREQUENTS_MIN_VISIT_DAYS = 3;

/**
 * The exchanged-communication count that reads as a full-strength tie.
 *
 * Any [0, 1] weight has to clamp somewhere; the only question is where the
 * resolution is spent. A log curve normalised on this number spends it across
 * the whole heavy tail of a real corpus — 1 → 0.08, 10 → 0.26, 100 → 0.50,
 * 5,000 → 0.92 — instead of piling every correspondent above a few hundred
 * messages into the top hundredth. Ten thousand exchanges between two people
 * is unambiguously a strongest tie, and telling 10k apart from 40k is not a
 * distinction the graph does anything with.
 */
const COMMUNICATES_FULL_STRENGTH_COUNT = 10_000;

/**
 * Per-call switches for {@link DerivedRelationshipService.derive}.
 *
 * The split exists because the three legs are not the same KIND of write. Two
 * of them project an aggregate of edges the user's own data already asserts
 * (people who demonstrably emailed each other; a place visited three times).
 * The third MINTS A NEW ENTITY — a `Group` nobody's data names — which is a
 * claim about the user's life rather than a summary of it, and therefore
 * something the Autonomy trust dial has to be asked about first.
 */
export interface DerivedRelationshipOptions {
  /**
   * Reify household `Group` entities from LIVES_WITH + shared LIVES_IN clusters.
   *
   * Defaults to TRUE, which keeps every pre-existing caller (POST
   * /api/maintenance/derive-relationships, the orchestrator's
   * `derive_relationships` leg driven by an operator over HTTP/CLI) behaving
   * exactly as before: a human asked for the whole stage.
   *
   * The scheduled caller passes FALSE unless
   * `PersonalizationService.decideAction({ kind: 'graph_entity' })` returned
   * `auto` — see `DerivationRunListener`. A timer is not a human, and
   * `graph_entity` is in `GRAPH_CONNECTION_KINDS`, so only `hands_off` ever
   * auto-applies it.
   */
  reifyHouseholdGroups?: boolean;
}

export interface DerivedRelationshipResult {
  communicatesWith: number;
  frequents: number;
  groupsReified: number;
  /**
   * Why `groupsReified` is what it is. `withheld` means the leg was not run at
   * all — a zero that says "not permitted" instead of "nothing to do", which is
   * the difference between a signal and a silence on the Jobs dashboard.
   */
  householdReification: 'applied' | 'withheld';
}

/**
 * #1947 stages C–D — L2 aggregates and derived Groups.
 *
 * Aggregates upsert strength-weighted edges from episodic history; Groups are
 * reified from indicator clusters with provenance for the interview loop.
 * Idempotent: re-running converges on the directed unique index.
 */
@Injectable()
export class DerivedRelationshipService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly graphDeltaWriter: GraphDeltaWriter,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(DerivedRelationshipService.name);
  }

  async derive(userId: string, options: DerivedRelationshipOptions = {}): Promise<DerivedRelationshipResult> {
    const reifyHouseholds = options.reifyHouseholdGroups !== false;
    const communicatesWith = await this.upsertCommunicatesWith(userId);
    const frequents = await this.upsertFrequents(userId);
    const groupsReified = reifyHouseholds ? await this.reifyHouseholdGroups(userId) : 0;

    this.logger.log('Derived relationship pass complete', {
      userId,
      communicatesWith,
      frequents,
      groupsReified,
      householdReification: reifyHouseholds ? 'applied' : 'withheld',
    });

    return {
      communicatesWith,
      frequents,
      groupsReified,
      householdReification: reifyHouseholds ? 'applied' : 'withheld',
    };
  }

  /**
   * COMMUNICATES_WITH between two people, weighted by how much they actually
   * exchanged.
   *
   * ### Which pairs, and how strongly
   *
   * The PAIR SET comes from episodic EMAILED / MESSAGED / CALLED / MET_WITH /
   * ORGANIZED_EVENT_WITH person↔person edges, unordered via LEAST/GREATEST. The
   * WEIGHT comes from the evidence, not from those edges — for the same reason
   * the FREQUENTS leg takes its day count from `ci.position`:
   * `relationships_unique_directed_idx` is UNIQUE on
   * (from_entity_id, to_entity_id, relationship_type) WHERE `is_active`, so a
   * pair holds at most ONE active row per direction per type. Counting those
   * rows counts DISTINCT (direction, type) combinations — bounded at 10 across
   * the five types — however many emails, messages or calls actually passed
   * between the two people, and `LEAST(1, LN(n+1)/LN(10)/2)` over a count that
   * cannot exceed 10 saturates at ≈0.52. Two colleagues who traded 4,000 emails
   * and two people who swapped one text scored the same.
   *
   * So the volume is read off `ci.communications`: rows naming both people, in
   * EITHER direction (`from_entity_id` = one and the other in `to_entity_ids`),
   * summed as two index-driven counts rather than one OR so each half rides
   * `communications_from_idx`. A pair is unordered here exactly as it is in the
   * episodic CTE.
   *
   * Both figures are kept, under names that say what they measure:
   * `episodic_link_kinds` (how many DISTINCT ways the graph links the pair) and
   * `communications_exchanged` (how many messages the corpus holds).
   *
   * The curve is `LN(c+1) / LN(COMMUNICATES_FULL_STRENGTH_COUNT)`, floored at
   * the old link-kind term so no existing edge can be WEAKENED by a pair whose
   * communications were never entity-resolved — a MET_WITH-only pair, or one
   * whose messages carry no `to_entity_ids`, keeps exactly the weight it has
   * today. Log, not linear: correspondence volume is heavy-tailed, and the
   * useful question is "which of these ties is stronger", which a linear scale
   * answers by putting every real correspondent at 1.
   *
   * ### Why this may UPDATE, and what it may not touch
   *
   * `ON CONFLICT DO NOTHING` would leave every already-derived edge at the
   * strength the old formula gave it forever, so the re-derive that makes the
   * new weight real would silently do nothing. The conflict action therefore
   * updates — but only rows THIS service's provenance stamp owns, and only the
   * `strength` and the four properties keys the derivation writes (via a shallow
   * `||` merge that leaves everything else on the row alone). An edge a person
   * curated, or another producer asserted, is left exactly as it stands and is
   * not counted. That keeps the leg what `DerivationRunListener` describes: a
   * projection of assertions the user's own data already makes, which is why it
   * runs on a timer without a `decideAction` gate — unlike the household leg,
   * which mints an entity and does have one.
   *
   * The `WHERE` on the DO UPDATE also compares before/after, so a pass that
   * changes nothing writes nothing, returns nothing, and emits no delta.
   */
  private async upsertCommunicatesWith(userId: string): Promise<number> {
    return this.dataSource.transaction(async (manager) => {
      // Historical rows sometimes store entity types in lowercase ('person');
      // match case-insensitively and always write canonical 'Person'.
      const upserted: Array<{
        relationship_id: string;
        from_entity_id: string;
        to_entity_id: string;
        inserted: boolean;
        old_strength: number | null;
        new_strength: number;
      }> = await manager.query(
        `WITH episodic AS (
           SELECT
             LEAST(from_entity_id, to_entity_id) AS a,
             GREATEST(from_entity_id, to_entity_id) AS b,
             -- Distinct (direction, type) rows, NOT episodes: the unique index
             -- caps this at 10. See the method comment.
             COUNT(*)::int AS link_kinds
           FROM ci.relationships
          WHERE owner_user_id = $1
            AND is_active = TRUE
            AND relationship_type = ANY($2::text[])
            AND lower(from_entity_type) = 'person'
            AND lower(to_entity_type) = 'person'
            AND from_entity_id <> to_entity_id
          GROUP BY 1, 2
         ),
         measured AS (
           SELECT
             e.a,
             e.b,
             e.link_kinds,
             (
               (SELECT COUNT(*)
                  FROM ci.communications m
                 WHERE m.user_id = $1
                   AND m.from_entity_id = e.a
                   AND m.to_entity_ids @> ARRAY[e.b])
               +
               (SELECT COUNT(*)
                  FROM ci.communications m
                 WHERE m.user_id = $1
                   AND m.from_entity_id = e.b
                   AND m.to_entity_ids @> ARRAY[e.a])
             )::int AS exchanged
           FROM episodic e
         ),
         -- The pre-statement strengths, so an updated edge can report what it
         -- moved FROM. Every CTE of one statement reads the same snapshot.
         prior AS (
           SELECT from_entity_id, to_entity_id, strength
             FROM ci.relationships
            WHERE owner_user_id = $1
              AND relationship_type = $3
              AND is_active = TRUE
         ),
         upserted AS (
           INSERT INTO ci.relationships AS r
             (from_entity_id, to_entity_id, relationship_type, strength, properties,
              owner_user_id, from_entity_type, to_entity_type, is_bidirectional)
           SELECT a, b, $3,
                  GREATEST(
                    LEAST(1.0, LN(link_kinds + 1) / LN(10) / 2.0),
                    LEAST(1.0, LN(exchanged + 1) / LN($4::float8))
                  ),
                  jsonb_build_object(
                    'layer', 'L2',
                    'provenance', jsonb_build_object(
                      'source', 'DerivedRelationshipService',
                      'job', 'communicates_with',
                      'derived_from', 'communications.from_entity_id/to_entity_ids'
                    ),
                    'episodic_link_kinds', link_kinds,
                    'communications_exchanged', exchanged
                  ),
                  $1, 'Person', 'Person', TRUE
             FROM measured
           ON CONFLICT (from_entity_id, to_entity_id, relationship_type) WHERE is_active
           DO UPDATE SET
             strength = EXCLUDED.strength,
             properties = r.properties || EXCLUDED.properties,
             updated_at = now()
           WHERE r.properties -> 'provenance' ->> 'source' = 'DerivedRelationshipService'
             AND (
               r.strength IS DISTINCT FROM EXCLUDED.strength
               OR r.properties IS DISTINCT FROM (r.properties || EXCLUDED.properties)
             )
           RETURNING relationship_id, from_entity_id, to_entity_id, strength, (xmax = 0) AS inserted
         )
         SELECT u.relationship_id,
                u.from_entity_id,
                u.to_entity_id,
                u.inserted,
                p.strength AS old_strength,
                u.strength AS new_strength
           FROM upserted u
           LEFT JOIN prior p
             ON p.from_entity_id = u.from_entity_id
            AND p.to_entity_id = u.to_entity_id`,
        [
          userId,
          ['EMAILED', 'MESSAGED', 'CALLED', 'MET_WITH', 'ORGANIZED_EVENT_WITH'],
          RelationshipType.COMMUNICATES_WITH,
          COMMUNICATES_FULL_STRENGTH_COUNT,
        ],
      );

      await this.recordEdgeDeltas(manager, userId, RelationshipType.COMMUNICATES_WITH, upserted);

      return upserted.length;
    });
  }

  /**
   * FREQUENTS for places the owner visited on ≥ {@link FREQUENTS_MIN_VISIT_DAYS}
   * separate days (strength by day count).
   *
   * A repeat visit is NOT countable from `ci.relationships`:
   * `relationships_unique_directed_idx` is UNIQUE on (from, to, type) WHERE
   * is_active, so a person→place pair holds at most ONE active VISITED row no
   * matter how many times the place was visited. Counting those rows is always
   * `1`, which is what made this leg a nightly no-op.
   *
   * The count comes from the evidence the edge was projected from instead:
   * `ci.position` rows whose `location_entity_id` snapped to the place (the
   * `position.visited` rule in the deterministic-edge matrix). Distinct days,
   * not fixes — telemetry emits fixes by the minute, so a row count would call
   * a single afternoon a habit.
   *
   * The VISITED edge is still the gate: FREQUENTS only ever strengthens a
   * place the graph already asserts the owner goes to, and the per-place
   * LATERAL keeps the position scan on `position_entity_idx` rather than
   * grouping the whole hypertable. Day boundaries are UTC because
   * `ci.users.timezone` is unvalidated free text and one bad value there would
   * fault the entire nightly pass.
   */
  private async upsertFrequents(userId: string): Promise<number> {
    return this.dataSource.transaction(async (manager) => {
      const inserted: Array<{
        relationship_id: string;
        from_entity_id: string;
        to_entity_id: string;
      }> = await manager.query(
        // Every VISITED edge starts at the owner's own Person entity
        // (ci.users.entity_id) — both producers, the position projection and
        // KnownPlacesService, anchor it there — and ci.position holds only the
        // owner's telemetry, so the join is what keeps a count of the owner's
        // fixes from being attributed to somebody else's visits.
        `WITH visited AS (
           SELECT r.from_entity_id, r.to_entity_id, r.from_entity_type, r.to_entity_type
             FROM ci.relationships r
             JOIN ci.users u ON u.entity_id = r.from_entity_id AND u.id = $1
            WHERE r.owner_user_id = $1
              AND r.is_active = TRUE
              AND r.relationship_type = 'VISITED'
         ),
         visits AS (
           SELECT v.from_entity_id, v.to_entity_id, v.from_entity_type, v.to_entity_type, d.days AS n
             FROM visited v
             CROSS JOIN LATERAL (
               SELECT COUNT(DISTINCT (p.time AT TIME ZONE 'UTC')::date)::int AS days
                 FROM ci.position p
                WHERE p.user_id = $1
                  AND p.location_entity_id = v.to_entity_id
             ) d
            WHERE d.days >= $3
         )
         INSERT INTO ci.relationships
           (from_entity_id, to_entity_id, relationship_type, strength, properties,
            owner_user_id, from_entity_type, to_entity_type, is_bidirectional)
         SELECT from_entity_id, to_entity_id, $2,
                LEAST(1.0, LN(n + 1) / LN(10) / 2.0),
                jsonb_build_object(
                  'layer', 'L2',
                  'context', 'unknown',
                  'provenance', jsonb_build_object(
                    'source', 'DerivedRelationshipService',
                    'job', 'frequents',
                    'derived_from', 'position.location_entity_id'
                  ),
                  'visit_days', n
                ),
                $1, from_entity_type, to_entity_type, FALSE
           FROM visits
         ON CONFLICT DO NOTHING
         RETURNING relationship_id, from_entity_id, to_entity_id`,
        [userId, RelationshipType.FREQUENTS, FREQUENTS_MIN_VISIT_DAYS],
      );

      await this.recordEdgeDeltas(
        manager,
        userId,
        RelationshipType.FREQUENTS,
        inserted.map((row) => ({ ...row, inserted: true })),
      );

      return inserted.length;
    });
  }

  /**
   * Household Groups from shared LIVES_IN + LIVES_WITH clusters.
   * Creates a Group entity (`group_kind: household`) and MEMBER_OF edges.
   */
  private async reifyHouseholdGroups(userId: string): Promise<number> {
    return this.dataSource.transaction(async (manager) => {
      // Pairwise people who LIVES_WITH each other and share a LIVES_IN place.
      const clusters: Array<{ place_id: string; person_ids: string[] }> = await manager.query(
        `WITH cohabit AS (
           SELECT DISTINCT
             LEAST(r.from_entity_id, r.to_entity_id) AS a,
             GREATEST(r.from_entity_id, r.to_entity_id) AS b
           FROM ci.relationships r
          WHERE r.owner_user_id = $1
            AND r.is_active = TRUE
            AND r.relationship_type = 'LIVES_WITH'
         ),
         homes AS (
           SELECT from_entity_id AS person_id, to_entity_id AS place_id
             FROM ci.relationships
            WHERE owner_user_id = $1
              AND is_active = TRUE
              AND relationship_type = 'LIVES_IN'
         )
         SELECT h1.place_id,
                ARRAY_AGG(DISTINCT x.person_id ORDER BY x.person_id) AS person_ids
           FROM cohabit c
           JOIN homes h1 ON h1.person_id = c.a
           JOIN homes h2 ON h2.person_id = c.b AND h2.place_id = h1.place_id
           CROSS JOIN LATERAL (VALUES (c.a), (c.b)) AS x(person_id)
          GROUP BY h1.place_id
         HAVING COUNT(DISTINCT x.person_id) >= 2`,
        [userId],
      );

      let created = 0;

      for (const cluster of clusters) {
        // Stable linked_id = place uuid (entities.linked_id is uuid, not text).
        const existing: Array<{ entity_id: string }> = await manager.query(
          `SELECT entity_id FROM ci.entities
            WHERE owner_user_id = $1 AND entity_type = 'Group'
              AND linked_table = 'derived_household' AND linked_id = $2::uuid
            LIMIT 1`,
          [userId, cluster.place_id],
        );

        let groupId = existing[0]?.entity_id;

        if (!groupId) {
          const inserted: Array<{ entity_id: string }> = await manager.query(
            `INSERT INTO ci.entities
               (entity_id, entity_type, name, owner_user_id, is_active, linked_table, linked_id, properties)
             VALUES (gen_random_uuid(), 'Group', $3, $1, TRUE, 'derived_household', $2::uuid,
                     jsonb_build_object(
                       'group_kind', 'household',
                       'layer', 'L2',
                       'strength', 0.6,
                       'provenance', jsonb_build_object('source', 'DerivedRelationshipService', 'place_id', $2)
                     ))
             RETURNING entity_id`,
            [userId, cluster.place_id, 'Household'],
          );
          groupId = inserted[0].entity_id;
          created += 1;

          // Group −LOCATED_AT→ Place
          await manager.query(
            `INSERT INTO ci.relationships
               (from_entity_id, to_entity_id, relationship_type, strength, properties,
                owner_user_id, from_entity_type, to_entity_type, is_bidirectional)
             VALUES ($1, $2, 'LOCATED_AT', 0.8,
                     jsonb_build_object('layer', 'L2', 'provenance', jsonb_build_object('source', 'DerivedRelationshipService')),
                     $3, 'Group', 'Location', FALSE)
             ON CONFLICT DO NOTHING`,
            [groupId, cluster.place_id, userId],
          );
        }

        for (const personId of cluster.person_ids) {
          await manager.query(
            `INSERT INTO ci.relationships
               (from_entity_id, to_entity_id, relationship_type, strength, properties,
                owner_user_id, from_entity_type, to_entity_type, is_bidirectional)
             VALUES ($1, $2, 'MEMBER_OF', 0.7,
                     jsonb_build_object('role', 'resident', 'layer', 'L2',
                       'provenance', jsonb_build_object('source', 'DerivedRelationshipService', 'confirmed_by', null)),
                     $3, 'Person', 'Group', FALSE)
             ON CONFLICT DO NOTHING`,
            [personId, groupId, userId],
          );
        }
      }

      return created;
    });
  }

  /**
   * One `ci.graph_deltas` row per edge this pass actually wrote, in the SAME
   * transaction as the write.
   *
   * A re-weighted edge is `updated`, not `created`: the insight stream reads
   * this, and re-announcing an edge it already announced would be a phantom.
   * `changedFields.strength` carries the move so a reader can tell a
   * re-derivation that mattered from one that did not.
   */
  private async recordEdgeDeltas(
    manager: Parameters<GraphDeltaWriter['recordMany']>[1],
    userId: string,
    relationshipType: string,
    rows: Array<{
      relationship_id: string;
      from_entity_id: string;
      to_entity_id: string;
      inserted: boolean;
      old_strength?: number | null;
      new_strength?: number;
    }>,
  ): Promise<void> {
    if (rows.length === 0) {
      return;
    }

    await this.graphDeltaWriter.recordMany(
      rows.map((row) => ({
        nodeType: 'relationship' as const,
        changeType: row.inserted ? ('created' as const) : ('updated' as const),
        relationshipId: row.relationship_id,
        relationshipType,
        fromEntityId: row.from_entity_id,
        toEntityId: row.to_entity_id,
        ownerUserId: userId,
        changeSource: 'DerivedRelationshipService',
        changeReason: relationshipType,
        ...(row.inserted
          ? {}
          : { changedFields: { strength: { old: row.old_strength ?? null, new: row.new_strength } } }),
      })),
      manager,
    );
  }
}
