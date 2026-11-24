import { IsNull } from 'typeorm';

import type { ServiceContext, UserServiceContext } from '@ci/common/context';

import { ItemService } from './ItemService';

const USER = '00000000-0000-0000-0000-0000000000aa';
const ITEM_A = '00000000-0000-0000-0000-0000000000b1';
const ITEM_B = '00000000-0000-0000-0000-0000000000b2';
const ITEM_C = '00000000-0000-0000-0000-0000000000b3';

const CONTEXT: ServiceContext = { userId: USER } as ServiceContext;

interface Row {
  id: string;
  createdAt: Date;
  /** What Postgres formats `created_at` as: the microseconds the `Date` above has lost. */
  exact?: string;
}

/** The text Postgres would format for a row that has no sub-millisecond part. */
const exactOf = (row: Row): string => row.exact ?? row.createdAt.toISOString().replace('Z', '000Z');

/**
 * Records every predicate the keyset query builder was handed. `findPage` is
 * pure SQL construction plus one `getRawAndEntities`, so a recording builder
 * covers the whole method without a database.
 */
function makeHarness(rows: Row[] = [], raw?: Array<Record<string, unknown>>) {
  const wheres: Array<{ sql: string; params?: Record<string, unknown> }> = [];
  const orders: Array<[string, string]> = [];
  const selects: Array<[string, string]> = [];
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
  qb.addSelect = (sql: string, alias: string) => {
    selects.push([sql, alias]);

    return qb;
  };

  qb.getMany = async () => rows;
  qb.getRawAndEntities = async () => ({
    entities: rows,
    raw: raw ?? rows.map((row) => ({ position_id: row.id, position_created_at: exactOf(row) })),
  });
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

  return { service, wheres, orders, selects, find, getLimit: () => limit };
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
    const after = '2026-03-02T10:00:00.123456Z';

    await harness.service.findPage(CONTEXT, {}, { afterCreatedAt: after, afterId: ITEM_A });

    const seek = harness.wheres.find(({ sql }) => sql.includes('afterCreatedAt'));
    // created_at alone drops every row sharing the cursor's timestamp, which on
    // a bulk import is most of the page.
    //
    // A row-value comparison, and not `created_at < :c OR (created_at = :c AND
    // object_id < :id)`: it is the form the planner turns into an index condition
    // on objects_live_keyset_idx. The OR walked the user's index from the newest
    // row and filtered everything newer than the cursor, on every page.
    expect(seek?.sql).toBe('(item.created_at, item.object_id) < (:afterCreatedAt, :afterId)');
  });

  it("binds the cursor's instant as the text it arrived as, microseconds and all", async () => {
    const harness = makeHarness();
    const after = '2026-03-02T10:00:00.123456Z';

    await harness.service.findPage(CONTEXT, {}, { afterCreatedAt: after, afterId: ITEM_A });

    const seek = harness.wheres.find(({ sql }) => sql.includes('afterCreatedAt'));
    // A `Date` here would be milliseconds: `.123456` bound as `.123` sorts the cursor row before itself,
    // and `created_at = .123` matches no row stamped to the microsecond.
    expect(seek?.params).toEqual({ afterCreatedAt: after, afterId: ITEM_A });
    expect(typeof seek?.params?.afterCreatedAt).toBe('string');
  });

  it('ignores a half-supplied cursor rather than paging wrongly', async () => {
    const harness = makeHarness();

    await harness.service.findPage(
      CONTEXT,
      {},
      { afterCreatedAt: '2026-03-02T10:00:00.123456Z', afterId: null },
    );

    expect(harness.wheres.some(({ sql }) => sql.includes('afterCreatedAt'))).toBe(false);
  });

  it("reads each row's created_at as text, to the microsecond, in UTC", async () => {
    const harness = makeHarness();

    await harness.service.findPage(CONTEXT);

    // The driver would hand the entity's `created_at` back as a Date, which is milliseconds. The format
    // is fixed-width and zone-independent, so it is the same text whatever the session's TimeZone and
    // DateStyle, and `decodeItemCursor` can hold it to one shape.
    expect(harness.selects).toEqual([
      ['item.object_id', 'position_id'],
      [`to_char(item.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`, 'position_created_at'],
    ]);
  });

  it('caps the page size and fetches one sentinel row past it', async () => {
    const harness = makeHarness();

    await harness.service.findPage(CONTEXT, {}, { limit: 100000 });

    expect(harness.getLimit()).toBe(201);
  });

  it('reports hasMore and a cursor only when the sentinel row came back', async () => {
    const rows = [
      { id: ITEM_A, createdAt: new Date('2026-03-02T10:00:00.123Z'), exact: '2026-03-02T10:00:00.123456Z' },
      { id: ITEM_B, createdAt: new Date('2026-03-01T10:00:00Z') },
    ];

    const full = makeHarness(rows);
    const page = await full.service.findPage(CONTEXT, {}, { limit: 1 });
    expect(page.hasMore).toBe(true);
    // The cursor is the row's position as the database spelled it, not the entity's truncated Date.
    expect(page.nextCursor).toEqual({ createdAt: '2026-03-02T10:00:00.123456Z', id: ITEM_A });

    const last = makeHarness([rows[0]]);
    const lastPage = await last.service.findPage(CONTEXT, {}, { limit: 1 });
    expect(lastPage.hasMore).toBe(false);
    expect(lastPage.nextCursor).toBeNull();
  });

  it('reports a position for every row of the page, and none for the sentinel', async () => {
    const rows = [
      { id: ITEM_A, createdAt: new Date('2026-03-02T10:00:00.123Z'), exact: '2026-03-02T10:00:00.123456Z' },
      { id: ITEM_B, createdAt: new Date('2026-03-01T10:00:00Z') },
      { id: ITEM_C, createdAt: new Date('2026-02-28T10:00:00Z') },
    ];
    const harness = makeHarness(rows);

    const page = await harness.service.findPage(CONTEXT, {}, { limit: 2 });

    expect(page.items).toHaveLength(2);
    expect(page.hasMore).toBe(true);
    // The cursor resumes after the LAST row served, not the first: with one row to a page they coincide.
    expect(page.nextCursor).toEqual({ createdAt: '2026-03-01T10:00:00.000000Z', id: ITEM_B });
    expect(page.positions).toEqual([
      { createdAt: '2026-03-02T10:00:00.123456Z', id: ITEM_A },
      { createdAt: '2026-03-01T10:00:00.000000Z', id: ITEM_B },
    ]);
  });

  it('matches positions to rows by key, whatever order the raw rows come back in', async () => {
    const rows = [
      { id: ITEM_A, createdAt: new Date('2026-03-02T10:00:00.123Z') },
      { id: ITEM_B, createdAt: new Date('2026-03-01T10:00:00Z') },
    ];
    const raw = [
      { position_id: ITEM_B, position_created_at: '2026-03-01T10:00:00.000009Z' },
      { position_id: ITEM_A, position_created_at: '2026-03-02T10:00:00.123456Z' },
    ];
    const harness = makeHarness(rows, raw);

    const page = await harness.service.findPage(CONTEXT, {}, { limit: 5 });

    expect(page.positions).toEqual([
      { createdAt: '2026-03-02T10:00:00.123456Z', id: ITEM_A },
      { createdAt: '2026-03-01T10:00:00.000009Z', id: ITEM_B },
    ]);
  });

  it('refuses a row with no created_at rather than minting a cursor from nothing', async () => {
    const harness = makeHarness(
      [{ id: ITEM_A, createdAt: new Date('2026-03-02T10:00:00Z') }],
      [{ position_id: ITEM_A, position_created_at: null }],
    );

    await expect(harness.service.findPage(CONTEXT)).rejects.toThrow(/no created_at/);
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
