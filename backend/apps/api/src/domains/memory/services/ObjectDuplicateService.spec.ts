import type { UserServiceContext } from '@ci/common/context';

import { pairKey } from '../entities/EntityMergeBlockEntity';

import { ObjectDuplicateService } from './ObjectDuplicateService';

const USER = '00000000-0000-0000-0000-0000000000aa';
const A = '00000000-0000-0000-0000-0000000000b1';
const B = '00000000-0000-0000-0000-0000000000b2';
const C = '00000000-0000-0000-0000-0000000000b3';

const CONTEXT: UserServiceContext = { userId: USER } as UserServiceContext;

interface GroupRow {
  kind: 'identifier' | 'product_name' | 'brand_model';
  val: string;
  object_ids: string[];
  n: number;
  total: number;
}

function makeHarness(rows: GroupRow[], blocked: string[] = []) {
  const statements: Array<{ sql: string; params: unknown[] }> = [];

  const query = jest.fn(async (sql: string, params: unknown[] = []) => {
    statements.push({ sql, params });

    return rows;
  });

  const loadedIds = new Set(rows.flatMap((row) => row.object_ids));

  const qb: Record<string, unknown> = {};
  qb.innerJoin = () => qb;
  qb.addSelect = () => qb;
  qb.where = () => qb;
  qb.andWhere = () => qb;
  qb.getRawAndEntities = async () => {
    const entities = [...loadedIds].map((id) => ({ id, metadata: {}, composition: {} }));

    return { entities, raw: entities.map((entity) => ({ base_name: `name-${entity.id}` })) };
  };

  const itemRepository = { manager: { query }, createQueryBuilder: () => qb };
  const blockedPairsAmong = jest.fn(async () => new Set(blocked));
  const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };

  const service = new ObjectDuplicateService(
    itemRepository as never,
    { blockedPairsAmong } as never,
    logger as never,
  );

  return { service, statements, blockedPairsAmong };
}

