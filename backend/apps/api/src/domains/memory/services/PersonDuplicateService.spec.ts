import type { UserServiceContext } from '@ci/common/context';
// The graph domain's public barrel, imported by the SPEC only: the service
// cannot import it (graph already imports memory), which is exactly why it
// restates the pattern and why this file pins the two together.
import { PHONE_EXTENSION_PATTERN } from '@ci/domains/graph';

import { pairKey } from '../entities/EntityMergeBlockEntity';
import { PersonEntity } from '../entities/PersonEntity';

import { PHONE_EXTENSION_SQL_PATTERN, PersonDuplicateService } from './PersonDuplicateService';

const USER = '00000000-0000-0000-0000-0000000000aa';
const PERSON_A = '00000000-0000-0000-0000-0000000000b1';
const PERSON_B = '00000000-0000-0000-0000-0000000000b2';
const PERSON_C = '00000000-0000-0000-0000-0000000000b3';

const CONTEXT: UserServiceContext = { userId: USER } as UserServiceContext;

function entity(id: string, name: string): PersonEntity {
  const row = Object.assign(new PersonEntity(), {
    id,
    entityType: 'Person',
    name,
    properties: {},
    isActive: true,
    mergedIntoEntityId: null,
    userId: USER,
  });
  row.loadPropertiesFromJsonb();

  return row;
}

function makeService(
  groupRows: Array<{ kind: string; val: string; entity_ids: string[]; n?: number }>,
  entities: PersonEntity[],
  blocked: Set<string> = new Set(),
) {
  // The service reads `n` (group size before truncation) and `total` (groups
  // matching the filter, from a window function) off every row.
  const rows = groupRows.map((row) => ({
    ...row,
    n: row.n ?? row.entity_ids.length,
    total: groupRows.length,
  }));
  // Typed params so a test can assert on the bind values the service sent.
  const query = jest.fn<Promise<typeof rows>, [string, unknown[]]>(async () => rows);

  const qb: Record<string, unknown> = {};
  qb.where = jest.fn(() => qb);
  qb.andWhere = jest.fn(() => qb);
  qb.getMany = jest.fn(async () => entities);

  const repository = {
    manager: { query },
    createQueryBuilder: jest.fn(() => qb),
  };

  const logger = { setContext: jest.fn(), log: jest.fn() };

  // No pair is blocked unless a test says so — the default is the world before
  // anyone rejected anything.
  const mergeBlocks = { blockedPairsAmong: jest.fn(async () => blocked) };

  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    service: new PersonDuplicateService(repository as any, mergeBlocks as any, logger as any),
    query,
    mergeBlocks,
  };
}

