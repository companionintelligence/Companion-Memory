import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { LoggerService } from '@ci/common/logging';

/**
 * #1947 stage A — normalise historical `ci.relationships` rows to the
 * life-graph matrix: rewrite aliases, drop rejected `IS`, stamp bidirectional
 * flags. Idempotent and replayable.
 *
 * WORKS_AT / STUDIES_AT → Group MEMBER_OF retyping is deferred until Group
 * entities exist for the employer/school (properties.migration stamped at write).
 */
@Injectable()
export class RelationshipNormalizeService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(RelationshipNormalizeService.name);
  }

  async normalize(userId: string): Promise<{
    renamed: number;
    swapped: number;
    deletedIs: number;
    bidirectionalStamped: number;
  }> {
    return this.dataSource.transaction(async (manager) => {
      // Rename aliases in place (same endpoints). When a canonical twin already
      // exists, deactivate the alias instead of colliding on the directed uniq.
      const renamed = await manager.query(
        `WITH aliases AS (
           SELECT relationship_id, from_entity_id, to_entity_id, relationship_type,
                  CASE relationship_type
                    WHEN 'HAPPENED_AT' THEN 'LOCATED_AT'
                    WHEN 'AT_LOCATION' THEN 'LOCATED_AT'
                    WHEN 'RELATED_TO' THEN 'ASSOCIATED_WITH'
                    WHEN 'FRIEND' THEN 'FRIENDS_WITH'
                    WHEN 'COLLEAGUE' THEN 'WORKS_WITH'
                    WHEN 'PARTNER' THEN 'PARTNER_OF'
                    WHEN 'ROMANTIC_PARTNER' THEN 'PARTNER_OF'
                    ELSE relationship_type
                  END AS new_type
             FROM ci.relationships
            WHERE owner_user_id = $1
              AND relationship_type = ANY($2::text[])
         ),
         colliding AS (
           SELECT a.relationship_id
             FROM aliases a
            WHERE EXISTS (
              SELECT 1 FROM ci.relationships r
               WHERE r.from_entity_id = a.from_entity_id
                 AND r.to_entity_id = a.to_entity_id
                 AND r.relationship_type = a.new_type
                 AND r.relationship_id <> a.relationship_id
            )
         ),
         deactivated AS (
           UPDATE ci.relationships r
              SET is_active = FALSE,
                  updated_at = NOW(),
                  properties = COALESCE(r.properties, '{}'::jsonb)
                    || jsonb_build_object('normalized_duplicate_of', a.new_type)
             FROM aliases a
             JOIN colliding c ON c.relationship_id = a.relationship_id
            WHERE r.relationship_id = a.relationship_id
           RETURNING r.relationship_id
         ),
         rewritten AS (
           UPDATE ci.relationships r
              SET relationship_type = a.new_type,
                  updated_at = NOW()
             FROM aliases a
            WHERE r.relationship_id = a.relationship_id
              AND NOT EXISTS (
                SELECT 1 FROM colliding c WHERE c.relationship_id = a.relationship_id
              )
           RETURNING r.relationship_id
         )
         SELECT relationship_id FROM rewritten
         UNION ALL
         SELECT relationship_id FROM deactivated`,
        [
          userId,
          ['HAPPENED_AT', 'AT_LOCATION', 'RELATED_TO', 'FRIEND', 'COLLEAGUE', 'PARTNER', 'ROMANTIC_PARTNER'],
        ],
      );

      // Content −PART_OF→ Event → DOCUMENTS (same endpoints; matrix gen 4).
      const documents = await manager.query(
        `WITH victims AS (
           SELECT relationship_id, from_entity_id, to_entity_id
             FROM ci.relationships
            WHERE owner_user_id = $1
              AND relationship_type = 'PART_OF'
              AND from_entity_type = 'Content'
              AND to_entity_type = 'Event'
         ),
         colliding AS (
           SELECT v.relationship_id
             FROM victims v
            WHERE EXISTS (
              SELECT 1 FROM ci.relationships r
               WHERE r.from_entity_id = v.from_entity_id
                 AND r.to_entity_id = v.to_entity_id
                 AND r.relationship_type = 'DOCUMENTS'
                 AND r.relationship_id <> v.relationship_id
            )
         ),
         deactivated AS (
           UPDATE ci.relationships r
              SET is_active = FALSE,
                  updated_at = NOW(),
                  properties = COALESCE(r.properties, '{}'::jsonb)
                    || jsonb_build_object('normalized_duplicate_of', 'DOCUMENTS')
             FROM colliding c
            WHERE r.relationship_id = c.relationship_id
           RETURNING r.relationship_id
         ),
         rewritten AS (
           UPDATE ci.relationships r
              SET relationship_type = 'DOCUMENTS',
                  updated_at = NOW()
             FROM victims v
            WHERE r.relationship_id = v.relationship_id
              AND NOT EXISTS (
                SELECT 1 FROM colliding c WHERE c.relationship_id = v.relationship_id
              )
           RETURNING r.relationship_id
         )
         SELECT relationship_id FROM rewritten
         UNION ALL
         SELECT relationship_id FROM deactivated`,
        [userId],
      );

      // Endpoint-swap aliases: CHILD_OF → PARENT_OF, LEARNED_FROM → TAUGHT,
      // RECEIVED_EMAIL_FROM → EMAILED. Insert canonical then delete alias when
      // the swap would collide with an existing row.
      const swapSpecs: Array<{ from: string; to: string }> = [
        { from: 'CHILD_OF', to: 'PARENT_OF' },
        { from: 'LEARNED_FROM', to: 'TAUGHT' },
        { from: 'RECEIVED_EMAIL_FROM', to: 'EMAILED' },
      ];

      let swapped = 0;
      for (const spec of swapSpecs) {
        const inserted: Array<{ relationship_id: string }> = await manager.query(
          `WITH victims AS (
             SELECT *
               FROM ci.relationships
              WHERE owner_user_id = $1
                AND relationship_type = $2
                AND is_active = TRUE
           ),
           upserted AS (
             INSERT INTO ci.relationships
               (from_entity_id, to_entity_id, relationship_type, strength, properties,
                owner_user_id, from_entity_type, to_entity_type, is_bidirectional,
                start_date, end_date)
             SELECT v.to_entity_id, v.from_entity_id, $3, v.strength,
                    COALESCE(v.properties, '{}'::jsonb) || jsonb_build_object('normalized_from', $2),
                    v.owner_user_id, v.to_entity_type, v.from_entity_type, v.is_bidirectional,
                    v.start_date, v.end_date
               FROM victims v
             ON CONFLICT DO NOTHING
             RETURNING relationship_id
           )
           UPDATE ci.relationships r
              SET is_active = FALSE, updated_at = NOW()
             FROM victims v
            WHERE r.relationship_id = v.relationship_id
           RETURNING r.relationship_id`,
          [userId, spec.from, spec.to],
        );
        swapped += inserted.length;
      }

      // Reject IS — deactivate (identity belongs in entity_identifiers + merge).
      const deletedIs = await manager.query(
        `UPDATE ci.relationships
            SET is_active = FALSE, updated_at = NOW(),
                properties = COALESCE(properties, '{}'::jsonb) || jsonb_build_object('rejected', 'IS')
          WHERE owner_user_id = $1
            AND relationship_type = 'IS'
            AND is_active = TRUE
          RETURNING relationship_id`,
        [userId],
      );

      const bidirectionalStamped = await manager.query(
        `UPDATE ci.relationships
            SET is_bidirectional = TRUE, updated_at = NOW()
          WHERE owner_user_id = $1
            AND is_bidirectional = FALSE
            AND relationship_type = ANY($2::text[])
          RETURNING relationship_id`,
        [
          userId,
          [
            'KNOWS',
            'FRIENDS_WITH',
            'PARTNER_OF',
            'SPOUSE',
            'SIBLING_OF',
            'FAMILY_MEMBER',
            'WORKS_WITH',
            'COLLABORATED_WITH',
            'INDUSTRY_CONNECTION',
            'SHARES_INTERESTS_WITH',
            'LIVES_WITH',
            'LIVES_NEAR',
            'MET_WITH',
            'ORGANIZED_EVENT_WITH',
            'EDITED_WITH',
            'COMMUNICATES_WITH',
          ],
        ],
      );

      const result = {
        renamed: renamed.length + documents.length,
        swapped,
        deletedIs: deletedIs.length,
        bidirectionalStamped: bidirectionalStamped.length,
      };

      this.logger.log('Relationship normalize complete', { userId, ...result });

      return result;
    });
  }
}