describe('ObjectDuplicateService', () => {
  it('returns an empty page when SQL found nothing', async () => {
    const harness = makeHarness([]);

    expect(await harness.service.findDuplicateGroups(CONTEXT)).toEqual({
      groups: [],
      totalCount: 0,
      hasMore: false,
    });
  });

  it('only considers live, non-tombstoned units', async () => {
    const harness = makeHarness([]);

    await harness.service.findDuplicateGroups(CONTEXT);

    const { sql } = harness.statements[0];
    expect(sql).toContain('inv.merged_into_object_id IS NULL');
    expect(sql).toContain('base.merged_into_entity_id IS NULL');
    expect(sql).toContain('base.is_active IS DISTINCT FROM FALSE');
  });

  it('reads the identifier rung from the raw bag AND the claim table', async () => {
    const harness = makeHarness([]);

    await harness.service.findDuplicateGroups(CONTEXT);

    const { sql } = harness.statements[0];
    // The claim index is first-writer-wins, so the LOSING claim was never
    // inserted — it survives only in ci.objects.identifier_codes.
    expect(sql).toContain('jsonb_each_text');
    expect(sql).toContain("oi.subject_type = 'object_instance'");
  });

  it('groups brand+model only within one acquisition DAY', async () => {
    const harness = makeHarness([]);

    await harness.service.findDuplicateGroups(CONTEXT);

    // Without the date this proposes a merge every time someone legitimately
    // owns two of the same thing.
    expect(harness.statements[0].sql).toContain("to_char(u.acquired_at AT TIME ZONE 'UTC', 'YYYY-MM-DD')");
  });

  it('caps the members SQL returns per group and reports the true total', async () => {
    const harness = makeHarness([
      { kind: 'identifier', val: 'ABC123456', object_ids: [A, B], n: 900, total: 1 },
    ]);

    const page = await harness.service.findDuplicateGroups(CONTEXT);

    // (array_agg(...))[1:$3] truncates in SQL; totalItems keeps the real count
    // so the UI can say "showing 2 of 900" instead of hiding the group.
    expect(harness.statements[0].params[2]).toBe(6);
    expect(page.groups[0].totalItems).toBe(900);
  });

  it('ranks identifier above product+name above brand+model', async () => {
    const harness = makeHarness([
      { kind: 'brand_model', val: 'sony|xm5|2026-03-02', object_ids: [A, B], n: 2, total: 3 },
      { kind: 'identifier', val: 'ABC123456', object_ids: [B, C], n: 2, total: 3 },
      { kind: 'product_name', val: 'p|mug', object_ids: [A, C], n: 2, total: 3 },
    ]);

    const page = await harness.service.findDuplicateGroups(CONTEXT);

    expect(page.groups.map((group) => group.reason)).toEqual(['identifier', 'product_name', 'brand_model']);
  });

  it('suppresses a weaker group that names the same members as a stronger one', async () => {
    const harness = makeHarness([
      { kind: 'identifier', val: 'ABC123456', object_ids: [A, B], n: 2, total: 2 },
      { kind: 'brand_model', val: 'sony|xm5|2026-03-02', object_ids: [A, B], n: 2, total: 2 },
    ]);

    const page = await harness.service.findDuplicateGroups(CONTEXT);

    expect(page.groups).toHaveLength(1);
    // The surviving group is the one that explains the duplicate best.
    expect(page.groups[0].reason).toBe('identifier');
  });

  it('keeps the unrejected part of a group rather than dropping it whole', async () => {
    const harness = makeHarness(
      [{ kind: 'identifier', val: 'ABC123456', object_ids: [A, B, C], n: 3, total: 1 }],
      [pairKey(A, B)],
    );

    const page = await harness.service.findDuplicateGroups(CONTEXT);

    expect(page.groups[0].items.map((item) => item.id)).toEqual([A, C]);
  });

  it('drops a two-member group the user already rejected', async () => {
    const harness = makeHarness(
      [{ kind: 'identifier', val: 'ABC123456', object_ids: [A, B], n: 2, total: 1 }],
      [pairKey(A, B)],
    );

    const page = await harness.service.findDuplicateGroups(CONTEXT);

    expect(page.groups).toEqual([]);
    // totalCount still reports the queue size in SQL, before rejection filtering.
    expect(page.totalCount).toBe(1);
  });

  it('fetches one sentinel group past the page to answer hasMore', async () => {
    const harness = makeHarness([
      { kind: 'identifier', val: 'AAAAAAAA', object_ids: [A, B], n: 2, total: 2 },
      { kind: 'identifier', val: 'BBBBBBBB', object_ids: [B, C], n: 2, total: 2 },
    ]);

    const page = await harness.service.findDuplicateGroups(CONTEXT, { limit: 1 });

    expect(harness.statements[0].params[1]).toBe(2);
    expect(page.hasMore).toBe(true);
    expect(page.groups).toHaveLength(1);
  });

  it('groups on product/unit identifiers only — never on the order id the importer keeps in the same bag', async () => {
    const harness = makeHarness([]);

    await harness.service.findDuplicateGroups(CONTEXT);

    const { sql, params } = harness.statements[0];
    // The raw bag rung is keyed by an allow-list of bag keys...
    expect(sql).toContain('lower(btrim(code.key)) = ANY($7::text[])');
    const bagKeys = params[6] as string[];
    expect(bagKeys).toEqual(expect.arrayContaining(['asin', 'gtin', 'upc', 'isbn', 'serial']));
    expect(bagKeys).not.toContain('order_id');
    expect(bagKeys).not.toContain('quantity');

    // ...and the claim-table rung by an allow-list of namespaces.
    expect(sql).toContain('oi.namespace = ANY($8::text[])');
    const namespaces = params[7] as string[];
    expect(namespaces).toEqual(expect.arrayContaining(['asin', 'gtin', 'serial']));
    expect(namespaces).not.toContain('order_id');
    expect(namespaces).not.toContain('custom');
  });

  it('passes a NULL reason filter when the caller names none', async () => {
    const harness = makeHarness([]);

    await harness.service.findDuplicateGroups(CONTEXT);
    expect(harness.statements[0].params[3]).toBeNull();

    await harness.service.findDuplicateGroups(CONTEXT, { reasons: ['identifier', 'identifier'] });
    expect(harness.statements[1].params[3]).toEqual(['identifier']);
  });

  it('never merges anything — it only proposes', async () => {
    const harness = makeHarness([
      { kind: 'identifier', val: 'ABC123456', object_ids: [A, B], n: 2, total: 1 },
    ]);

    await harness.service.findDuplicateGroups(CONTEXT);

    expect(harness.statements.every(({ sql }) => sql.trimStart().startsWith('WITH'))).toBe(true);
  });
});
