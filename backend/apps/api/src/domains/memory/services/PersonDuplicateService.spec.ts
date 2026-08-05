import type { UserServiceContext } from '@ci/common/context';

import { pairKey } from '../entities/EntityMergeBlockEntity';
import { PersonEntity } from '../entities/PersonEntity';

import { PersonDuplicateService } from './PersonDuplicateService';

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
  groupRows: Array<{ kind: string; val: string; entity_ids: string[] }>,
  entities: PersonEntity[],
  blocked: Set<string> = new Set(),
) {
  const query = jest.fn(async () => groupRows);

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

    const groups = await service.findDuplicateGroups(CONTEXT);

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

    const groups = await service.findDuplicateGroups(CONTEXT);

    expect(groups.map((group) => `${group.reason}:${group.value}`)).toEqual(['email:dana@x.com', 'name:sam']);
  });

  it('drops groups whose members failed to hydrate below two people', async () => {
    const { service } = makeService(
      [{ kind: 'phone', val: '5551234567', entity_ids: [PERSON_A, PERSON_B] }],
      [entity(PERSON_A, 'Dana')],
    );

    const groups = await service.findDuplicateGroups(CONTEXT);

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

    expect(await service.findDuplicateGroups(CONTEXT)).toHaveLength(0);
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

    const groups = await service.findDuplicateGroups(CONTEXT);

    expect(groups).toHaveLength(1);
    expect(groups[0].people.map((person) => person.id)).toEqual([PERSON_A, PERSON_C]);
  });

  it('returns no groups without querying entities when SQL finds none', async () => {
    const { service } = makeService([], []);

    const groups = await service.findDuplicateGroups(CONTEXT);

    expect(groups).toEqual([]);
  });
});
