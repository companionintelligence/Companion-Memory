import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';

import { pairKey } from '../entities/EntityMergeBlockEntity';
import { type Person, PersonEntity } from '../entities/PersonEntity';

import { EntityMergeBlockService } from './EntityMergeBlockService';

export type DuplicateReason = 'email' | 'phone' | 'name';

export interface PersonDuplicateGroup {
  reason: DuplicateReason;
  /** The shared normalized value the group collapsed on. */
  value: string;
  people: Person[];
}

/** Max people surfaced per group — a huge group is a junk value, not a dupe. */
const MAX_GROUP_SIZE = 6;

/**
 * Remove members until no rejected pair remains in the group.
 *
 * The review UI merges a group WHOLE — pick a target, everything else folds
 * into it — so a group containing one rejected pair proposes that rejection
 * again as part of a bigger action. Members are kept greedily in rank order:
 * each is admitted only if it is unblocked against everyone already admitted.
 *
 * For the ordinary two-person group this is simply "drop it". For a larger one
 * it keeps the part of the suggestion the user never rejected — {A,B,C} with
 * (A,B) blocked still offers {A,C} — rather than throwing away a live
 * suggestion because a different pairing inside it was declined.
 */
function dropBlocked(people: Person[], blocked: Set<string>): Person[] {
  if (blocked.size === 0) {
    return people;
  }

  const kept: Person[] = [];

  for (const person of people) {
    if (kept.every((other) => !blocked.has(pairKey(person.id, other.id)))) {
      kept.push(person);
    }
  }

  return kept;
}

/**
 * Duplicate-person candidate detection for the merge review UI.
 *
 * ci.entity_identifiers can't surface duplicates — a (kind, value) tuple maps
 * to exactly ONE entity (first-writer-wins), so the duplicate's claim was
 * silently dropped at ingest. The asserted identifiers DO survive in each
 * entity's properties (emails[] / phones[]), so candidates are found by
 * unnesting those arrays across all live Persons and grouping on the shared
 * normalization rule (email = trim+lowercase; phone = last 10 digits — the
 * same contract as normalizeIdentifier.ts). Exact normalized display-name
 * matches are included as a weaker third signal (communications stubs created
 * from a bare display name have no email/phone to match on).
 *
 * Suggestions only — merging stays a user decision (LifeScope's correct
 * instinct), executed by PersonMergeService.
 */
@Injectable()
export class PersonDuplicateService {
  constructor(
    @InjectRepository(PersonEntity)
    private readonly personRepository: Repository<PersonEntity>,
    private readonly mergeBlockService: EntityMergeBlockService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(PersonDuplicateService.name);
  }

  async findDuplicateGroups(
    context: UserServiceContext,
    options: { limit?: number } = {},
  ): Promise<PersonDuplicateGroup[]> {
    const limit = Math.min(Math.max(options.limit ?? 25, 1), 100);

    const rows: Array<{ kind: DuplicateReason; val: string; entity_ids: string[] }> =
      await this.personRepository.manager.query(
        `WITH people AS (
           SELECT entity_id, name, properties
             FROM ci.entities
            WHERE owner_user_id = $1
              AND entity_type = 'Person'
              AND is_active IS DISTINCT FROM FALSE
              AND merged_into_entity_id IS NULL
         ),
         keys AS (
           SELECT p.entity_id, 'email'::text AS kind, lower(btrim(v)) AS val
             FROM people p,
                  LATERAL jsonb_array_elements_text(
                    CASE WHEN jsonb_typeof(p.properties->'emails') = 'array'
                         THEN p.properties->'emails' ELSE '[]'::jsonb END) AS v
            WHERE btrim(v) <> ''
           UNION ALL
           SELECT p.entity_id, 'phone', right(regexp_replace(v, '\\D', '', 'g'), 10)
             FROM people p,
                  LATERAL jsonb_array_elements_text(
                    CASE WHEN jsonb_typeof(p.properties->'phones') = 'array'
                         THEN p.properties->'phones' ELSE '[]'::jsonb END) AS v
            WHERE length(regexp_replace(v, '\\D', '', 'g')) >= 7
           UNION ALL
           SELECT p.entity_id, 'name', lower(btrim(regexp_replace(p.name, '\\s+', ' ', 'g')))
             FROM people p
            WHERE p.name IS NOT NULL AND length(btrim(p.name)) >= 3
         )
         SELECT kind, val,
                (array_agg(DISTINCT entity_id))[1:$3] AS entity_ids,
                COUNT(DISTINCT entity_id) AS n
           FROM keys
          GROUP BY kind, val
         HAVING COUNT(DISTINCT entity_id) > 1
            AND NOT (kind = 'name' AND COUNT(DISTINCT entity_id) > $3)
          ORDER BY CASE kind WHEN 'email' THEN 0 WHEN 'phone' THEN 1 ELSE 2 END,
                   COUNT(DISTINCT entity_id) DESC,
                   val ASC
          LIMIT $2`,
        [context.userId, limit, MAX_GROUP_SIZE],
      );

    if (rows.length === 0) {
      return [];
    }

    const allIds = [...new Set(rows.flatMap((row) => row.entity_ids))];
    const entities = await this.personRepository
      .createQueryBuilder('person')
      .where('person.owner_user_id = :userId', { userId: context.userId })
      .andWhere('person.entity_id IN (:...ids)', { ids: allIds })
      .getMany();

    const byId = new Map(entities.map((entity) => [entity.id, PersonEntity.toEgressType(entity)]));

    // Pairs the user has already said are NOT the same person. Fetched once for
    // the whole sweep rather than per group.
    const blocked = await this.mergeBlockService.blockedPairsAmong(context, allIds);

    const groups: PersonDuplicateGroup[] = [];
    // A pair that shares an email usually shares the name too; suppress
    // strictly-weaker groups that add no new members over an earlier one.
    const seenMemberSets = new Set<string>();

    for (const row of rows) {
      const people = dropBlocked(
        row.entity_ids.map((id) => byId.get(id)).filter((person): person is Person => person != null),
        blocked,
      );

      if (people.length < 2) {
        continue;
      }

      const memberKey = people
        .map((person) => person.id)
        .sort()
        .join(',');
      if (seenMemberSets.has(memberKey)) {
        continue;
      }

      seenMemberSets.add(memberKey);

      groups.push({ reason: row.kind, value: row.val, people });
    }

    return groups;
  }
}
