import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { LoggerService } from '@ci/common/logging';
import { RelationshipType } from '@ci/domains/graph';
import { GraphDeltaWriter } from '@ci/domains/memory';

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

  async derive(userId: string): Promise<{
    communicatesWith: number;
    frequents: number;
    groupsReified: number;
  }> {
    const communicatesWith = await this.upsertCommunicatesWith(userId);
    const frequents = await this.upsertFrequents(userId);
    const groupsReified = await this.reifyHouseholdGroups(userId);

    this.logger.log('Derived relationship pass complete', {
      userId,
      communicatesWith,
      frequents,
      groupsReified,
    });

    return { communicatesWith, frequents, groupsReified };
  }

  /**
   * COMMUNICATES_WITH from episodic EMAILED / MESSAGED / CALLED / SENT-pair
   * person↔person edges. Strength = min(1, log10(count+1)/2).
   */
  private async upsertCommunicatesWith(userId: string): Promise<number> {
    return this.dataSource.transaction(async (manager) => {
      // Historical rows sometimes store entity types in lowercase ('person');
      // match case-insensitively and always write canonical 'Person'.
      const inserted: Array<{
        relationship_id: string;
        from_entity_id: string;
        to_entity_id: string;
      }> = await manager.query(
        `WITH episodic AS (
           SELECT
             LEAST(from_entity_id, to_entity_id) AS a,
             GREATEST(from_entity_id, to_entity_id) AS b,
             COUNT(*)::int AS n
           FROM ci.relationships
          WHERE owner_user_id = $1
            AND is_active = TRUE
            AND relationship_type = ANY($2::text[])
            AND lower(from_entity_type) = 'person'
            AND lower(to_entity_type) = 'person'
            AND from_entity_id <> to_entity_id
          GROUP BY 1, 2
         )
         INSERT INTO ci.relationships
           (from_entity_id, to_entity_id, relationship_type, strength, properties,
            owner_user_id, from_entity_type, to_entity_type, is_bidirectional)
         SELECT a, b, $3,
                LEAST(1.0, LN(n + 1) / LN(10) / 2.0),
                jsonb_build_object(
                  'layer', 'L2',
                  'provenance', jsonb_build_object('source', 'DerivedRelationshipService', 'job', 'communicates_with'),
                  'episode_count', n
                ),
                $1, 'Person', 'Person', TRUE
           FROM episodic
         ON CONFLICT DO NOTHING
         RETURNING relationship_id, from_entity_id, to_entity_id`,
        [
          userId,
          ['EMAILED', 'MESSAGED', 'CALLED', 'MET_WITH', 'ORGANIZED_EVENT_WITH'],
          RelationshipType.COMMUNICATES_WITH,
        ],
      );

      await this.recordCreated(manager, userId, RelationshipType.COMMUNICATES_WITH, inserted);

      return inserted.length;
    });
  }

  /**
   * FREQUENTS from VISITED edges — places visited ≥ 3 times (strength by count).
   */
  private async upsertFrequents(userId: string): Promise<number> {
    return this.dataSource.transaction(async (manager) => {
      const inserted: Array<{
        relationship_id: string;
        from_entity_id: string;
        to_entity_id: string;
      }> = await manager.query(
        `WITH visits AS (
           SELECT from_entity_id, to_entity_id, from_entity_type, to_entity_type, COUNT(*)::int AS n
             FROM ci.relationships
            WHERE owner_user_id = $1
              AND is_active = TRUE
              AND relationship_type = 'VISITED'
            GROUP BY 1, 2, 3, 4
           HAVING COUNT(*) >= 3
         )
         INSERT INTO ci.relationships
           (from_entity_id, to_entity_id, relationship_type, strength, properties,
            owner_user_id, from_entity_type, to_entity_type, is_bidirectional)
         SELECT from_entity_id, to_entity_id, $2,
                LEAST(1.0, LN(n + 1) / LN(10) / 2.0),
                jsonb_build_object(
                  'layer', 'L2',
                  'context', 'unknown',
                  'provenance', jsonb_build_object('source', 'DerivedRelationshipService', 'job', 'frequents'),
                  'visit_count', n
                ),
                $1, from_entity_type, to_entity_type, FALSE
           FROM visits
         ON CONFLICT DO NOTHING
         RETURNING relationship_id, from_entity_id, to_entity_id`,
        [userId, RelationshipType.FREQUENTS],
      );

      await this.recordCreated(manager, userId, RelationshipType.FREQUENTS, inserted);

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

  private async recordCreated(
    manager: Parameters<GraphDeltaWriter['recordMany']>[1],
    userId: string,
    relationshipType: string,
    inserted: Array<{ relationship_id: string; from_entity_id: string; to_entity_id: string }>,
  ): Promise<void> {
    if (inserted.length === 0) {
      return;
    }

    await this.graphDeltaWriter.recordMany(
      inserted.map((row) => ({
        nodeType: 'relationship' as const,
        changeType: 'created' as const,
        relationshipId: row.relationship_id,
        relationshipType,
        fromEntityId: row.from_entity_id,
        toEntityId: row.to_entity_id,
        ownerUserId: userId,
        changeSource: 'DerivedRelationshipService',
        changeReason: relationshipType,
      })),
      manager,
    );
  }
}
