import type { UserServiceContext } from '@ci/common/context';

import { PersonEntity } from '../entities/PersonEntity';
import { PHONE_CLAIM_E164_SQL, PHONE_FACTS_CORPUS_SQL, PHONE_MAX_HOLDERS } from '../utils/phoneIdentity';
import { PROFILE_FACTS_CORPUS_SQL, PROFILE_URL_MAX_HOLDERS } from '../utils/profileUrls';

import {
  chooseMergeTarget,
  decodeMergeCandidateCursor,
  encodeMergeCandidateCursor,
  hasEmailEvidence,
  hasExactPhoneEvidence,
  MergeCandidateService,
  SHARES_DETERMINISTIC_IDENTITY,
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

  it('treats adjudicated exact phone evidence as deterministic too', () => {
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

  describe('chooseMergeTarget', () => {
    const at = (id: string, name: string | null, isSelf = false) => ({ id, name, isSelf });

    it('keeps the self Person', () => {
      expect(chooseMergeTarget(at(PERSON_A, 'Ada Quillfeather'), at(PERSON_B, 'Ada', true))).toBe(PERSON_B);
    });

    it('keeps a real name over a placeholder, even when the placeholder sorts first', () => {
      expect(chooseMergeTarget(at(PERSON_A, '+1 (202) 555-0142'), at(PERSON_B, 'Ada Quill'))).toBe(PERSON_B);
      expect(chooseMergeTarget(at(PERSON_A, 'ada@example.com'), at(PERSON_B, 'Ada'))).toBe(PERSON_B);
      expect(chooseMergeTarget(at(PERSON_A, null), at(PERSON_B, 'Ada'))).toBe(PERSON_B);
      expect(chooseMergeTarget(at(PERSON_A, 'Ada'), at(PERSON_B, '2025550142'))).toBe(PERSON_A);
    });

    it('keeps the fuller name, then entity_id_a', () => {
      expect(chooseMergeTarget(at(PERSON_A, 'Ada'), at(PERSON_B, 'Ada Quill'))).toBe(PERSON_B);
      expect(chooseMergeTarget(at(PERSON_A, 'Ada Quill'), at(PERSON_B, 'Ada Quill'))).toBe(PERSON_A);
    });
  });

  describe('the deterministic predicate', () => {
    /** Index of the paren that closes the one opened at `open`. */
    function closingParen(text: string, open: number): number {
      let depth = 0;

      for (let index = open; index < text.length; index += 1) {
        if (text[index] === '(') {
          depth += 1;
        } else if (text[index] === ')') {
          depth -= 1;

          if (depth === 0) {
            return index;
          }
        }
      }

      return -1;
    }

    it('is one parenthesised expression, so `AND NOT` negates all of it', () => {
      // `NOT a AND NOT b` is not `NOT (a AND NOT b)`. Unwrapped, hiding
      // deterministic pairs would hide every VETOED pair too.
      const predicate = SHARES_DETERMINISTIC_IDENTITY.trim();

      expect(predicate.startsWith('(')).toBe(true);
      expect(closingParen(predicate, 0)).toBe(predicate.length - 1);
    });

    it('adds the exact profile-URL tier and vetoes a partial or conflicting profile', () => {
      expect(SHARES_DETERMINISTIC_IDENTITY).toMatch(/ev->>'kind' = 'profile_url'[\s\S]*>= 0\.95/);
      expect(SHARES_DETERMINISTIC_IDENTITY).toMatch(
        /AND NOT \(\s*mc\.evidence @> '\[\{"kind":"profile_url_conflict"\}\]'/,
      );
      expect(SHARES_DETERMINISTIC_IDENTITY).toContain(`'[{"kind":"profile_url_partial"}]'`);
    });

    it('never has a name clause', () => {
      expect(SHARES_DETERMINISTIC_IDENTITY).not.toMatch(/name_overlap|name_cluster|'name'/);
    });

    it('selects a phone only on the adjudicated exact item, never on a claims E.164 join', () => {
      // Two claims agreeing on an E.164 say nothing about whether their people
      // are one person or a household on one line; that clause folded such
      // pairs with no name guard.
      expect(SHARES_DETERMINISTIC_IDENTITY).toMatch(/ev->>'kind' = 'phone'[\s\S]*>= 0\.95/);
      expect(SHARES_DETERMINISTIC_IDENTITY).not.toMatch(/value_e164/);
    });

    it('shows exact phone pairs for review while their tier is switched off', async () => {
      const { service, query } = makeService([], []);

      await service.findCandidates(CONTEXT, { includePhone: false });

      const sql = String(query.mock.calls[0]?.[0]);
      expect(sql).not.toContain(`ev->>'kind' = 'phone'`);
      expect(sql).toContain(`ev->>'kind' = 'profile_url'`);
      expect(sql).toContain(`'[{"kind":"email"}]'`);
    });

    it('hides deterministic pairs from the pending queue, vetoed ones excepted', async () => {
      const { service, query } = makeService([], []);

      await service.findCandidates(CONTEXT);

      expect(query.mock.calls[0]?.[0]).toContain(`AND NOT ${SHARES_DETERMINISTIC_IDENTITY}`);
    });

    it('shows exact profile-URL pairs for review while their tier is switched off', async () => {
      const { service, query } = makeService([], []);

      await service.findCandidates(CONTEXT, { includeProfileUrl: false });

      const sql = String(query.mock.calls[0]?.[0]);
      expect(sql).not.toContain(`ev->>'kind' = 'profile_url'`);
      expect(sql).toContain('profile_url_conflict');
    });
  });

  describe('autoMergeDeterministicPairs', () => {
    const PERSON_C = '00000000-0000-0000-0000-0000000000b3';
    const ADA_URL = 'https://www.linkedin.com/in/ada-quillfeather-7x2';
    const OTHER_ADA_URL = 'https://www.linkedin.com/in/ada-quillfeather-9m4';
    const BO_URL = 'https://www.linkedin.com/in/bo-quillfeather-3k9';
    /** A recruiter's profile pasted into every candidate's card. Invented. */
    const DESK_URL = 'https://www.linkedin.com/in/acme-recruiter-desk';
    const DESK_KEY = 'linkedin.com/in/acme-recruiter-desk';

    interface Endpoint {
      entity_id: string;
      person_name: string | null;
      profile_props: Record<string, unknown> | null;
      phone_props: Record<string, unknown> | null;
      is_self: boolean;
    }

    function endpoint(
      id: string,
      name: string,
      props: Record<string, unknown> = {},
      isSelf = false,
      phoneProps: Record<string, unknown> = {},
    ): Endpoint {
      return {
        entity_id: id,
        person_name: name,
        profile_props: props,
        phone_props: phoneProps,
        is_self: isSelf,
      };
    }

    function pageRow(overrides: Record<string, unknown> = {}) {
      return {
        merge_candidate_id: '00000000-0000-0000-0000-0000000000c1',
        entity_id_a: PERSON_A,
        entity_id_b: PERSON_B,
        score: 0.95,
        evidence: [{ kind: 'email', value: 'ada@example.com', score: 0.95 }],
        via_email: true,
        via_phone: false,
        ...overrides,
      };
    }

    /**
     * Routes each statement by its text: the self lookup, keyset pages (served
     * in order, then empty), the corpus-wide holder reads, the live-endpoint
     * read, demotions and the accepted-stamp. `endpoints` may be swapped
     * mid-run to model a merge; each corpus read serves every live endpoint
     * that states anything, as the prefiltered query would.
     */
    function makeDrain(opts: {
      selfId?: string | null;
      timezone?: string | null;
      pages?: Array<Array<Record<string, unknown>>>;
      endpoints?: Endpoint[];
    }) {
      const { service, query, personMerge } = makeService([], []);
      const pages = [...(opts.pages ?? [])];
      const state = { endpoints: opts.endpoints ?? [] };
      const pageCalls: unknown[][] = [];
      const endpointCalls: string[][] = [];
      const demotions: Array<{
        id: string;
        score: number;
        evidence: Array<{ kind: string; score: number | null }>;
      }> = [];
      const accepted: string[][] = [];
      const corpusCalls: unknown[][] = [];
      const phoneCorpusCalls: unknown[][] = [];

      query.mockReset();
      query.mockImplementation(async (sql: string, params: unknown[] = []) => {
        if (/FROM ci\.users/.test(sql)) {
          return [{ entity_id: opts.selfId ?? null, timezone: opts.timezone ?? 'America/Los_Angeles' }];
        }

        if (/AS via_email/.test(sql)) {
          pageCalls.push(params);

          return pages.shift() ?? [];
        }

        if (sql === PROFILE_FACTS_CORPUS_SQL) {
          corpusCalls.push(params);

          return state.endpoints.filter((row) => Object.keys(row.profile_props ?? {}).length > 0);
        }

        if (sql === PHONE_FACTS_CORPUS_SQL) {
          phoneCorpusCalls.push(params);

          return state.endpoints.filter(
            (row) => Object.keys(row.phone_props ?? {}).length > 0 || !/[a-z]/i.test(row.person_name ?? ''),
          );
        }

        if (sql === PHONE_CLAIM_E164_SQL) {
          return [];
        }

        if (/profile_props/.test(sql)) {
          const ids = params[1] as string[];
          endpointCalls.push(ids);

          return state.endpoints.filter((row) => ids.includes(row.entity_id));
        }

        if (/SET score = \$3, evidence/.test(sql)) {
          demotions.push({
            id: params[1] as string,
            score: params[2] as number,
            evidence: JSON.parse(params[3] as string),
          });

          return [];
        }

        if (/SET status = \$3/.test(sql)) {
          accepted.push(params[1] as string[]);

          return [{ merge_candidate_id: 'x' }];
        }

        return [];
      });

      return {
        service,
        query,
        personMerge,
        pageCalls,
        endpointCalls,
        demotions,
        accepted,
        corpusCalls,
        phoneCorpusCalls,
        state,
      };
    }

    const BUDGET = { budgetMs: 60_000 };

    it('merges a same-email pair into the self person when they are in it', async () => {
      const drain = makeDrain({
        selfId: PERSON_B,
        pages: [[pageRow()]],
        endpoints: [endpoint(PERSON_A, 'Ada Q'), endpoint(PERSON_B, 'Ada Quillfeather')],
      });

      const result = await drain.service.autoMergeDeterministicPairs(CONTEXT, BUDGET);

      expect(result).toMatchObject({ merged: 1, skipped: 0, demoted: 0 });
      expect(drain.personMerge.mergePeople).toHaveBeenCalledWith(CONTEXT, [PERSON_A], PERSON_B);
      expect(drain.accepted).toEqual([[PERSON_A, PERSON_B]]);
    });

    it('selects on the email tier and the adjudicated phone tier, not on a claims E.164 join', async () => {
      const drain = makeDrain({ pages: [] });

      await drain.service.autoMergeDeterministicPairs(CONTEXT, BUDGET);

      const pageSql = String(
        drain.query.mock.calls.find((call) => /AS via_email/.test(String(call[0])))?.[0],
      );
      expect(pageSql).toMatch(/evidence @> '\[\{"kind":"email"\}\]'/);
      expect(pageSql).toMatch(/ev->>'kind' = 'phone'[\s\S]*>= 0\.95/);
      expect(pageSql).not.toMatch(/value_e164/);
    });

    it('keeps the fuller name when neither person is self', async () => {
      // PersonMergeService keeps the TARGET's display name, so the target is
      // the fuller one, not whichever uuid sorts first.
      const drain = makeDrain({
        pages: [[pageRow()]],
        endpoints: [endpoint(PERSON_A, 'Ada Q'), endpoint(PERSON_B, 'Ada Quillfeather')],
      });

      await drain.service.autoMergeDeterministicPairs(CONTEXT, BUDGET);

      expect(drain.personMerge.mergePeople).toHaveBeenCalledWith(CONTEXT, [PERSON_A], PERSON_B);
    });

    it('keeps entity_id_a on a tie', async () => {
      const drain = makeDrain({
        pages: [[pageRow()]],
        endpoints: [endpoint(PERSON_A, 'Ada Quill'), endpoint(PERSON_B, 'Ada Quill')],
      });

      await drain.service.autoMergeDeterministicPairs(CONTEXT, BUDGET);

      expect(drain.personMerge.mergePeople).toHaveBeenCalledWith(CONTEXT, [PERSON_B], PERSON_A);
    });

    it('leaves the pair pending when the merge throws', async () => {
      const drain = makeDrain({
        pages: [[pageRow()]],
        endpoints: [endpoint(PERSON_A, 'Ada Q'), endpoint(PERSON_B, 'Ada Quillfeather')],
      });
      drain.personMerge.mergePeople.mockRejectedValueOnce(new Error('locked'));

      const result = await drain.service.autoMergeDeterministicPairs(CONTEXT, BUDGET);

      expect(result).toMatchObject({ merged: 0, skipped: 1 });
      expect(drain.accepted).toEqual([]);
      expect(drain.demotions).toEqual([]);
    });

    it('merges a pair whose only deterministic evidence is an exact profile URL', async () => {
      const drain = makeDrain({
        pages: [
          [
            pageRow({
              via_email: false,
              evidence: [{ kind: 'profile_url', value: 'linkedin.com/in/ada-quillfeather-7x2', score: 0.95 }],
            }),
          ],
        ],
        endpoints: [
          endpoint(PERSON_A, 'Ada Quillfeather', { URL: ADA_URL, ConnectedOn: '09 May 2014' }),
          endpoint(PERSON_B, 'Ada Quillfeather', { Notes: [`URL: ${ADA_URL}\nConnected On: 09 May 2014`] }),
        ],
      });

      const result = await drain.service.autoMergeDeterministicPairs(CONTEXT, BUDGET);

      expect(result.merged).toBe(1);
      expect(drain.personMerge.mergePeople).toHaveBeenCalledWith(CONTEXT, [PERSON_B], PERSON_A);
    });

    it('demotes an email pair whose live rows state different profiles, and does not merge it', async () => {
      const drain = makeDrain({
        pages: [[pageRow()]],
        endpoints: [
          endpoint(PERSON_A, 'Ada Quillfeather', { URL: ADA_URL }),
          endpoint(PERSON_B, 'Ada Quillfeather', { Notes: [`URL: ${OTHER_ADA_URL}`] }),
        ],
      });

      const result = await drain.service.autoMergeDeterministicPairs(CONTEXT, BUDGET);

      expect(result).toMatchObject({ merged: 0, demoted: 1 });
      expect(drain.personMerge.mergePeople).not.toHaveBeenCalled();
      expect(drain.demotions).toHaveLength(1);
      expect(drain.demotions[0].score).toBe(0.8);
      expect(drain.demotions[0].evidence.map((item) => item.kind)).toEqual(['email', 'profile_url_conflict']);
    });

    it('demotes a pair whose live URL sets only overlap', async () => {
      const drain = makeDrain({
        pages: [
          [
            pageRow({
              via_email: false,
              evidence: [{ kind: 'profile_url', value: 'linkedin.com/in/ada-quillfeather-7x2', score: 0.95 }],
            }),
          ],
        ],
        endpoints: [
          endpoint(PERSON_A, 'Ada Quillfeather', { URL: ADA_URL }),
          endpoint(PERSON_B, 'Ada Quillfeather', { Notes: [`URL: ${ADA_URL}\nURL: ${BO_URL}`] }),
        ],
      });

      await drain.service.autoMergeDeterministicPairs(CONTEXT, BUDGET);

      expect(drain.personMerge.mergePeople).not.toHaveBeenCalled();
      expect(drain.demotions[0].score).toBe(0.8);
      expect(drain.demotions[0].evidence.map((item) => item.kind)).toEqual([
        'profile_url',
        'profile_url_partial',
      ]);
    });

    it('demotes a profile-only pair whose live verdict is no longer exact', async () => {
      // An earlier merge or a re-import renamed one side: the URL still agrees,
      // the surname no longer does.
      const drain = makeDrain({
        pages: [
          [
            pageRow({
              via_email: false,
              evidence: [{ kind: 'profile_url', value: 'linkedin.com/in/ada-quillfeather-7x2', score: 0.95 }],
            }),
          ],
        ],
        endpoints: [
          endpoint(PERSON_A, 'Ada Quillfeather', { URL: ADA_URL }),
          endpoint(PERSON_B, 'Ada Brightwater', { Notes: [`URL: ${ADA_URL}`] }),
        ],
      });

      const result = await drain.service.autoMergeDeterministicPairs(CONTEXT, BUDGET);

      expect(result.demoted).toBe(1);
      expect(drain.personMerge.mergePeople).not.toHaveBeenCalled();
      expect(drain.demotions[0].evidence.map((item) => item.kind)).toEqual([
        'profile_url',
        'profile_url_check',
      ]);
    });

    it('does not fail the drain when a demotion cannot be written', async () => {
      const drain = makeDrain({
        pages: [[pageRow()]],
        endpoints: [
          endpoint(PERSON_A, 'Ada Quillfeather', { URL: ADA_URL }),
          endpoint(PERSON_B, 'Ada Quillfeather', { Notes: [`URL: ${OTHER_ADA_URL}`] }),
        ],
      });
      const route = drain.query.getMockImplementation()!;
      drain.query.mockImplementation(async (sql: string, params?: unknown[]) => {
        if (/SET score = \$3, evidence/.test(sql)) {
          throw new Error('lock timeout');
        }

        return route(sql, params);
      });

      const result = await drain.service.autoMergeDeterministicPairs(CONTEXT, BUDGET);

      expect(result).toMatchObject({ merged: 0, demoted: 0, skipped: 1 });
      expect(drain.personMerge.mergePeople).not.toHaveBeenCalled();
    });

    it('floors a demoted row whose live evidence weighs nothing, instead of writing score 0', async () => {
      const drain = makeDrain({
        pages: [
          [
            pageRow({
              via_email: false,
              evidence: [{ kind: 'profile_url', value: 'linkedin.com/in/ada-quillfeather-7x2', score: 0.95 }],
            }),
          ],
        ],
        endpoints: [
          endpoint(PERSON_A, 'Ada Quillfeather', { URL: ADA_URL }),
          endpoint(PERSON_B, 'Ada Quillfeather', { Notes: [`URL: ${OTHER_ADA_URL}`] }),
        ],
      });

      await drain.service.autoMergeDeterministicPairs(CONTEXT, BUDGET);

      expect(drain.demotions[0].score).toBeGreaterThan(0);
      expect(drain.demotions[0].score).toBeLessThan(0.8);
    });

    it('with the profile tier off, skips a profile-only pair without merging or demoting it', async () => {
      const drain = makeDrain({
        pages: [
          [
            pageRow({
              via_email: false,
              evidence: [{ kind: 'profile_url', value: 'linkedin.com/in/ada-quillfeather-7x2', score: 0.95 }],
            }),
          ],
        ],
        endpoints: [
          endpoint(PERSON_A, 'Ada Quillfeather', { URL: ADA_URL }),
          endpoint(PERSON_B, 'Ada Quillfeather', { Notes: [`URL: ${ADA_URL}`] }),
        ],
      });

      const result = await drain.service.autoMergeDeterministicPairs(CONTEXT, {
        ...BUDGET,
        includeProfileUrl: false,
      });

      expect(result).toMatchObject({ merged: 0, skipped: 1, demoted: 0 });
      expect(drain.personMerge.mergePeople).not.toHaveBeenCalled();
      const pageSql = String(
        drain.query.mock.calls.find((call) => /AS via_email/.test(String(call[0])))?.[0],
      );
      expect(pageSql).not.toContain(`ev->>'kind' = 'profile_url'`);
    });

    it('merges into an is_self row even when users.entity_id points elsewhere', async () => {
      const drain = makeDrain({
        selfId: null,
        pages: [[pageRow()]],
        endpoints: [endpoint(PERSON_A, 'Ada Q'), endpoint(PERSON_B, 'Ada Quillfeather', {}, true)],
      });

      await drain.service.autoMergeDeterministicPairs(CONTEXT, BUDGET);

      expect(drain.personMerge.mergePeople).toHaveBeenCalledWith(CONTEXT, [PERSON_A], PERSON_B);
    });

    it('skips a pair with two self endpoints', async () => {
      const drain = makeDrain({
        selfId: PERSON_A,
        pages: [[pageRow()]],
        endpoints: [endpoint(PERSON_A, 'Ada Q'), endpoint(PERSON_B, 'Ada Quillfeather', {}, true)],
      });

      const result = await drain.service.autoMergeDeterministicPairs(CONTEXT, BUDGET);

      expect(result).toMatchObject({ merged: 0, skipped: 1 });
      expect(drain.personMerge.mergePeople).not.toHaveBeenCalled();
    });

    it('keyset-pages past a skipped row instead of re-reading it', async () => {
      const drain = makeDrain({
        // The endpoint of the first page's row is gone, so it is skipped.
        pages: [[pageRow({ merge_candidate_id: '00000000-0000-0000-0000-0000000000c7', score: 0.95 })], []],
        endpoints: [endpoint(PERSON_A, 'Ada Q')],
      });

      const result = await drain.service.autoMergeDeterministicPairs(CONTEXT, { ...BUDGET, pageSize: 1 });

      expect(result).toMatchObject({ skipped: 1, considered: 1 });
      expect(drain.pageCalls).toHaveLength(2);
      expect(drain.pageCalls[0]).toEqual([USER, null, null, 1]);
      expect(drain.pageCalls[1]).toEqual([USER, 0.95, '00000000-0000-0000-0000-0000000000c7', 1]);
    });

    it('stops on the first empty page', async () => {
      const drain = makeDrain({ pages: [] });

      const result = await drain.service.autoMergeDeterministicPairs(CONTEXT, BUDGET);

      expect(result).toEqual({ merged: 0, skipped: 0, demoted: 0, considered: 0 });
      expect(drain.pageCalls).toHaveLength(1);
    });

    it('stops when the budget is spent', async () => {
      const drain = makeDrain({ pages: [[pageRow()]] });

      const result = await drain.service.autoMergeDeterministicPairs(CONTEXT, { budgetMs: 0 });

      expect(result.considered).toBe(0);
      expect(drain.pageCalls).toHaveLength(0);
      expect(drain.personMerge.mergePeople).not.toHaveBeenCalled();
    });

    describe('the holder cap, on the live corpus', () => {
      const HOLDER_IDS = Array.from(
        { length: PROFILE_URL_MAX_HOLDERS + 1 },
        (_, index) => `00000000-0000-0000-0000-0000000000d${index + 1}`,
      );
      const NAMES = [
        'Zed',
        'Zed Quimby',
        'Cleo Varga',
        'Dov Ellery',
        'Esme Tarrant',
        'Fitz Ormond',
        'Gus Pellow',
      ];

      /** `count` people whose cards carry only the pasted URL; the first two are "Zed" and "Zed Quimby". */
      function deskHolders(count: number): Endpoint[] {
        return HOLDER_IDS.slice(0, count).map((id, index) =>
          endpoint(id, NAMES[index], { Notes: [`URL: ${DESK_URL}`] }),
        );
      }

      /** The pair the detector wrote while the URL was still under the cap. */
      const zedRow = (overrides: Record<string, unknown> = {}) =>
        pageRow({
          merge_candidate_id: '00000000-0000-0000-0000-0000000000c2',
          entity_id_a: HOLDER_IDS[0],
          entity_id_b: HOLDER_IDS[1],
          via_email: false,
          evidence: [
            { kind: 'profile_url', value: DESK_KEY, score: 0.95 },
            { kind: 'name_cluster', value: 'zed', score: 0.5 },
          ],
          ...overrides,
        });

      it('demotes a pair whose URL became over-common after detection, and does not merge it', async () => {
        // Graded exact at detection, when six people held the URL. A later
        // import pasted it into a seventh card: it identifies nobody now,
        // and the stored 0.95 must not carry the merge.
        const drain = makeDrain({
          pages: [[zedRow()]],
          endpoints: deskHolders(PROFILE_URL_MAX_HOLDERS + 1),
        });

        const result = await drain.service.autoMergeDeterministicPairs(CONTEXT, BUDGET);

        expect(result).toMatchObject({ merged: 0, demoted: 1 });
        expect(drain.personMerge.mergePeople).not.toHaveBeenCalled();
        expect(drain.demotions).toEqual([
          {
            id: '00000000-0000-0000-0000-0000000000c2',
            score: 0.5,
            evidence: [{ kind: 'name_cluster', value: 'zed', score: 0.5 }],
          },
        ]);
        expect(drain.corpusCalls).toEqual([[USER]]);
      });

      it('merges the same pair while the URL is still under the cap', async () => {
        const drain = makeDrain({
          pages: [[zedRow()]],
          endpoints: deskHolders(PROFILE_URL_MAX_HOLDERS),
        });

        const result = await drain.service.autoMergeDeterministicPairs(CONTEXT, BUDGET);

        expect(result).toMatchObject({ merged: 1, demoted: 0 });
      });

      it('counts a URL that a merge folded into the target', async () => {
        // A (target) and B (source) share an email and Ada's own profile; B's
        // card also carries the pasted URL, held by B and six others. The
        // merge moves B's URL onto A, so seven people still hold it, and the
        // (Zed, Zed Quimby) pair after it must still be refused. Counting B
        // as gone without re-reading A would put the URL at six and merge it.
        const drain = makeDrain({
          pages: [[pageRow(), zedRow()]],
          endpoints: [
            endpoint(PERSON_A, 'Ada Quillfeather', { URL: ADA_URL }),
            endpoint(PERSON_B, 'Ada Quillfeather', { Notes: [`URL: ${ADA_URL}\nURL: ${DESK_URL}`] }),
            ...deskHolders(PROFILE_URL_MAX_HOLDERS),
          ],
        });
        drain.personMerge.mergePeople.mockImplementationOnce(async () => {
          drain.state.endpoints = [
            endpoint(PERSON_A, 'Ada Quillfeather', { URL: ADA_URL, Notes: [`URL: ${DESK_URL}`] }),
            ...deskHolders(PROFILE_URL_MAX_HOLDERS),
          ];
        });

        const result = await drain.service.autoMergeDeterministicPairs(CONTEXT, BUDGET);

        expect(drain.personMerge.mergePeople).toHaveBeenCalledTimes(1);
        expect(drain.personMerge.mergePeople).toHaveBeenCalledWith(CONTEXT, [PERSON_B], PERSON_A);
        expect(result).toMatchObject({ merged: 1, demoted: 1 });
        expect(drain.demotions.map((demotion) => demotion.id)).toEqual([
          '00000000-0000-0000-0000-0000000000c2',
        ]);
        expect(drain.corpusCalls).toHaveLength(1);
      });

      it('does not read the corpus when one side of every pair states no URL', async () => {
        const drain = makeDrain({
          pages: [[pageRow()]],
          endpoints: [endpoint(PERSON_A, 'Ada Q', { URL: ADA_URL }), endpoint(PERSON_B, 'Ada Quillfeather')],
        });

        const result = await drain.service.autoMergeDeterministicPairs(CONTEXT, BUDGET);

        expect(result.merged).toBe(1);
        expect(drain.corpusCalls).toEqual([]);
      });
    });

    describe('the phone tier', () => {
      // Invented: the 555-01XX fiction range under a real area code.
      const NUMBER = '+1 (202) 555-0142';
      const E164 = '+12025550142';
      const DIGITS = '2025550142';
      const PERSON_C = '00000000-0000-0000-0000-0000000000b3';

      /** A Google Voice stub: named by its number, the ten-digit key in `phones`. */
      const stub = (id: string) => endpoint(id, NUMBER, {}, false, { phones: [DIGITS] });
      /** A contacts vCard that kept the number as typed. */
      const card = (id: string, name: string, isSelf = false) =>
        endpoint(id, name, {}, isSelf, { Phones: ['(202) 555-0142'], phones: [DIGITS] });

      /** The row the detector wrote: phone-only, graded exact. */
      const phoneRow = (overrides: Record<string, unknown> = {}) =>
        pageRow({
          score: 0.95,
          via_email: false,
          via_phone: true,
          evidence: [{ kind: 'phone', value: E164, score: 0.95 }],
          ...overrides,
        });

      it('merges a phone-exact pair after the live re-check, keeping the real name', async () => {
        // The stub is entity_id_a; folding the vCard INTO it would leave the
        // contact named by a phone number.
        const drain = makeDrain({
          pages: [[phoneRow()]],
          endpoints: [stub(PERSON_A), card(PERSON_B, 'Ada Quill')],
        });

        const result = await drain.service.autoMergeDeterministicPairs(CONTEXT, BUDGET);

        expect(result).toMatchObject({ merged: 1, demoted: 0 });
        expect(drain.personMerge.mergePeople).toHaveBeenCalledWith(CONTEXT, [PERSON_A], PERSON_B);
        expect(drain.phoneCorpusCalls).toEqual([[USER]]);
      });

      it('demotes a pair whose live names are now two different given names, and does not merge it', async () => {
        // Graded exact at detection; a re-import since renamed one side.
        const drain = makeDrain({
          pages: [[phoneRow()]],
          endpoints: [card(PERSON_A, 'Ada Quill'), card(PERSON_B, 'Bo Quill')],
        });

        const result = await drain.service.autoMergeDeterministicPairs(CONTEXT, BUDGET);

        expect(result).toMatchObject({ merged: 0, demoted: 1 });
        expect(drain.personMerge.mergePeople).not.toHaveBeenCalled();
        expect(drain.demotions[0]).toEqual({
          id: '00000000-0000-0000-0000-0000000000c1',
          score: 0.85,
          evidence: [
            { kind: 'phone', value: E164, score: 0.85 },
            { kind: 'phone_check', value: 'given_name_conflict', score: 0 },
          ],
        });
      });

      it('demotes a stub pair whose line gained a second real identity after detection', async () => {
        const drain = makeDrain({
          pages: [[phoneRow()]],
          endpoints: [stub(PERSON_A), card(PERSON_B, 'Ada Quill'), card(PERSON_C, 'Bo Quill')],
        });

        const result = await drain.service.autoMergeDeterministicPairs(CONTEXT, BUDGET);

        expect(result).toMatchObject({ merged: 0, demoted: 1 });
        expect(drain.demotions[0].evidence).toContainEqual({
          kind: 'phone_check',
          value: 'shared_line',
          score: 0,
        });
      });

      it('demotes a pair whose number became over-common after detection', async () => {
        const others = Array.from({ length: PHONE_MAX_HOLDERS - 1 }, (_, index) =>
          card(`00000000-0000-0000-0000-0000000000e${index + 1}`, `Holder${index} Quill`),
        );
        const drain = makeDrain({
          pages: [[phoneRow()]],
          endpoints: [stub(PERSON_A), card(PERSON_B, 'Ada Quill'), ...others],
        });

        const result = await drain.service.autoMergeDeterministicPairs(CONTEXT, BUDGET);

        expect(result).toMatchObject({ merged: 0, demoted: 1 });
        expect(drain.personMerge.mergePeople).not.toHaveBeenCalled();
        // Nothing weighs any more: floored, not scored 0.
        expect(drain.demotions[0]).toMatchObject({ score: 0.5, evidence: [] });
      });

      it('never folds a phone-only pair into the self Person', async () => {
        const drain = makeDrain({
          pages: [[phoneRow()]],
          endpoints: [stub(PERSON_A), card(PERSON_B, 'Ada Quill', true)],
        });

        const result = await drain.service.autoMergeDeterministicPairs(CONTEXT, BUDGET);

        expect(result).toMatchObject({ merged: 0, demoted: 1 });
        expect(drain.personMerge.mergePeople).not.toHaveBeenCalled();
        expect(drain.demotions[0].evidence).toContainEqual({
          kind: 'phone_check',
          value: 'self_endpoint',
          score: 0,
        });
      });

      it('lets a profile veto win over an exact phone without reading the phone corpus', async () => {
        const drain = makeDrain({
          pages: [[phoneRow()]],
          endpoints: [
            endpoint(PERSON_A, 'Ada Quill', { URL: ADA_URL }, false, { Phones: ['(202) 555-0142'] }),
            endpoint(PERSON_B, 'Ada Quill', { Notes: [`URL: ${OTHER_ADA_URL}`] }, false, {
              phones: [DIGITS],
            }),
          ],
        });

        const result = await drain.service.autoMergeDeterministicPairs(CONTEXT, BUDGET);

        expect(result).toMatchObject({ merged: 0, demoted: 1 });
        expect(drain.demotions[0].score).toBe(0.8);
        expect(drain.demotions[0].evidence.map((item) => item.kind)).toEqual([
          'phone',
          'profile_url_conflict',
        ]);
        expect(drain.phoneCorpusCalls).toEqual([]);
      });

      it('with the phone tier off, leaves a phone-only row untouched', async () => {
        const drain = makeDrain({
          pages: [[phoneRow()]],
          endpoints: [stub(PERSON_A), card(PERSON_B, 'Ada Quill')],
        });

        const result = await drain.service.autoMergeDeterministicPairs(CONTEXT, {
          ...BUDGET,
          includePhone: false,
          includeProfileUrl: false,
        });

        expect(result).toMatchObject({ merged: 0, skipped: 1, demoted: 0 });
        expect(drain.personMerge.mergePeople).not.toHaveBeenCalled();
        expect(drain.phoneCorpusCalls).toEqual([]);
        const pageSql = String(
          drain.query.mock.calls.find((call) => /AS via_email/.test(String(call[0])))?.[0],
        );
        // The select list still reports via_phone; the WHERE must not select on it.
        expect(pageSql.slice(pageSql.indexOf('WHERE mc.owner_user_id'))).not.toContain(
          `ev->>'kind' = 'phone'`,
        );
      });

      it('merges an email pair without reading the phone corpus', async () => {
        const drain = makeDrain({
          pages: [[pageRow()]],
          endpoints: [stub(PERSON_A), card(PERSON_B, 'Ada Quill')],
        });

        await drain.service.autoMergeDeterministicPairs(CONTEXT, BUDGET);

        expect(drain.personMerge.mergePeople).toHaveBeenCalledTimes(1);
        expect(drain.phoneCorpusCalls).toEqual([]);
      });

      it('keeps the phone index in step with merges made after it was loaded', async () => {
        // Seven people carry the number: two copies of Ada and five stubs of
        // it. The first row loads the index while the number is over-common
        // (it demotes); the email pair then folds one Ada into the other,
        // leaving six; the last row must be judged on six, not on the seven
        // the index was loaded with.
        const stubs = ['e1', 'e2', 'e3', 'e4'].map((suffix) =>
          stub(`00000000-0000-0000-0000-0000000000${suffix}`),
        );
        const adaA = card(PERSON_A, 'Ada Quill');
        const adaB = card(PERSON_B, 'Ada Quill');
        const drain = makeDrain({
          pages: [
            [
              phoneRow({
                merge_candidate_id: '00000000-0000-0000-0000-0000000000c1',
                entity_id_a: PERSON_C,
                entity_id_b: stubs[0].entity_id,
              }),
              pageRow({ merge_candidate_id: '00000000-0000-0000-0000-0000000000c2' }),
              phoneRow({
                merge_candidate_id: '00000000-0000-0000-0000-0000000000c3',
                entity_id_a: PERSON_A,
                entity_id_b: PERSON_C,
              }),
            ],
          ],
          endpoints: [adaA, adaB, stub(PERSON_C), ...stubs],
        });
        drain.personMerge.mergePeople.mockImplementationOnce(async () => {
          drain.state.endpoints = [adaA, stub(PERSON_C), ...stubs];
        });

        const result = await drain.service.autoMergeDeterministicPairs(CONTEXT, BUDGET);

        expect(drain.demotions.map((demotion) => demotion.id)).toEqual([
          '00000000-0000-0000-0000-0000000000c1',
        ]);
        expect(drain.personMerge.mergePeople).toHaveBeenNthCalledWith(1, CONTEXT, [PERSON_B], PERSON_A);
        expect(drain.personMerge.mergePeople).toHaveBeenNthCalledWith(2, CONTEXT, [PERSON_C], PERSON_A);
        expect(result).toMatchObject({ merged: 2, demoted: 1 });
        expect(drain.phoneCorpusCalls).toHaveLength(1);
      });
    });

    it('re-reads an endpoint an earlier merge on the same page changed', async () => {
      // A group of three: (A,B) folds B into A, then (A,C) must be judged on A
      // as it is now — its properties folded — not on the page's first read.
      const drain = makeDrain({
        pages: [
          [
            pageRow({ merge_candidate_id: '00000000-0000-0000-0000-0000000000c1' }),
            pageRow({ merge_candidate_id: '00000000-0000-0000-0000-0000000000c2', entity_id_b: PERSON_C }),
          ],
        ],
        endpoints: [endpoint(PERSON_A, 'Ada Q'), endpoint(PERSON_B, 'Ada Q'), endpoint(PERSON_C, 'Ada Q')],
      });

      await drain.service.autoMergeDeterministicPairs(CONTEXT, BUDGET);

      expect(drain.endpointCalls).toHaveLength(2);
      expect(drain.endpointCalls[1]).toEqual([PERSON_A]);
      expect(drain.personMerge.mergePeople).toHaveBeenNthCalledWith(2, CONTEXT, [PERSON_C], PERSON_A);
    });
  });
});
