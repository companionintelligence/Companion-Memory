import type { UserServiceContext } from '@ci/common/context';

import { PersonEntity } from '../entities/PersonEntity';

import {
  decodeMergeCandidateCursor,
  encodeMergeCandidateCursor,
  hasEmailEvidence,
  hasExactPhoneEvidence,
  MergeCandidateService,
} from './MergeCandidateService';

const USER = '00000000-0000-0000-0000-0000000000aa';
const PERSON_A = '00000000-0000-0000-0000-0000000000b1';
const PERSON_B = '00000000-0000-0000-0000-0000000000b2';

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

function candidateRow(overrides: Record<string, unknown> = {}) {
  return {
    merge_candidate_id: '00000000-0000-0000-0000-0000000000c1',
    entity_type: 'Person',
    entity_id_a: PERSON_A,
    entity_id_b: PERSON_B,
    score: 0.85,
    status: 'pending',
    detected_by: 'clean.duplicate_detect',
    detector_version: 1,
    created_at: new Date('2026-08-18T00:00:00.000Z'),
    evidence: [{ kind: 'phone', value: '9145826767', score: 0.85 }],
    ...overrides,
  };
}

function makeService(pageRows: Array<Record<string, unknown>>, entities: PersonEntity[], total = 1) {
  // Call 1 is the page, call 2 the count — the service issues them in that
  // order and nothing else touches the manager.
  const query = jest
    .fn()
    .mockResolvedValueOnce(pageRows)
    .mockResolvedValueOnce([{ total }])
    .mockResolvedValue([]);

  const qb: Record<string, unknown> = {};
  qb.where = jest.fn(() => qb);
  qb.andWhere = jest.fn(() => qb);
  qb.getMany = jest.fn(async () => entities);

  const repository = {
    manager: { query },
    createQueryBuilder: jest.fn(() => qb),
  };

  const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn() };
  const personMerge = { mergePeople: jest.fn().mockResolvedValue({}) };

  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    service: new MergeCandidateService(repository as any, logger as any, personMerge as any),
    query,
    personMerge,
  };
}

