import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { type UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';

import { EntityMergeBlockEntity, orderPair, pairKey } from '../entities/EntityMergeBlockEntity';

/** Why a pair was declared distinct. */
export type BlockReason = 'user_rejected' | 'unmerged';

/**
 * The record of pairs the user has said are NOT the same thing.
 *
 * Duplicate detection is derived — recomputed from identifiers on every call —
 * so without somewhere to put a rejection, "no, those are two different people"
 * survives exactly until the next page load. This is that somewhere.
 *
 * Entity-agnostic by design: Person is simply the first caller, and the same
 * table serves Location and Object when they get duplicate detection.
 */
@Injectable()
export class EntityMergeBlockService {
  constructor(
    @InjectRepository(EntityMergeBlockEntity)
    private readonly repository: Repository<EntityMergeBlockEntity>,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(EntityMergeBlockService.name);
  }

  /**
   * Record every pair among `entityIds` as distinct.
   *
   * Takes a SET rather than a pair because that is the shape of the decision:
   * the review UI proposes a whole group and merges all of it into one target,
   * so rejecting it rejects every pairing it contained. Two ids is the common
   * case and simply yields one row.
   *
   * Idempotent — re-rejecting the same group is a no-op, not a duplicate row.
   */
  async blockAllPairs(
    context: UserServiceContext,
    entityIds: string[],
    reason: BlockReason,
  ): Promise<number> {
    const unique = [...new Set(entityIds)];

    if (unique.length < 2) {
      throw new BadRequestException('Blocking a merge needs at least two distinct entities');
    }

    const rows: EntityMergeBlockEntity[] = [];
    for (let i = 0; i < unique.length; i++) {
      for (let j = i + 1; j < unique.length; j++) {
        const [entityIdA, entityIdB] = orderPair(unique[i], unique[j]);

        rows.push(
          this.repository.create({
            id: uuidv7(),
            ownerUserId: context.userId,
            entityIdA,
            entityIdB,
            reason,
          }),
        );
      }
    }

    const result = await this.repository
      .createQueryBuilder()
      .insert()
      .into(EntityMergeBlockEntity)
      .values(rows)
      // A pair already rejected stays rejected with its original reason: the
      // first "no" is the one that carries the user's intent, and a later
      // sweep re-asserting it should not rewrite the history.
      .orIgnore()
      .execute();

    this.logger.log('Recorded merge blocks', {
      entities: unique.length,
      pairs: rows.length,
      inserted: result.identifiers.length,
      reason,
    });

    return result.identifiers.length;
  }

  /**
   * The blocked pairs among `entityIds`, as `pairKey` strings.
   *
   * One query for the whole sweep: duplicate detection has all its candidate
   * ids in hand at once, and asking per pair would be N² round-trips for what
   * is a single small IN-list.
   */
  async blockedPairsAmong(context: UserServiceContext, entityIds: string[]): Promise<Set<string>> {
    const unique = [...new Set(entityIds)];

    if (unique.length < 2) {
      return new Set();
    }

    // Both endpoints must be in the candidate set for the row to be relevant;
    // filtering on each column separately and intersecting in memory keeps this
    // to one index-backed query.
    const rows = await this.repository.find({
      where: [
        { ownerUserId: context.userId, entityIdA: In(unique) },
        { ownerUserId: context.userId, entityIdB: In(unique) },
      ],
      select: ['entityIdA', 'entityIdB'],
    });

    const candidates = new Set(unique);

    return new Set(
      rows
        .filter((row) => candidates.has(row.entityIdA) && candidates.has(row.entityIdB))
        .map((row) => pairKey(row.entityIdA, row.entityIdB)),
    );
  }
}
