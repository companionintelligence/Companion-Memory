import type { UserServiceContext } from '@ci/common/context';

import {
  ENRICH_PERSON_SELF_CLAIM_STAGE_ID,
  PERSON_SELF_CLAIM_GENERATION,
  PersonSelfClaimStage,
} from '../enrich/PersonSelfClaimStage';

const USER = '00000000-0000-4000-8000-0000000000aa';
const CONTEXT: UserServiceContext = { userId: USER } as UserServiceContext;

function personId(n: number): string {
  return `00000000-0000-4000-8000-1${String(n).padStart(11, '0')}`;
}

function makeLogger() {
  return { setContext: jest.fn(), log: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

interface Harness {
  stage: PersonSelfClaimStage;
  /** Every statement issued, for asserting on the upsert's params. */
  statements: Array<{ sql: string; params: unknown[] }>;
  subjects: Array<{ entity_id: string; name: string | null; properties: Record<string, unknown> | null }>;
}

function makeHarness(subjects: Harness['subjects']): Harness {
  const statements: Array<{ sql: string; params: unknown[] }> = [];

  const query = jest.fn(async (sql: string, params: unknown[] = []) => {
    statements.push({ sql, params });

    if (sql.includes('FROM ci.entities')) {
      const ids: string[] = params[0] as string[];

      return subjects.filter((s) => ids.includes(s.entity_id));
    }

    return [];
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dataSource = { query } as any;
  const stage = new PersonSelfClaimStage(dataSource, makeLogger() as never);

  return { stage, statements, subjects };
}

/**
 * `enrich.person_self_claim` — the missing evidence producer for
 * `clean.duplicate_detect`. See the long comment on
 * `STAGE_IDS.ENRICH_PERSON_SELF_CLAIM` for why: a contact-card/vCard/Apple
 * Contacts Person that never resolved from a communication or event had zero
 * rows in `ci.identifier_claims`, so it could never be proposed as anyone's
 * duplicate no matter how many identifiers it shared.
 */
describe('PersonSelfClaimStage', () => {
  it('reports its declared id and version', () => {
    const { stage } = makeHarness([]);

    expect(stage.id).toBe(ENRICH_PERSON_SELF_CLAIM_STAGE_ID);
    expect(stage.version).toBe(PERSON_SELF_CLAIM_GENERATION);
  });

  it('extracts name, emails[] and phones[] into claims', async () => {
    const id = personId(1);
    const { stage, statements } = makeHarness([
      {
        entity_id: id,
        name: 'Demond Vega, CIR, CSSR',
        properties: { emails: ['DVegaPancho@pmcgllc.com'], phones: ['+1 (415) 555-0100'] },
      },
    ]);

    const results = await stage.run(CONTEXT, [id]);

    expect(results.get(id)).toEqual({ outcome: 'done', detail: { claims: 3 } });

    const upsert = statements.find(({ sql }) => sql.includes('INSERT INTO ci.identifier_claims'));
    expect(upsert).toBeDefined();
    const [, , , , , entityIds, kinds, values] = upsert!.params as [
      string,
      string,
      string,
      string,
      number,
      string[],
      string[],
      string[],
    ];
    expect(entityIds).toEqual([id, id, id]);
    expect(kinds.sort()).toEqual(['email', 'name', 'phone']);
    // Email lowercased, phone collapsed to its last 10 digits — the SAME rule
    // `enrich.person_link` writes claims with, or the two would never match.
    expect(values).toEqual(
      expect.arrayContaining(['demond vega, cir, cssr', 'dvegapancho@pmcgllc.com', '4155550100']),
    );
  });

  it('falls back to the singular email/phone field when the array is absent', async () => {
    const id = personId(2);
    const { stage, statements } = makeHarness([
      { entity_id: id, name: null, properties: { email: 'alice@example.com', phone: '3035176726' } },
    ]);

    await stage.run(CONTEXT, [id]);

    const upsert = statements.find(({ sql }) => sql.includes('INSERT INTO ci.identifier_claims'));
    const [, , , , , , kinds, values] = upsert!.params as [
      string,
      string,
      string,
      string,
      number,
      string[],
      string[],
      string[],
    ];
    expect(kinds.sort()).toEqual(['email', 'phone']);
    expect(values).toEqual(expect.arrayContaining(['alice@example.com', '3035176726']));
  });

  it('prefers the array over the singular field when both are present, and does not double-count', async () => {
    const id = personId(3);
    const { stage, statements } = makeHarness([
      {
        entity_id: id,
        name: null,
        properties: { email: 'old@example.com', emails: ['new@example.com', 'new2@example.com'] },
      },
    ]);

    await stage.run(CONTEXT, [id]);

    const upsert = statements.find(({ sql }) => sql.includes('INSERT INTO ci.identifier_claims'));
    const [, , , , , , , values] = upsert!.params as [
      string,
      string,
      string,
      string,
      number,
      string[],
      string[],
      string[],
    ];
    expect(values.sort()).toEqual(['new2@example.com', 'new@example.com']);
  });

  it('dedupes case/whitespace variants of the same value within one entity', async () => {
    const id = personId(4);
    const { stage, statements } = makeHarness([
      { entity_id: id, name: null, properties: { emails: ['Bob@Example.com', ' bob@example.com '] } },
    ]);

    const results = await stage.run(CONTEXT, [id]);

    expect(results.get(id)?.detail).toEqual({ claims: 1 });
    const upsert = statements.find(({ sql }) => sql.includes('INSERT INTO ci.identifier_claims'));
    const [, , , , , entityIds] = upsert!.params as [string, string, string, string, number, string[]];
    expect(entityIds).toHaveLength(1);
  });

  it('skips a person with nothing to extract, without issuing an upsert', async () => {
    const id = personId(5);
    const { stage, statements } = makeHarness([{ entity_id: id, name: null, properties: {} }]);

    const results = await stage.run(CONTEXT, [id]);

    expect(results.get(id)).toEqual({ outcome: 'done', detail: { claims: 0 } });
    expect(statements.some(({ sql }) => sql.includes('INSERT INTO ci.identifier_claims'))).toBe(false);
  });

  it('reports source_row_missing for an id the query does not return (deleted, merged, or re-owned)', async () => {
    const missing = personId(6);
    const { stage } = makeHarness([]);

    const results = await stage.run(CONTEXT, [missing]);

    expect(results.get(missing)).toEqual({ outcome: 'skipped', reason: 'source_row_missing' });
  });

  it('returns an empty map for an empty id list without querying', async () => {
    const { stage, statements } = makeHarness([]);

    const results = await stage.run(CONTEXT, []);

    expect(results.size).toBe(0);
    expect(statements).toHaveLength(0);
  });
});
