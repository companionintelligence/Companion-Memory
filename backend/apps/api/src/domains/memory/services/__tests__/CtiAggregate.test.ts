import type { In } from 'typeorm';

import { CtiAggregate } from '../CtiAggregate';

/**
 * `fetchBaseMap` is the read side of the CTI aggregate every detail service
 * (events, content, objects) composes through. A caller that hands it every
 * row it owns — as EventResolver.events() did before it paginated — can push
 * `id IN (...)` past Postgres's bound-parameter ceiling. Verified live: 62,277
 * ids from a real events(first: 3) call, failing as "bind message has 62277
 * parameter formats but 0 parameters" — a driver desync, not a clean rejection.
 */
describe('CtiAggregate.fetchBaseMap', () => {
  function makeAggregate(chunkSizes: number[]) {
    const baseRepository = {
      find: jest.fn(async ({ where }: { where: { id: ReturnType<typeof In> } }) => {
        const ids = (where.id as unknown as { value: string[] }).value;

        chunkSizes.push(ids.length);

        return ids.map((id) => ({ id }));
      }),
    };

    const aggregate = new CtiAggregate({
      detailRepository: {} as never,
      detailEntity: class {} as never,
      baseEntity: class {} as never,
      baseRepository: baseRepository as never,
      linkedTable: 'events',
      scopedWhere: () => ({}) as never,
    });

    return aggregate;
  }

  it('makes one call for a small id list', async () => {
    const chunkSizes: number[] = [];
    const aggregate = makeAggregate(chunkSizes);

    const map = await aggregate.fetchBaseMap(['a', 'b', 'c']);

    expect(chunkSizes).toEqual([3]);
    expect(map.size).toBe(3);
    expect(map.get('b')?.id).toBe('b');
  });

  it('splits an id list larger than the chunk ceiling into multiple bounded calls', async () => {
    const chunkSizes: number[] = [];
    const aggregate = makeAggregate(chunkSizes);
    const ids = Array.from({ length: 23_456 }, (_, i) => `id-${i}`);

    const map = await aggregate.fetchBaseMap(ids);

    // 3 chunks of at most 10,000 each — never one call with all 23,456 ids,
    // which is the shape that overflowed Postgres's bind-parameter limit.
    expect(chunkSizes.length).toBeGreaterThan(1);
    expect(Math.max(...chunkSizes)).toBeLessThanOrEqual(10_000);
    expect(chunkSizes.reduce((a, b) => a + b, 0)).toBe(23_456);

    // Every id still resolves, and none were dropped or duplicated across
    // the chunk boundary.
    expect(map.size).toBe(23_456);
    expect(map.get('id-0')?.id).toBe('id-0');
    expect(map.get('id-23455')?.id).toBe('id-23455');
  });

  it('returns an empty map without querying when given no ids', async () => {
    const chunkSizes: number[] = [];
    const aggregate = makeAggregate(chunkSizes);

    const map = await aggregate.fetchBaseMap([]);

    expect(chunkSizes).toEqual([]);
    expect(map.size).toBe(0);
  });
});

/**
 * `applyUpdate` builds `after` — the merged before/patch state a caller's
 * `base` callback derives its base-row patch from — with a plain
 * `Object.assign`, not a TypeORM write. An untouched field arriving as
 * `key: undefined` (a resolver that always builds its DTO with every optional
 * field present, per #2703/#2713) must not clobber `before`'s real value here:
 * unlike the `repository.update(byId, detailPatch)` call a few lines above,
 * which TypeORM's own UpdateQueryBuilder normalizes by dropping undefined
 * values before building SQL, this line has no such guard of its own, and its
 * result is what a caller's `base` callback reads to build the patch that
 * actually gets persisted to the base row.
 */
describe('CtiAggregate.applyUpdate', () => {
  class Detail {
    id!: string;

    name!: string;

    summary!: string | null;
  }

  class Base {
    id!: string;

    name!: string | null;

    description!: string | null;
  }

  function makeAggregate() {
    const detailRepo = {
      findOne: jest.fn(),
      update: jest.fn().mockResolvedValue(undefined),
    };
    const baseRepo = {
      update: jest.fn().mockResolvedValue(undefined),
    };
    const manager = {
      getRepository: jest.fn((entityClass: unknown) => {
        if (entityClass === Detail) {return detailRepo;}

        if (entityClass === Base) {return baseRepo;}

        throw new Error('unexpected entity class passed to getRepository');
      }),
    };
    const detailRepository = {
      manager: {
        transaction: jest.fn(async (fn: (manager: unknown) => unknown) => fn(manager)),
      },
      metadata: { updateDateColumn: undefined },
    };

    const aggregate = new CtiAggregate({
      detailRepository: detailRepository as never,
      detailEntity: Detail as never,
      baseEntity: Base as never,
      linkedTable: 'items',
      scopedWhere: () => ({}) as never,
    });

    return { aggregate, detailRepo, baseRepo };
  }

  it('does not let an untouched field sent as undefined clobber the before-value a base() callback derives from', async () => {
    const { aggregate, detailRepo, baseRepo } = makeAggregate();

    const before = { id: 'd1', name: 'Old name', summary: 'Real summary' };
    detailRepo.findOne
      .mockResolvedValueOnce(before)
      .mockResolvedValueOnce({ ...before, name: 'New name' });

    const result = await aggregate.applyUpdate({} as never, 'd1', {
      detail: { name: 'New name', summary: undefined },
      base: ((after: typeof before) => ({ description: after.summary })) as never,
    } as never);

    expect(result?.name).toBe('New name');
    // Without withoutUndefined() guarding the `after` merge, `after.summary`
    // would be clobbered to `undefined` by the untouched-field patch, and this
    // would assert `{ description: undefined }` instead of the real value.
    expect(baseRepo.update).toHaveBeenCalledWith({ id: 'd1' }, { description: 'Real summary' });
  });
});
