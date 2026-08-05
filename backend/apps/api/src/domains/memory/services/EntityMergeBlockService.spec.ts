import { BadRequestException } from '@nestjs/common';

import type { UserServiceContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';

import type { EntityMergeBlockEntity } from '../entities/EntityMergeBlockEntity';
import { pairKey } from '../entities/EntityMergeBlockEntity';

import { EntityMergeBlockService } from './EntityMergeBlockService';

const USER = 'user-1';
const CONTEXT = { userId: USER } as UserServiceContext;

// Deliberately NOT in sorted order, so a test that passes them in this order is
// actually exercising the ordering rule rather than agreeing with it by luck.
const A = 'ccc';
const B = 'aaa';
const C = 'bbb';

function makeService(stored: Array<Partial<EntityMergeBlockEntity>> = []) {
  const inserted: Array<Partial<EntityMergeBlockEntity>> = [];

  const qb = {
    insert: () => qb,
    into: () => qb,
    values: (rows: Array<Partial<EntityMergeBlockEntity>>) => {
      inserted.push(...rows);

      return qb;
    },
    orIgnore: () => qb,
    execute: async () => ({ identifiers: inserted.map(() => ({})) }),
  };

  const repository = {
    create: (row: Partial<EntityMergeBlockEntity>) => ({ ...row }),
    createQueryBuilder: () => qb,
    find: async () => stored,
  };

  const logger = { setContext() {}, log() {}, warn() {} } as unknown as LoggerService;

  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    service: new EntityMergeBlockService(repository as any, logger),
    inserted,
  };
}

describe('EntityMergeBlockService.blockAllPairs', () => {
  it('records every pair in the group, because the group is what was offered', () => {
    // The review UI merges a group WHOLE, so rejecting it rejects each pairing
    // it contained — three people means three pairs, not one.
    const { service, inserted } = makeService();

    return service.blockAllPairs(CONTEXT, [A, B, C], 'user_rejected').then(() => {
      expect(inserted).toHaveLength(3);
      expect(new Set(inserted.map((row) => `${row.entityIdA}|${row.entityIdB}`))).toEqual(
        new Set([pairKey(A, B), pairKey(A, C), pairKey(B, C)]),
      );
    });
  });

  it('stores each pair in a canonical order, so direction cannot duplicate it', async () => {
    const { service, inserted } = makeService();

    await service.blockAllPairs(CONTEXT, [A, B], 'user_rejected');

    // A = 'ccc', B = 'aaa' — passed high-then-low and stored low-then-high.
    expect(inserted[0]).toMatchObject({ entityIdA: B, entityIdB: A, reason: 'user_rejected' });
  });

  it('collapses a repeated id rather than blocking something against itself', async () => {
    const { service, inserted } = makeService();

    await service.blockAllPairs(CONTEXT, [A, B, A], 'user_rejected');

    expect(inserted).toHaveLength(1);
  });

  it('refuses a group that names fewer than two distinct entities', async () => {
    const { service } = makeService();

    await expect(service.blockAllPairs(CONTEXT, [A], 'user_rejected')).rejects.toThrow(
      BadRequestException,
    );
    await expect(service.blockAllPairs(CONTEXT, [A, A], 'user_rejected')).rejects.toThrow(
      BadRequestException,
    );
  });
});

describe('EntityMergeBlockService.blockedPairsAmong', () => {
  it('returns the blocked pairs as canonical keys', async () => {
    const { service } = makeService([{ entityIdA: B, entityIdB: A }]);

    const blocked = await service.blockedPairsAmong(CONTEXT, [A, B, C]);

    expect(blocked.has(pairKey(A, B))).toBe(true);
    // Lookup is direction-agnostic because both sides go through pairKey.
    expect(blocked.has(pairKey(B, A))).toBe(true);
    expect(blocked.has(pairKey(A, C))).toBe(false);
  });

  it('ignores a row whose other endpoint is outside the candidate set', async () => {
    // The owner-scoped query matches on EITHER column, so it can return a block
    // against an entity this sweep never mentioned; that is not a pair here.
    const { service } = makeService([{ entityIdA: A, entityIdB: 'zzz-elsewhere' }]);

    expect(await service.blockedPairsAmong(CONTEXT, [A, B])).toEqual(new Set());
  });

  it('does not query for fewer than two candidates', async () => {
    const { service } = makeService([{ entityIdA: B, entityIdB: A }]);

    expect(await service.blockedPairsAmong(CONTEXT, [A])).toEqual(new Set());
    expect(await service.blockedPairsAmong(CONTEXT, [])).toEqual(new Set());
  });
});