describe('MergeCandidateService', () => {
  it('treats email evidence as the auto-merge signal', () => {
    expect(hasEmailEvidence([{ kind: 'email', value: 'dana@x.com', score: 0.95 }])).toBe(true);
    expect(hasEmailEvidence([{ kind: 'phone', value: '9145826767', score: 0.85 }])).toBe(false);
  });

  it('treats E.164-exact phone evidence as deterministic too', () => {
    expect(hasExactPhoneEvidence([{ kind: 'phone', value: '9145826767', score: 0.95 }])).toBe(true);
    expect(hasExactPhoneEvidence([{ kind: 'phone', value: '9145826767', score: 0.85 }])).toBe(false);
  });
  it('hydrates a scored pair with its evidence', async () => {
    const { service } = makeService(
      [candidateRow()],
      [entity(PERSON_A, '+19145826767'), entity(PERSON_B, 'Dana Q')],
      434,
    );

    const page = await service.findCandidates(CONTEXT);

    expect(page.totalCount).toBe(434);
    expect(page.candidates).toHaveLength(1);
    expect(page.candidates[0].score).toBe(0.85);
    expect(page.candidates[0].status).toBe('pending');
    expect(page.candidates[0].evidence).toEqual([{ kind: 'phone', value: '9145826767', score: 0.85 }]);
    expect(page.candidates[0].people.map((person) => person.id)).toEqual([PERSON_A, PERSON_B]);
  });

  it('defaults to the pending queue and asks for one row past the limit', async () => {
    const { service, query } = makeService([], []);

    await service.findCandidates(CONTEXT, { limit: 10 });

    expect(query.mock.calls[0]?.[1]).toEqual([USER, 'Person', 'pending', null, null, 11]);
  });

  it('reports hasNextPage from the extra row without returning it', async () => {
    const { service } = makeService(
      [
        candidateRow(),
        candidateRow({ merge_candidate_id: '00000000-0000-0000-0000-0000000000c2', score: 0.7 }),
      ],
      [entity(PERSON_A, 'A'), entity(PERSON_B, 'B')],
      2,
    );

    const page = await service.findCandidates(CONTEXT, { limit: 1 });

    expect(page.candidates).toHaveLength(1);
    expect(page.hasNextPage).toBe(true);
    expect(decodeMergeCandidateCursor(page.endCursor ?? '')).toEqual({
      score: 0.85,
      id: '00000000-0000-0000-0000-0000000000c1',
    });
  });

  it('passes the decoded cursor into the keyset predicate', async () => {
    const { service, query } = makeService([], []);

    await service.findCandidates(CONTEXT, {
      after: encodeMergeCandidateCursor({ score: 0.6, id: '00000000-0000-0000-0000-0000000000c9' }),
    });

    expect(query.mock.calls[0]?.[1]?.[3]).toBe(0.6);
    expect(query.mock.calls[0]?.[1]?.[4]).toBe('00000000-0000-0000-0000-0000000000c9');
  });

  it('ignores an unparseable cursor rather than failing the query', async () => {
    const { service, query } = makeService([], []);

    await service.findCandidates(CONTEXT, { after: 'not-a-cursor' });

    expect(query.mock.calls[0]?.[1]?.[3]).toBeNull();
  });

  it('drops a pair whose people did not hydrate instead of rendering half of it', async () => {
    const { service } = makeService([candidateRow()], [entity(PERSON_A, 'A')]);

    const page = await service.findCandidates(CONTEXT);

    expect(page.candidates).toHaveLength(0);
  });

  it('parses evidence delivered as a JSON string', async () => {
    const { service } = makeService(
      [candidateRow({ evidence: '[{"kind":"email","value":"dana@x.com","score":0.95}]' })],
      [entity(PERSON_A, 'A'), entity(PERSON_B, 'B')],
    );

    const page = await service.findCandidates(CONTEXT);

    expect(page.candidates[0].evidence).toEqual([{ kind: 'email', value: 'dana@x.com', score: 0.95 }]);
  });

  it('stamps only pending pairs whose BOTH endpoints were decided', async () => {
    const { service, query } = makeService([], []);
    query.mockReset();
    query.mockResolvedValue([{ merge_candidate_id: 'x' }]);

    const resolved = await service.resolvePairs(CONTEXT, [PERSON_A, PERSON_B, PERSON_A], 'accepted');

    expect(resolved).toBe(1);
    const [sql, params] = query.mock.calls[0] ?? [];
    expect(sql).toMatch(/UPDATE ci\.merge_candidates/);
    expect(sql).toMatch(/status = 'pending'/);
    expect(params).toEqual([USER, [PERSON_A, PERSON_B], 'accepted']);
  });

  it('does not issue an update for fewer than two entities', async () => {
    const { service, query } = makeService([], []);
    query.mockReset();

    expect(await service.resolvePairs(CONTEXT, [PERSON_A], 'rejected')).toBe(0);
    expect(query).not.toHaveBeenCalled();
  });

  describe('autoMergePendingEmailPairs', () => {
    it('merges a same-email pair into the self person when they are in it', async () => {
      const { service, query, personMerge } = makeService([], []);
      query.mockReset();
      query
        .mockResolvedValueOnce([{ entity_id: PERSON_B }])
        .mockResolvedValueOnce([{ merge_candidate_id: 'c1', entity_id_a: PERSON_A, entity_id_b: PERSON_B }])
        .mockResolvedValueOnce([{ merge_candidate_id: 'c1' }]);

      const merged = await service.autoMergePendingEmailPairs(CONTEXT);

      expect(merged).toBe(1);
      expect(personMerge.mergePeople).toHaveBeenCalledWith(CONTEXT, [PERSON_A], PERSON_B);
      expect(query.mock.calls[1]?.[0]).toMatch(/evidence @> '\[\{"kind":"email"\}\]'/);
      expect(query.mock.calls[1]?.[0]).toMatch(/value_e164/);
    });

    it('keeps entity_id_a when neither person is self', async () => {
      const { service, query, personMerge } = makeService([], []);
      query.mockReset();
      query
        .mockResolvedValueOnce([{ entity_id: null }])
        .mockResolvedValueOnce([{ merge_candidate_id: 'c1', entity_id_a: PERSON_A, entity_id_b: PERSON_B }])
        .mockResolvedValueOnce([{ merge_candidate_id: 'c1' }]);

      await service.autoMergePendingEmailPairs(CONTEXT);

      expect(personMerge.mergePeople).toHaveBeenCalledWith(CONTEXT, [PERSON_B], PERSON_A);
    });

    it('leaves the pair pending when the merge throws', async () => {
      const { service, query, personMerge } = makeService([], []);
      query.mockReset();
      personMerge.mergePeople.mockRejectedValueOnce(new Error('locked'));
      query
        .mockResolvedValueOnce([{ entity_id: null }])
        .mockResolvedValueOnce([{ merge_candidate_id: 'c1', entity_id_a: PERSON_A, entity_id_b: PERSON_B }]);

      const merged = await service.autoMergePendingEmailPairs(CONTEXT);

      expect(merged).toBe(0);
      expect(query.mock.calls.some((call) => String(call[0]).includes('UPDATE ci.merge_candidates'))).toBe(
        false,
      );
    });
  });
});
