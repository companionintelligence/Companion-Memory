import type { UserServiceContext } from '@ci/common/context';

import {
  ENRICH_PERSON_SELF_CLAIM_STAGE_ID,
  PERSON_SELF_CLAIM_GENERATION,
  PERSON_SELF_CLAIM_SOURCE,
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

interface SubjectFixture {
  entity_id: string;
  name: string | null;
  properties: Record<string, unknown> | null;
  merged?: boolean;
  active?: boolean;
}

interface Harness {
  stage: PersonSelfClaimStage;
  /** Every statement issued, for asserting on the reconcile's params. */
  statements: Array<{ sql: string; params: unknown[] }>;
}

/** The positional parameters of the reconcile statement, named. */
interface ReconcileParams {
  userId: string;
  subjectType: string;
  role: string;
  stage: string;
  generation: number;
  entityIds: string[];
  kinds: string[];
  values: string[];
  e164s: Array<string | null>;
  raws: Array<string | null>;
  subjectIds: string[];
}

/**
 * `retracted` is what the reconcile statement's DELETE reports, per subject —
 * the fake cannot compute it, so a test that cares scripts it.
 */
function makeHarness(subjects: SubjectFixture[], retracted: Record<string, number> = {}): Harness {
  const statements: Array<{ sql: string; params: unknown[] }> = [];

  const query = jest.fn(async (sql: string, params: unknown[] = []) => {
    statements.push({ sql, params });

    if (sql.includes('FROM ci.entities')) {
      const ids: string[] = params[0] as string[];

      return subjects
        .filter((s) => ids.includes(s.entity_id))
        .map((s) => ({ merged: false, active: true, ...s }));
    }

    if (sql.includes('INSERT INTO ci.identifier_claims')) {
      return Object.entries(retracted).map(([subject_id, count]) => ({ subject_id, retracted: count }));
    }

    return [];
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const dataSource = { query } as any;
  const stage = new PersonSelfClaimStage(dataSource, makeLogger() as never);

  return { stage, statements };
}

function reconcile(statements: Harness['statements']): { sql: string; params: ReconcileParams } {
  const found = statements.find(({ sql }) => sql.includes('INSERT INTO ci.identifier_claims'));

  expect(found).toBeDefined();

  const [userId, subjectType, role, stage, generation, entityIds, kinds, values, e164s, raws, subjectIds] =
    found!.params as [
      string,
      string,
      string,
      string,
      number,
      string[],
      string[],
      string[],
      Array<string | null>,
      Array<string | null>,
      string[],
    ];

  return {
    sql: found!.sql,
    params: {
      userId,
      subjectType,
      role,
      stage,
      generation,
      entityIds,
      kinds,
      values,
      e164s,
      raws,
      subjectIds,
    },
  };
}

/**
 * `enrich.person_self_claim` — the missing evidence producer for
 * `clean.duplicate_detect`. See the long comment on
 * `STAGE_IDS.ENRICH_PERSON_SELF_CLAIM` for why: a contact-card/vCard/Apple
 * Contacts Person that never resolved from a communication or event had zero
 * rows in `ci.identifier_claims`, so it could never be proposed as anyone's
 * duplicate no matter how many identifiers it shared.
 *
 * These pin the TypeScript half — what is extracted, what each subject is
 * answered with, and what is bound. Whether the one statement really retracts
 * the right rows and only those is a property of rows, and is proven against
 * Postgres in `PersonSelfClaimStage.integration.spec.ts`.
 */
describe('PersonSelfClaimStage', () => {
  it('reports its declared id and version', () => {
    const { stage } = makeHarness([]);

    expect(stage.id).toBe(ENRICH_PERSON_SELF_CLAIM_STAGE_ID);
    expect(stage.version).toBe(PERSON_SELF_CLAIM_GENERATION);
  });

  it('applies to every Person row and declares updated_at as its change stamp', () => {
    // A stage that RETRACTS must still be able to reach a Person that was
    // merged away or edited down to nothing — generation 1's "live, with
    // identifiers" predicate dropped exactly those out of the candidate set.
    expect(PERSON_SELF_CLAIM_SOURCE.predicate).toBe("entity_type = 'Person'");
    expect(PERSON_SELF_CLAIM_SOURCE.changedAtColumn).toBe('updated_at');
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

    expect(results.get(id)).toEqual({ outcome: 'done', detail: { claims: 3, retracted: 0 } });

    const { params } = reconcile(statements);
    expect(params.entityIds).toEqual([id, id, id]);
    expect([...params.kinds].sort()).toEqual(['email', 'name', 'phone']);
    // Email lowercased, phone collapsed to its last 10 digits — the SAME rule
    // `enrich.person_link` writes claims with, or the two would never match.
    expect(params.values).toEqual(
      expect.arrayContaining(['demond vega, cir, cssr', 'dvegapancho@pmcgllc.com', '4155550100']),
    );
  });

  it('falls back to the singular email/phone field when the array is absent', async () => {
    const id = personId(2);
    const { stage, statements } = makeHarness([
      { entity_id: id, name: null, properties: { email: 'alice@example.com', phone: '3035176726' } },
    ]);

    await stage.run(CONTEXT, [id]);

    const { params } = reconcile(statements);
    expect([...params.kinds].sort()).toEqual(['email', 'phone']);
    expect(params.values).toEqual(expect.arrayContaining(['alice@example.com', '3035176726']));
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

    const { params } = reconcile(statements);
    expect([...params.values].sort()).toEqual(['new2@example.com', 'new@example.com']);
  });

  it('dedupes case/whitespace variants of the same value within one entity', async () => {
    const id = personId(4);
    const { stage, statements } = makeHarness([
      { entity_id: id, name: null, properties: { emails: ['Bob@Example.com', ' bob@example.com '] } },
    ]);

    const results = await stage.run(CONTEXT, [id]);

    expect(results.get(id)?.detail).toEqual({ claims: 1, retracted: 0 });
    expect(reconcile(statements).params.entityIds).toHaveLength(1);
  });

  it('still reconciles a person with nothing to extract, so the claims they used to have are retracted', async () => {
    // Generation 1 issued no statement here, which is precisely how a record
    // edited down to nothing kept every claim it ever had.
    const id = personId(5);
    const { stage, statements } = makeHarness([{ entity_id: id, name: null, properties: {} }], { [id]: 2 });

    const results = await stage.run(CONTEXT, [id]);

    expect(results.get(id)).toEqual({ outcome: 'done', detail: { claims: 0, retracted: 2 } });

    const { params } = reconcile(statements);
    expect(params.entityIds).toEqual([]);
    expect(params.subjectIds).toEqual([id]);
  });

  it('asserts nothing for a merged-away person, and answers skipped: merged', async () => {
    const tombstone = personId(6);
    const { stage, statements } = makeHarness(
      [
        {
          entity_id: tombstone,
          name: 'Old Dup',
          properties: { phones: ['3035176726'] },
          merged: true,
          active: false,
        },
      ],
      { [tombstone]: 2 },
    );

    const results = await stage.run(CONTEXT, [tombstone]);

    expect(results.get(tombstone)).toEqual({
      outcome: 'skipped',
      reason: 'merged',
      detail: { retracted: 2 },
    });

    // Its identifiers belong to the Person it was merged into now — asserting
    // them here would keep counting a tombstone as a holder of the number.
    const { params } = reconcile(statements);
    expect(params.entityIds).toEqual([]);
    expect(params.subjectIds).toEqual([tombstone]);
  });

  it('asserts nothing for an inactive person, and answers skipped: inactive', async () => {
    const id = personId(7);
    const { stage, statements } = makeHarness([
      { entity_id: id, name: 'Gone', properties: { emails: ['gone@example.com'] }, active: false },
    ]);

    const results = await stage.run(CONTEXT, [id]);

    expect(results.get(id)).toEqual({ outcome: 'skipped', reason: 'inactive', detail: { retracted: 0 } });
    expect(reconcile(statements).params.entityIds).toEqual([]);
  });

  it('reports source_row_missing for an id the query does not return, and still retracts its claims', async () => {
    const missing = personId(8);
    const { stage, statements } = makeHarness([], { [missing]: 1 });

    const results = await stage.run(CONTEXT, [missing]);

    expect(results.get(missing)).toEqual({
      outcome: 'skipped',
      reason: 'source_row_missing',
      detail: { retracted: 1 },
    });
    expect(reconcile(statements).params.subjectIds).toEqual([missing]);
  });

  it('reconciles the whole slice in ONE statement that both upserts and retracts', async () => {
    const live = personId(9);
    const tombstone = personId(10);
    const { stage, statements } = makeHarness(
      [
        { entity_id: live, name: 'Ann Lee', properties: { phones: ['3035176726'] } },
        { entity_id: tombstone, name: 'Ann Lee', properties: {}, merged: true, active: false },
      ],
      { [live]: 1 },
    );

    const results = await stage.run(CONTEXT, [live, tombstone, live]);

    // One load, one reconcile — the half-way state (new number asserted, old
    // one not yet retracted) is never visible to a reader.
    expect(statements).toHaveLength(2);

    const { sql, params } = reconcile(statements);
    expect(sql).toMatch(/INSERT INTO ci\.identifier_claims/);
    expect(sql).toMatch(/DELETE FROM ci\.identifier_claims/);

    // Retraction is scoped to THIS stage's self claims and never touches a
    // human's verdict.
    expect(sql).toMatch(/ic\.stage = \$4/);
    expect(sql).toMatch(/ic\.role = \$3/);
    expect(sql).toMatch(/ic\.subject_type = \$2/);
    expect(sql).toMatch(/ic\.disposition IS NULL/);

    expect(params).toEqual(
      expect.objectContaining({
        userId: USER,
        subjectType: 'person',
        role: 'self',
        stage: ENRICH_PERSON_SELF_CLAIM_STAGE_ID,
        generation: PERSON_SELF_CLAIM_GENERATION,
      }),
    );
    // Every subject in the slice, deduplicated — the tombstone included.
    expect(params.subjectIds).toEqual([live, tombstone]);

    expect(results.get(live)).toEqual({ outcome: 'done', detail: { claims: 2, retracted: 1 } });
    expect(results.get(tombstone)).toEqual({
      outcome: 'skipped',
      reason: 'merged',
      detail: { retracted: 0 },
    });
  });

  it('keeps the raw form only when normalization changed it', async () => {
    const id = personId(11);
    const { stage, statements } = makeHarness([
      { entity_id: id, name: null, properties: { phones: ['+44 20 7946 0958', '3035176726'] } },
    ]);

    await stage.run(CONTEXT, [id]);

    const { params } = reconcile(statements);
    const byValue = new Map(params.values.map((value, i) => [value, i]));

    expect(params.raws[byValue.get('2079460958')!]).toBe('+44 20 7946 0958');
    expect(params.e164s[byValue.get('2079460958')!]).toBe('+442079460958');
    expect(params.raws[byValue.get('3035176726')!]).toBeNull();
  });

  it('returns an empty map for an empty id list without querying', async () => {
    const { stage, statements } = makeHarness([]);

    const results = await stage.run(CONTEXT, []);

    expect(results.size).toBe(0);
    expect(statements).toHaveLength(0);
  });
});
