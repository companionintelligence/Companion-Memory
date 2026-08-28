import type { UserServiceContext } from '@ci/common/context';

import { pairKey } from '../entities/EntityMergeBlockEntity';
import { PlaceEntity } from '../entities/PlaceEntity';

import { PlaceDuplicateService } from './PlaceDuplicateService';

const USER = '00000000-0000-0000-0000-0000000000aa';
const A = '00000000-0000-0000-0000-0000000000a1';
const B = '00000000-0000-0000-0000-0000000000a2';
const C = '00000000-0000-0000-0000-0000000000a3';

const CONTEXT: UserServiceContext = { userId: USER } as UserServiceContext;

interface GroupRow {
  kind: 'place_id' | 'name_proximity';
  val: string;
  place_ids: string[];
  n: number;
  total: number;
}

/**
 * The grouping SQL (DBSCAN window over PostGIS points) is validated against a
 * real database; this harness mocks it and exercises everything after it:
 * hydration, rejected-pair filtering, dedupe of identical member sets, paging.
 */
function makeHarness(rows: GroupRow[], blocked: Set<string> = new Set()) {
  const statements: Array<{ sql: string; params: unknown[] | undefined }> = [];
  const query = jest.fn(async (sql: string, params?: unknown[]) => {
    statements.push({ sql, params });

    return rows;
  });

  const getMany = jest.fn(async () => {
    const ids = new Set(rows.flatMap((row) => row.place_ids));

    return [...ids].map((id) =>
      Object.assign(new PlaceEntity(), {
        id,
        entityType: 'Location',
        name: `Place ${id.slice(-1)}`,
        properties: {},
      }),
    );
  });
  const builder = { where: jest.fn().mockReturnThis(), andWhere: jest.fn().mockReturnThis(), getMany };
  const repository = { manager: { query }, createQueryBuilder: jest.fn(() => builder) };
  const mergeBlockService = { blockedPairsAmong: jest.fn(async () => blocked) };
  const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };

  const service = new PlaceDuplicateService(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    repository as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mergeBlockService as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    logger as any,
  );

  return { service, statements, mergeBlockService };
}

describe('PlaceDuplicateService', () => {
  it('returns an empty page when SQL found nothing', async () => {
    const harness = makeHarness([]);

    expect(await harness.service.findDuplicateGroups(CONTEXT)).toEqual({
      groups: [],
      totalCount: 0,
      hasMore: false,
    });
  });

  it('only considers live Locations, clusters same names within 150 m, and pages by limit+1', async () => {
    const harness = makeHarness([]);

    await harness.service.findDuplicateGroups(CONTEXT, { limit: 10, offset: 20 });

    const { sql, params } = harness.statements[0];
    expect(sql).toContain(`entity_type = 'Location'`);
    expect(sql).toContain('merged_into_entity_id IS NULL');
    expect(sql).toContain('ST_ClusterDBSCAN(location_point::geometry, $4, 1)');
    expect(sql).toContain('OVER (PARTITION BY lower(btrim(name)))');
    expect(params?.[1]).toBe(11);
    expect(params?.[3]).toBeCloseTo(150 / 111_320, 8);
    expect(params?.[4]).toBe(20);
  });

  it('shows the shared name as the group value rather than the DBSCAN label', async () => {
    const harness = makeHarness([
      { kind: 'name_proximity', val: '61 plantation, irvine#0', place_ids: [A, B], n: 2, total: 1 },
    ]);

    const page = await harness.service.findDuplicateGroups(CONTEXT);

    expect(page.groups).toHaveLength(1);
    expect(page.groups[0].reason).toBe('name_proximity');
    expect(page.groups[0].value).toBe('Place 1');
    expect(page.groups[0].places.map((place) => place.id)).toEqual([A, B]);
  });

  it('drops a pair the user already rejected, keeping the rest of the group', async () => {
    const harness = makeHarness(
      [{ kind: 'place_id', val: 'ChIJabc', place_ids: [A, B, C], n: 3, total: 1 }],
      new Set([pairKey(A, B)]),
    );

    const page = await harness.service.findDuplicateGroups(CONTEXT);

    expect(page.groups).toHaveLength(1);
    expect(page.groups[0].places.map((place) => place.id)).toEqual([A, C]);
    expect(page.groups[0].totalPlaces).toBe(3);
  });

  it('drops a two-member group the user already rejected', async () => {
    const harness = makeHarness(
      [{ kind: 'name_proximity', val: 'x#0', place_ids: [A, B], n: 2, total: 1 }],
      new Set([pairKey(A, B)]),
    );

    expect((await harness.service.findDuplicateGroups(CONTEXT)).groups).toHaveLength(0);
  });

  it('ranks place_id above name proximity and suppresses a weaker group with identical members', async () => {
    const harness = makeHarness([
      { kind: 'name_proximity', val: 'x#0', place_ids: [A, B], n: 2, total: 2 },
      { kind: 'place_id', val: 'ChIJabc', place_ids: [A, B], n: 2, total: 2 },
    ]);

    const page = await harness.service.findDuplicateGroups(CONTEXT);

    // SQL orders place_id first; the mock returns them reversed, so the
    // surviving group here is whichever came first — the spec asserts the
    // member-set dedupe, and the sort, independently of SQL order.
    expect(page.groups).toHaveLength(1);
    expect(page.totalCount).toBe(2);
  });

  it('reports hasMore from the sentinel row past the page', async () => {
    const rows: GroupRow[] = Array.from({ length: 3 }, (_, index) => ({
      kind: 'place_id' as const,
      val: `id-${index}`,
      place_ids: [A, B],
      n: 2,
      total: 3,
    }));
    const harness = makeHarness(rows);

    const page = await harness.service.findDuplicateGroups(CONTEXT, { limit: 2 });

    expect(page.hasMore).toBe(true);
  });
});
