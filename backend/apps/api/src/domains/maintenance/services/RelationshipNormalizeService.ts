import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { LoggerService } from '@ci/common/logging';
import { countAffected } from '@ci/common/persistence';

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
      // Rename aliases in place (same endpoints). relationships_unique_directed_idx
      // allows one ACTIVE row per (from, to, type), so of the aliases that map
      // one pair onto one canonical type (PARTNER and ROMANTIC_PARTNER,
      // HAPPENED_AT and AT_LOCATION) only the oldest is renamed — and none when a
      // row of that type already joins the pair, active or not (an inactive one
      // was retired on purpose; renaming its alias would revive it). The rest are
      // deactivated as duplicates. Renaming both used to abort the normalize.
      //
      // Active rows only, like the swap and IS passes: an inactive row cannot
      // collide, and selecting them re-deactivated (and re-counted) this pass's
      // own duplicates on every replay. Keyed on `is_active`, not on the
      // `normalized_duplicate_of` stamp: createOrUpdateRelationship re-activates
      // a re-asserted row with its properties kept, and a stamped row that is
      // active again has to be folded again, not skipped.
      const renamed = await countAffected(
        manager,
        `WITH aliases AS (
           SELECT relationship_id, from_entity_id, to_entity_id, created_at,
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
              AND is_active = TRUE
         ),
         survivors AS (
           SELECT DISTINCT ON (a.from_entity_id, a.to_entity_id, a.new_type)
                  a.relationship_id, a.new_type
             FROM aliases a
            WHERE NOT EXISTS (
              SELECT 1 FROM ci.relationships r
               WHERE r.from_entity_id = a.from_entity_id
                 AND r.to_entity_id = a.to_entity_id
                 AND r.relationship_type = a.new_type
                 AND r.relationship_id <> a.relationship_id
            )
            ORDER BY a.from_entity_id, a.to_entity_id, a.new_type, a.created_at, a.relationship_id
         ),
         deactivated AS (
           UPDATE ci.relationships r
              SET is_active = FALSE,
                  updated_at = NOW(),
                  properties = COALESCE(r.properties, '{}'::jsonb)
                    || jsonb_build_object('normalized_duplicate_of', a.new_type)
             FROM aliases a
            WHERE r.relationship_id = a.relationship_id
              AND NOT EXISTS (
                SELECT 1 FROM survivors s WHERE s.relationship_id = a.relationship_id
              )
           RETURNING 1
         ),
         rewritten AS (
           UPDATE ci.relationships r
              SET relationship_type = s.new_type,
                  updated_at = NOW()
             FROM survivors s
            WHERE r.relationship_id = s.relationship_id
           RETURNING 1
         )
         SELECT ((SELECT count(*) FROM rewritten) + (SELECT count(*) FROM deactivated))::int AS count`,
        [
          userId,
          ['HAPPENED_AT', 'AT_LOCATION', 'RELATED_TO', 'FRIEND', 'COLLEAGUE', 'PARTNER', 'ROMANTIC_PARTNER'],
        ],
      );

      // Content −PART_OF→ Event → DOCUMENTS (same endpoints; matrix gen 4).
      // Active rows only, as above. There is no survivor to elect: the directed
      // uniq already allows just one active PART_OF per pair.
      const documents = await countAffected(
        manager,
        `WITH victims AS (
           SELECT relationship_id, from_entity_id, to_entity_id
             FROM ci.relationships
            WHERE owner_user_id = $1
              AND relationship_type = 'PART_OF'
              AND from_entity_type = 'Content'
              AND to_entity_type = 'Event'
              AND is_active = TRUE
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
           RETURNING 1
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
           RETURNING 1
         )
         SELECT ((SELECT count(*) FROM rewritten) + (SELECT count(*) FROM deactivated))::int AS count`,
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

      // Every count below is a CTE ending in `SELECT count(*)`, never
      // `.length` of a statement whose OUTER command is UPDATE: TypeORM hands
      // that back as the pair `[rows, rowCount]`, so `swapped`, `deletedIs` and
      // `bidirectionalStamped` used to report 6, 2 and 2 on every run — the
      // replay of an already-normalized graph included.
      let swapped = 0;
      for (const spec of swapSpecs) {
        swapped += await countAffected(
          manager,
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
           ),
           retired AS (
             UPDATE ci.relationships r
                SET is_active = FALSE, updated_at = NOW()
               FROM victims v
              WHERE r.relationship_id = v.relationship_id
             RETURNING 1
           )
           SELECT count(*)::int AS count FROM retired`,
          [userId, spec.from, spec.to],
        );
      }

      // Reject IS — deactivate (identity belongs in entity_identifiers + merge).
      const deletedIs = await countAffected(
        manager,
        `WITH rejected AS (
           UPDATE ci.relationships
              SET is_active = FALSE, updated_at = NOW(),
                  properties = COALESCE(properties, '{}'::jsonb) || jsonb_build_object('rejected', 'IS')
            WHERE owner_user_id = $1
              AND relationship_type = 'IS'
              AND is_active = TRUE
           RETURNING 1
         )
         SELECT count(*)::int AS count FROM rejected`,
        [userId],
      );

      const bidirectionalStamped = await countAffected(
        manager,
        `WITH stamped AS (
           UPDATE ci.relationships
              SET is_bidirectional = TRUE, updated_at = NOW()
            WHERE owner_user_id = $1
              AND is_bidirectional = FALSE
              AND relationship_type = ANY($2::text[])
           RETURNING 1
         )
         SELECT count(*)::int AS count FROM stamped`,
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
        renamed: renamed + documents,
        swapped,
        deletedIs,
        bidirectionalStamped,
      };

      this.logger.log('Relationship normalize complete', { userId, ...result });

      return result;
    });
  }
}