describe('PersonDuplicateService', () => {
  it('returns hydrated groups keyed by shared identifier', async () => {
    const { service } = makeService(
      [{ kind: 'email', val: 'dana@x.com', entity_ids: [PERSON_A, PERSON_B] }],
      [entity(PERSON_A, 'Dana'), entity(PERSON_B, 'Dana Q')],
    );

    const { groups } = await service.findDuplicateGroups(CONTEXT);

    expect(groups).toHaveLength(1);
    expect(groups[0].reason).toBe('email');
    expect(groups[0].value).toBe('dana@x.com');
    expect(groups[0].people.map((person) => person.id)).toEqual([PERSON_A, PERSON_B]);
  });

  it('suppresses strictly-weaker groups with an identical member set', async () => {
    const { service } = makeService(
      [
        { kind: 'email', val: 'dana@x.com', entity_ids: [PERSON_A, PERSON_B] },
        { kind: 'name', val: 'dana', entity_ids: [PERSON_A, PERSON_B] },
        { kind: 'name', val: 'sam', entity_ids: [PERSON_B, PERSON_C] },
      ],
      [entity(PERSON_A, 'Dana'), entity(PERSON_B, 'Dana Q'), entity(PERSON_C, 'Sam')],
    );

    const { groups } = await service.findDuplicateGroups(CONTEXT);

    expect(groups.map((group) => `${group.reason}:${group.value}`)).toEqual(['email:dana@x.com', 'name:sam']);
  });

  it('drops groups whose members failed to hydrate below two people', async () => {
    const { service } = makeService(
      [{ kind: 'phone', val: '5551234567', entity_ids: [PERSON_A, PERSON_B] }],
      [entity(PERSON_A, 'Dana')],
    );

    const { groups } = await service.findDuplicateGroups(CONTEXT);

    expect(groups).toHaveLength(0);
  });

  it('never re-proposes a pair the user has rejected', async () => {
    // Groups are recomputed from identifiers on every call, so the block table
    // is the only thing standing between a rejection and its immediate return.
    const { service } = makeService(
      [{ kind: 'email', val: 'dana@x.com', entity_ids: [PERSON_A, PERSON_B] }],
      [entity(PERSON_A, 'Dana'), entity(PERSON_B, 'Dana Q')],
      new Set([pairKey(PERSON_A, PERSON_B)]),
    );

    expect((await service.findDuplicateGroups(CONTEXT)).groups).toHaveLength(0);
  });

  it('keeps the part of a larger group that was never rejected', async () => {
    // {A,B,C} with (A,B) blocked still offers {A,C}: the UI merges a group
    // whole, so B has to go, but throwing away C's live suggestion because a
    // different pairing was declined would lose real signal.
    const { service } = makeService(
      [{ kind: 'name', val: 'dana', entity_ids: [PERSON_A, PERSON_B, PERSON_C] }],
      [entity(PERSON_A, 'Dana'), entity(PERSON_B, 'Dana Q'), entity(PERSON_C, 'Dana W')],
      new Set([pairKey(PERSON_A, PERSON_B)]),
    );

    const { groups } = await service.findDuplicateGroups(CONTEXT);

    expect(groups).toHaveLength(1);
    expect(groups[0].people.map((person) => person.id)).toEqual([PERSON_A, PERSON_C]);
  });

  it('returns no groups without querying entities when SQL finds none', async () => {
    const { service } = makeService([], []);

    const { groups } = await service.findDuplicateGroups(CONTEXT);

    expect(groups).toEqual([]);
  });

  it('reports the untruncated group size so the UI can disclose the cap', async () => {
    // The 899-strong "Missed call from" group used to be dropped entirely; it is
    // now returned truncated, and `totalPeople` is what makes that honest.
    const { service } = makeService(
      [{ kind: 'name', val: 'missed call from', entity_ids: [PERSON_A, PERSON_B], n: 899 }],
      [entity(PERSON_A, 'Missed call from'), entity(PERSON_B, 'Missed call from')],
    );

    const { groups, totalCount } = await service.findDuplicateGroups(CONTEXT);

    expect(groups[0].totalPeople).toBe(899);
    expect(groups[0].people).toHaveLength(2);
    expect(totalCount).toBe(1);
  });

  it('pages: asks for one row past the limit and reports hasMore without returning it', async () => {
    const { service, query } = makeService(
      [
        { kind: 'email', val: 'a@x.com', entity_ids: [PERSON_A, PERSON_B] },
        { kind: 'email', val: 'b@x.com', entity_ids: [PERSON_B, PERSON_C] },
      ],
      [entity(PERSON_A, 'A'), entity(PERSON_B, 'B'), entity(PERSON_C, 'C')],
    );

    const { groups, hasMore } = await service.findDuplicateGroups(CONTEXT, { limit: 1, offset: 10 });

    expect(query.mock.calls[0]?.[1]).toEqual([USER, 2, 6, null, 10, PHONE_EXTENSION_SQL_PATTERN]);
    expect(groups).toHaveLength(1);
    expect(hasMore).toBe(true);
  });

  it('passes a reason filter through to SQL and rejects nothing when absent', async () => {
    const { service, query } = makeService([], []);

    await service.findDuplicateGroups(CONTEXT, { reasons: ['name', 'name'] });

    expect(query.mock.calls[0]?.[1]?.[3]).toEqual(['name']);
  });

  it('surfaces self-containing groups before other duplicate groups', async () => {
    const self = Object.assign(entity(PERSON_A, 'Me'), { isSelf: true });
    self.loadPropertiesFromJsonb();
    const other = entity(PERSON_B, 'Me Stub');
    const unrelatedA = entity(PERSON_C, 'Sam');
    const unrelatedB = Object.assign(entity('00000000-0000-0000-0000-0000000000b4', 'Sam Q'), {});

    const { service } = makeService(
      [
        { kind: 'name', val: 'sam', entity_ids: [PERSON_C, unrelatedB.id] },
        { kind: 'email', val: 'me@x.com', entity_ids: [PERSON_A, PERSON_B] },
      ],
      [self, other, unrelatedA, unrelatedB],
    );

    const { groups } = await service.findDuplicateGroups(CONTEXT);

    expect(groups[0].people.some((person) => person.isSelf)).toBe(true);
    expect(groups[0].reason).toBe('email');
  });

  it("refuses a phone carrying an extension with the join key's own pattern", async () => {
    // The phone key is a SQL copy of `normalizePhone`. Kept in step with the
    // shared rule by string equality, because the rule's home is a domain this
    // one cannot import without a cycle: a copy that drifted back to "last ten
    // digits of everything" would group two people on the number an office
    // line and its extension run together into.
    expect(PHONE_EXTENSION_SQL_PATTERN).toBe(PHONE_EXTENSION_PATTERN);

    const { service, query } = makeService([], []);

    await service.findDuplicateGroups(CONTEXT);

    const [sql, params] = query.mock.calls[0] ?? [];
    expect(sql).toContain('v !~* $6');
    expect(params?.[5]).toBe(PHONE_EXTENSION_PATTERN);
  });
});
