import { IsNull } from 'typeorm';

import type { ServiceContext, UserServiceContext } from '@ci/common/context';

import { ItemService } from './ItemService';

const USER = '00000000-0000-0000-0000-0000000000aa';
const ITEM_A = '00000000-0000-0000-0000-0000000000b1';
const ITEM_B = '00000000-0000-0000-0000-0000000000b2';

const CONTEXT: ServiceContext = { userId: USER } as ServiceContext;

interface Row {
  id: string;
  createdAt: Date;
}

/**
 * Records every predicate the keyset query builder was handed. `findPage` is
 * pure SQL construction plus one `getMany`, so a recording builder covers the
 * whole method without a database.
 */
function makeHarness(rows: Row[] = []) {
  const wheres: Array<{ sql: string; params?: Record<string, unknown> }> = [];
  const orders: Array<[string, string]> = [];
  let limit = 0;

  const qb: Record<string, unknown> = {};
  qb.where = (sql: string, params?: Record<string, unknown>) => {
    wheres.push({ sql, params });

    return qb;
  };

  qb.andWhere = qb.where;
  qb.orderBy = (col: string, dir: string) => {
    orders.push([col, dir]);

    return qb;
  };

  qb.addOrderBy = qb.orderBy;
  qb.limit = (value: number) => {
    limit = value;

    return qb;
  };

  qb.select = () => qb;
  qb.getMany = async () => rows;
  qb.getRawMany = async () => rows.map(({ id }) => ({ id }));

  const find = jest.fn(async () => []);
  const itemRepository = {
    createQueryBuilder: () => qb,
    find,
    manager: {},
    metadata: { columns: { length: 60 } },
  };
  const itemBaseRepository = { find: jest.fn(async () => []), metadata: { columns: { length: 10 } } };
  const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };

  const service = new ItemService(
    itemRepository as never,
    itemBaseRepository as never,
    logger as never,
    { send: jest.fn(async () => []) } as never,
    { recordMany: jest.fn(async () => undefined) } as never,
  );

  return { service, wheres, orders, find, getLimit: () => limit };
}

describe('ItemService.findPage', () => {
  it('walks the (created_at DESC, object_id DESC) key the live keyset index provides', async () => {
    const harness = makeHarness();

    await harness.service.findPage(CONTEXT);

    expect(harness.orders).toEqual([
      ['item.created_at', 'DESC'],
      ['item.object_id', 'DESC'],
    ]);
  });

  it('carries the tombstone predicate that makes objects_live_keyset_idx applicable', async () => {
    const harness = makeHarness();

    await harness.service.findPage(CONTEXT);

    // The index is partial: WHERE merged_into_object_id IS NULL. Drop the
    // predicate and the planner falls back to objects_user_idx plus a filter.
    expect(harness.wheres[0].sql).toBe('item.merged_into_object_id IS NULL');
  });

  it('seeks on BOTH halves of the cursor', async () => {
    const harness = makeHarness();
    const after = new Date('2026-03-02T10:00:00Z');

    await harness.service.findPage(CONTEXT, {}, { afterCreatedAt: after, afterId: ITEM_A });

    const seek = harness.wheres.find(({ sql }) => sql.includes('afterCreatedAt'));
    // created_at alone drops every row sharing the cursor's timestamp, which on
    // a bulk import is most of the page.
    expect(seek?.sql).toBe(
      '(item.created_at < :afterCreatedAt OR (item.created_at = :afterCreatedAt AND item.object_id < :afterId))',
    );
    expect(seek?.params).toEqual({ afterCreatedAt: after, afterId: ITEM_A });
  });

  it('ignores a half-supplied cursor rather than paging wrongly', async () => {
    const harness = makeHarness();

    await harness.service.findPage(CONTEXT, {}, { afterCreatedAt: new Date(), afterId: null });

    expect(harness.wheres.some(({ sql }) => sql.includes('afterCreatedAt'))).toBe(false);
  });

  it('caps the page size and fetches one sentinel row past it', async () => {
    const harness = makeHarness();

    await harness.service.findPage(CONTEXT, {}, { limit: 100000 });

    expect(harness.getLimit()).toBe(201);
  });

  it('reports hasMore and a cursor only when the sentinel row came back', async () => {
    const rows = [
      { id: ITEM_A, createdAt: new Date('2026-03-02T10:00:00Z') },
      { id: ITEM_B, createdAt: new Date('2026-03-01T10:00:00Z') },
    ];

    const full = makeHarness(rows);
    const page = await full.service.findPage(CONTEXT, {}, { limit: 1 });
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toEqual({ createdAt: rows[0].createdAt, id: ITEM_A });

    const last = makeHarness([rows[0]]);
    const lastPage = await last.service.findPage(CONTEXT, {}, { limit: 1 });
    expect(lastPage.hasMore).toBe(false);
    expect(lastPage.nextCursor).toBeNull();
  });

  it('applies the object-identity filters against real columns', async () => {
    const harness = makeHarness();

    await harness.service.findPage(CONTEXT, {
      productId: 'p1',
      lifecycleState: 'stored',
      brand: ' Sony ',
    });

    const sql = harness.wheres.map(({ sql: text }) => text);
    expect(sql).toContain('item.product_id = :productId');
    expect(sql).toContain('item.lifecycle_state = :lifecycleState');
    // Matches the same lower(btrim(...)) shape the brand indexes use.
    expect(sql).toContain('lower(btrim(item.brand)) = lower(btrim(:brand))');
  });
});

describe('ItemService tombstone filtering', () => {
  it('excludes tombstones from findAll', async () => {
    const harness = makeHarness();

    await harness.service.findAll(CONTEXT);

    expect(harness.find).toHaveBeenCalledWith({
      where: { userId: USER, mergedIntoObjectId: IsNull() },
    });
  });

  it('excludes tombstones from the search/explorer feed', async () => {
    const harness = makeHarness();

    await harness.service.getEntitiesForItems(CONTEXT as UserServiceContext, {});

    expect(harness.wheres.map(({ sql }) => sql)).toContain('item.merged_into_object_id IS NULL');
  });
});

describe('ItemService.search', () => {
  it('is gone — it had no callers and interpolated caller keys into SQL', () => {
    // `search()` built `item.metadata->>'${key}'` straight from a
    // caller-supplied JSONB key. Nothing called it, so it was deleted rather
    // than parameterized.
    expect((ItemService.prototype as unknown as Record<string, unknown>).search).toBeUndefined();
  });
});
