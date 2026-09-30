import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { DataSource, type QueryRunner } from 'typeorm';

import type { UserServiceContext } from '@ci/common/context';
import { EntityIdentifierEntity, EntityIdentifierService } from '@ci/domains/graph';
import { BaseEntity, MergeCandidateService, PersonEntity, type PersonMergeService } from '@ci/domains/memory';

import { createSyntheticTestUser } from '../../../__tests__/support/applianceUser';
import { databaseAvailability, resolveConnection } from '../../../__tests__/support/databaseConnection';
import { DuplicateDetectStage } from '../clean/DuplicateDetectStage';
import { PersonSelfClaimStage } from '../enrich/PersonSelfClaimStage';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * "SAME PHONE NUMBER" MUST BE ABOUT A NUMBER BOTH PEOPLE CARRY. IN POSTGRES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The report (2026-09-29, full Drive-master corpus): every pending Person pair
 * with phone evidence — 25 of 25 — had the evidence number missing from
 * `ci.entity_identifiers` on at least one side, and the People page showed each
 * side's numbers as "only here" under "Same phone number, but names differ".
 *
 * What this suite pins, on rows the real stages and services wrote:
 *
 *  1. WHERE THE NUMBER COMES FROM. `clean.duplicate_detect`'s phone evidence is
 *     judged from each Person's own `properties` (the vCard's typed `Phones`,
 *     the `phones` key, numeric names) — never from `ci.entity_identifiers`,
 *     which is UNIQUE per (owner, kind, value) and so can never hold one number
 *     for two people. A vCard indexes only its identity key there anyway. The
 *     report's check therefore could not pass for ANY genuinely shared number.
 *  2. The reported 0.85 row's shape, with invented people: two colleagues
 *     whose cards both list the office FAX. The evidence held in the records —
 *     it was a real shared number — and it was still a false proposal. Filed
 *     as a fax, it is no longer evidence, and the stored pair is retired.
 *  3. Evidence that genuinely went STALE (a re-import rewrote one card) is
 *     taken off the queue: rewritten to what still holds, retired when nothing
 *     does — including by the hourly drain, which used to keep a stale exact
 *     item as "Same phone number, but not yet checked".
 *
 * Nothing is committed: one transaction, rolled back in `afterAll`. Opt-in like
 * its neighbours — set `PIPELINE_TEST_DATABASE_URL` (or `DATABASE_URL`) to a
 * migrated database of your OWN: a private `ci/database` container with
 * `yarn workspace @ci/be-api migrate` run against it. Host port 5432 usually
 * belongs to another worktree's stack.
 *
 *   PIPELINE_TEST_DATABASE_URL=postgres://companion:…@127.0.0.1:<port>/companion \
 *     yarn workspace @ci/be-api jest PhoneEvidenceRecheck.integration
 *
 * Every person, number and address here is invented: the 555-01XX fiction
 * range under real area codes, and `.example` mail domains.
 */

const availability = databaseAvailability({ urlEnvVar: 'PIPELINE_TEST_DATABASE_URL' });
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[pipeline/PhoneEvidenceRecheck.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(120_000);

const logger = () =>
  ({ setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }) as never;

interface CandidateRow {
  merge_candidate_id: string;
  score: number;
  status: string;
  evidence: Array<{ kind: string; value: string; score: number }>;
}

describeWithDb(`phone evidence on the review queue holds, or leaves it (${availability.target})`, () => {
  let dataSource: DataSource;
  let runner: QueryRunner;
  let ctx: UserServiceContext;
  let identifiers: EntityIdentifierService;
  let merges: MergeCandidateService;

  /**
   * The colleagues: one law office, main line (212) 555-0110, fax 555-0118.
   * Ada's card lists the main line at her extension and the fax — so her
   * smallest handle, and her identity key, is the FAX. Bo's lists the main
   * line (twice, once typed with +1) and the fax.
   */
  const ada = randomUUID();
  const bo = randomUUID();
  /** A given-name typo pair, as in the report, whose shared number a re-import later drops. */
  const dana = randomUUID();
  const dayna = randomUUID();
  /** A vCard and a number-named stub of one person: an EXACT pair the drain would fold. */
  const elyCard = randomUUID();
  const elyStub = randomUUID();
  /** A pair the records no longer tie, but a message still does. */
  const fay = randomUUID();
  const gus = randomUUID();
  /**
   * Two records of one Ida on a household line that Moe and Lu share too:
   * three identities, so the phone is held back ("shared household line") and
   * the pair also carries its identical-name match.
   */
  const idaCard = randomUUID();
  const idaChat = randomUUID();
  const moe = randomUUID();
  const lu = randomUUID();

  function q<T>(text: string, params?: unknown[]): Promise<T> {
    return runner.query(text, params) as Promise<T>;
  }

  /** A shim for the stages, which take a DataSource and only ever call `query`. */
  const transactional = () =>
    ({ query: (sql: string, params?: unknown[]) => runner.query(sql, params) }) as never;

  async function seedPerson(
    entityId: string,
    name: string,
    properties: Record<string, unknown>,
  ): Promise<void> {
    await q(
      `INSERT INTO ci.entities (entity_id, entity_type, name, properties, owner_user_id, linked_table, linked_id)
       VALUES ($1, 'Person', $2, $3::jsonb, $4, 'import:vcard', $1)`,
      [entityId, name, JSON.stringify(properties), ctx.userId],
    );
  }

  async function setProperties(
    entityId: string,
    properties: Record<string, unknown>,
    name?: string,
  ): Promise<void> {
    await q(`UPDATE ci.entities SET properties = $2::jsonb, name = COALESCE($3, name) WHERE entity_id = $1`, [
      entityId,
      JSON.stringify(properties),
      name ?? null,
    ]);
  }

  /** Index a person's identifiers exactly as `GraphIngestService` does at import: `phones`, first writer wins. */
  async function index(entityId: string, properties: Record<string, unknown>): Promise<number> {
    return identifiers.upsertForEntities(ctx.userId, [
      { entityId, raw: { phones: properties.phones, emails: properties.emails } },
    ]);
  }

  function pair(one: string, two: string): [string, string] {
    return one < two ? [one, two] : [two, one];
  }

  async function candidateFor(one: string, two: string): Promise<CandidateRow | undefined> {
    const [a, b] = pair(one, two);
    const rows = await q<CandidateRow[]>(
      `SELECT merge_candidate_id, score, status, evidence
         FROM ci.merge_candidates
        WHERE owner_user_id = $1 AND entity_type = 'Person' AND entity_id_a = $2 AND entity_id_b = $3`,
      [ctx.userId, a, b],
    );

    return rows[0] == null ? undefined : { ...rows[0], score: Number(rows[0].score) };
  }

  async function detect(ids: string[]): Promise<void> {
    await new PersonSelfClaimStage(transactional(), logger()).run(ctx, ids);
    await new DuplicateDetectStage(transactional(), logger()).run(ctx, ids);
  }

  const office = {
    ada: {
      Names: ['Ada Quill'],
      Emails: ['ada@quill-legal.example'],
      Phones: ['(212) 555-0110;229', '(212) 555-0118'],
      phones: ['2125550118'],
      names: ['Ada Quill'],
    },
    bo: {
      Names: ['Bo Brightwater'],
      Emails: ['bo@quill-legal.example'],
      Phones: ['212-555-0110', '212-555-0118', '+12125550110'],
      phones: ['2125550110'],
      names: ['Bo Brightwater'],
    },
  };

  beforeAll(async () => {
    const connection = resolveConnection({ urlEnvVar: 'PIPELINE_TEST_DATABASE_URL' });

    if (connection == null) {
      throw new Error('databaseAvailability passed but no connection resolved');
    }

    dataSource = new DataSource({
      type: 'postgres',
      ...(connection.url != null
        ? { url: connection.url }
        : {
            host: connection.host,
            port: connection.port,
            username: connection.username,
            password: connection.password,
            database: connection.database,
          }),
      entities: [BaseEntity, PersonEntity, EntityIdentifierEntity],
      synchronize: false,
      logging: false,
      extra: { max: 2 },
    });
    await dataSource.initialize();

    runner = dataSource.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();

    ctx = {
      userId: await createSyntheticTestUser((sql, params) => q(sql, params), 'PhoneEvidenceRecheck'),
    } as never;
    // The owner's region is what lets a national "(212) 555-0118" read as +1.
    await q(`UPDATE ci.users SET timezone = 'America/Los_Angeles' WHERE id = $1`, [ctx.userId]);

    identifiers = new EntityIdentifierService(runner.manager.getRepository(EntityIdentifierEntity), logger());

    const refuseToMerge = {
      mergePeople: jest.fn(async () => {
        throw new Error('this suite never expects a merge');
      }),
    } as unknown as PersonMergeService;
    merges = new MergeCandidateService(runner.manager.getRepository(PersonEntity), logger(), refuseToMerge);

    // Import order: Ada's card first, so she wins the identifier race.
    await seedPerson(ada, 'Ada Quill', office.ada);
    await seedPerson(bo, 'Bo Brightwater', office.bo);
    await index(ada, office.ada);
    await index(bo, office.bo);

    await seedPerson(dana, 'Dana Marsh', { Phones: ['+1 (202) 555-0142'], phones: ['2025550142'] });
    await seedPerson(dayna, 'Dayna Marsh', {
      Phones: ['(202) 555-0131', '(202) 555-0142'],
      phones: ['2025550131'],
    });

    await seedPerson(elyCard, 'Ely Stone', { Phones: ['(202) 555-0150'], phones: ['2025550150'] });
    await seedPerson(elyStub, '+1 (202) 555-0150', { phones: ['2025550150'], phone: '2025550150' });

    await seedPerson(fay, 'Fay Oduya', { Phones: ['(202) 555-0173'], phones: ['2025550173'] });
    await seedPerson(gus, 'Gus Oduya', {
      Phones: ['(202) 555-0173', '(202) 555-0188'],
      phones: ['2025550173'],
    });

    const household = { Phones: ['(202) 555-0164'], phones: ['2025550164'] };
    await seedPerson(idaCard, 'Ida Park', household);
    await seedPerson(idaChat, 'Ida Park', { phones: ['2025550164'] });
    await seedPerson(moe, 'Moe Park', household);
    await seedPerson(lu, 'Lu Park', household);

    await detect([ada, bo, dana, dayna, elyCard, elyStub, fay, gus, idaCard, idaChat, moe, lu]);
  });

  afterAll(async () => {
    if (runner != null) {
      await runner.rollbackTransaction();
      await runner.release();
    }

    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  describe('where the number comes from', () => {
    it('reproduces the reported row: a shared number, held back on names', async () => {
      // The report's 0.85 row, in these colleagues' numbers: detected by
      // clean.duplicate_detect, 0.85, the full E.164 form the adjudicator
      // writes, and the reason it was held for review.
      expect(await candidateFor(ada, bo)).toMatchObject({
        status: 'pending',
        score: 0.85,
        evidence: [
          { kind: 'phone', value: '+12125550118', score: 0.85 },
          { kind: 'phone_check', value: 'given_name_conflict', score: 0 },
        ],
      });
    });

    it('finds it in both records’ properties, never in ci.entity_identifiers', async () => {
      const held = await q<Array<{ entity_id: string; in_index: boolean; in_properties: boolean }>>(
        `SELECT e.entity_id,
                EXISTS (SELECT 1 FROM ci.entity_identifiers ei
                         WHERE ei.owner_user_id = e.owner_user_id AND ei.entity_id = e.entity_id
                           AND ei.kind = 'phone' AND ei.value_normalized = '2125550118') AS in_index,
                EXISTS (SELECT 1 FROM jsonb_array_elements_text(e.properties->'Phones') p
                         WHERE right(regexp_replace(p, '\\D', '', 'g'), 10) = '2125550118') AS in_properties
           FROM ci.entities e
          WHERE e.entity_id = ANY($1::uuid[])`,
        [[ada, bo]],
      );
      const byId = new Map(held.map((row) => [row.entity_id, row]));

      // The report's check: "missing from ci.entity_identifiers on at least
      // one side". True — and it is true of every shared number there is.
      expect(byId.get(ada)).toEqual({ entity_id: ada, in_index: true, in_properties: true });
      expect(byId.get(bo)).toEqual({ entity_id: bo, in_index: false, in_properties: true });
    });

    it('cannot put the number under the second person: the index is first-writer-wins', async () => {
      // Exactly the write GraphIngestService makes. It is not refused loudly —
      // ON CONFLICT DO NOTHING — which is how the gap stayed invisible.
      expect(await index(bo, { phones: ['212-555-0118'] })).toBe(0);

      const [owner] = await q<Array<{ entity_id: string }>>(
        `SELECT entity_id FROM ci.entity_identifiers
          WHERE owner_user_id = $1 AND kind = 'phone' AND value_normalized = '2125550118'`,
        [ctx.userId],
      );
      expect(owner.entity_id).toBe(ada);
    });

    it('is an exact ten-digit match, not a fuzzy one', async () => {
      // Ada's extension line truncates to 5550110229 and Bo's main line is
      // 2125550110: neither is evidence, and neither is in the row.
      const row = await candidateFor(ada, bo);

      expect(row?.evidence.map((item) => item.value)).not.toContain('2125550110');
      expect(JSON.stringify(row?.evidence)).not.toMatch(/5550110229/);
    });

    it('leaves a pair whose number both records still carry exactly as it was', async () => {
      const before = await candidateFor(ada, bo);

      await merges.revalidatePhoneEvidence(ctx, { budgetMs: 30_000 });

      expect(await candidateFor(ada, bo)).toEqual(before);
    });
  });

  describe('the office fax', () => {
    it('is not evidence once the cards file it as a fax, and the stored pair is retired', async () => {
      // What a re-import through the new vCard parser adds: `Faxes` accumulates
      // onto both records.
      await setProperties(ada, { ...office.ada, Faxes: ['(212) 555-0118'] });
      await setProperties(bo, { ...office.bo, Faxes: ['212-555-0118'] });

      const before = await candidateFor(ada, bo);
      const result = await merges.revalidatePhoneEvidence(ctx, { budgetMs: 30_000 });

      expect(before).toBeDefined();
      expect(result.retired).toBeGreaterThanOrEqual(1);
      expect(await candidateFor(ada, bo)).toBeUndefined();
    });

    it('is proposed by nobody on the next sweep either', async () => {
      await new DuplicateDetectStage(transactional(), logger()).run(ctx, [ada, bo]);

      expect(await candidateFor(ada, bo)).toBeUndefined();
    });
  });

  describe('evidence that went stale', () => {
    it('proposed the typo pair on the number both cards listed', async () => {
      expect(await candidateFor(dana, dayna)).toMatchObject({
        score: 0.85,
        evidence: [
          { kind: 'phone', value: '+12025550142', score: 0.85 },
          { kind: 'phone_check', value: 'given_name_conflict', score: 0 },
        ],
      });
    });

    it('retires the pair once a re-import drops the number from one card, and the page stops showing it', async () => {
      await setProperties(dayna, { Phones: ['(202) 555-0131'], phones: ['2025550131'] });

      const result = await merges.revalidatePhoneEvidence(ctx, { budgetMs: 30_000 });

      // The number was the pair's only evidence: nothing is left to ask.
      expect(result.retired).toBeGreaterThanOrEqual(1);
      expect(await candidateFor(dana, dayna)).toBeUndefined();

      const page = await merges.findCandidates(ctx, { includePhone: true, includeProfileUrl: true });
      const shownIds = page.candidates.flatMap((candidate) => candidate.people.map((person) => person.id));
      expect(shownIds).not.toContain(dayna);
      // The page does hydrate people by these ids — the check above has teeth.
      expect(shownIds).toContain(fay);
    });

    it('rewrites a pair down to the evidence that still holds', async () => {
      expect(await candidateFor(idaCard, idaChat)).toMatchObject({
        score: 0.85,
        evidence: [
          { kind: 'phone', value: '+12025550164', score: 0.85 },
          { kind: 'name_overlap', value: 'park', score: 0.58 },
          { kind: 'name', value: 'ida park', score: 0.5 },
          { kind: 'phone_check', value: 'shared_line', score: 0 },
        ],
      });

      // The chat record no longer carries the household number.
      await setProperties(idaChat, {});
      await merges.revalidatePhoneEvidence(ctx, { budgetMs: 30_000 });

      // Still two records called "Ida Park" — a real question, at the name
      // tier, with no phone claim left on it.
      expect(await candidateFor(idaCard, idaChat)).toMatchObject({
        status: 'pending',
        score: 0.58,
        evidence: [
          { kind: 'name_overlap', value: 'park', score: 0.58 },
          { kind: 'name', value: 'ida park', score: 0.5 },
        ],
      });
    });

    it('keeps a number the records no longer share while a message still ties both people to it', async () => {
      // Gus's card is re-imported without Fay's number — but an SMS from it
      // resolved to Gus. That observation still stands; the self claims the
      // records were copied into do not.
      expect(await candidateFor(fay, gus)).toBeDefined();

      await setProperties(gus, { Phones: ['(202) 555-0188'], phones: ['2025550188'] });
      await q(
        `INSERT INTO ci.identifier_claims
           (owner_user_id, subject_type, subject_id, role, kind, value_normalized, entity_id, confidence, stage)
         VALUES ($1, 'communication', $2, 'from', 'phone', '2025550173', $3, 0.85, 'spec')`,
        [ctx.userId, randomUUID(), gus],
      );

      await merges.revalidatePhoneEvidence(ctx, { budgetMs: 30_000 });

      const row = await candidateFor(fay, gus);
      expect(row?.evidence).toEqual(
        expect.arrayContaining([expect.objectContaining({ kind: 'phone', value: '+12025550173' })]),
      );
      expect(Math.max(...(row?.evidence ?? []).map((item) => item.score))).toBeLessThan(0.95);
    });
  });

  describe('the hourly drain', () => {
    it('proposed the stub and the card as an exact pair', async () => {
      expect(await candidateFor(elyCard, elyStub)).toMatchObject({
        score: 0.95,
        evidence: [{ kind: 'phone', value: '+12025550150', score: 0.95 }],
      });
    });

    it('retires the exact pair when the records stop sharing the number, stale self claims notwithstanding', async () => {
      // The stub's record now carries another number. enrich.person_self_claim
      // copied the old one into ci.identifier_claims and never retracts it —
      // the drain used to keep this row as an 0.85 "Same phone number, but not
      // yet checked against both records", and a claim-only re-check would
      // have kept it on the strength of that copy.
      await setProperties(elyStub, { phones: ['2025550199'], phone: '2025550199' }, '+1 (202) 555-0199');

      const [staleSelfClaim] = await q<Array<{ count: number }>>(
        `SELECT count(*)::int AS count FROM ci.identifier_claims
          WHERE owner_user_id = $1 AND entity_id = $2 AND role = 'self' AND value_normalized = '2025550150'`,
        [ctx.userId, elyStub],
      );
      expect(staleSelfClaim.count).toBe(1);

      const result = await merges.autoMergeDeterministicPairs(ctx, { budgetMs: 30_000 });

      expect(result).toMatchObject({ merged: 0, retired: 1 });
      expect(await candidateFor(elyCard, elyStub)).toBeUndefined();
    });
  });

  describe('self claims track the record', () => {
    async function selfClaims(entityId: string): Promise<string[]> {
      const rows = await q<Array<{ value_normalized: string }>>(
        `SELECT value_normalized FROM ci.identifier_claims
          WHERE owner_user_id = $1 AND subject_id = $2 AND role = 'self' AND kind = 'phone'
          ORDER BY value_normalized`,
        [ctx.userId, entityId],
      );

      return rows.map((row) => row.value_normalized);
    }

    it('retracts a self claim the record no longer states, and keeps one a human disposed', async () => {
      // A rejection is a decision about the identifier: it outlives the record.
      await q(
        `INSERT INTO ci.identifier_claims
           (owner_user_id, subject_type, subject_id, role, kind, value_normalized, entity_id, confidence,
            stage, disposition, disposed_at)
         VALUES ($1, 'person', $2, 'self', 'phone', '2025550111', $2, 1.0, 'spec', 'rejected', now())`,
        [ctx.userId, elyStub],
      );
      expect(await selfClaims(elyStub)).toEqual(['2025550111', '2025550150']);

      await new PersonSelfClaimStage(transactional(), logger()).run(ctx, [elyStub]);

      expect(await selfClaims(elyStub)).toEqual(['2025550111', '2025550199']);
    });

    it('never retracts a claim another producer wrote in the same person/self shape', async () => {
      // The claims table reserves `person` / `self` for a contact importer's
      // own assertions too; only this stage's rows are this stage's to take back.
      await q(
        `INSERT INTO ci.identifier_claims
           (owner_user_id, subject_type, subject_id, role, kind, value_normalized, entity_id, confidence, stage)
         VALUES ($1, 'person', $2, 'self', 'phone', '2025550112', $2, 1.0, 'import:contacts')`,
        [ctx.userId, elyStub],
      );

      await new PersonSelfClaimStage(transactional(), logger()).run(ctx, [elyStub]);

      expect(await selfClaims(elyStub)).toEqual(['2025550111', '2025550112', '2025550199']);
    });
  });

  /**
   * The upgrade path, end to end: a contact card imported while staging kept
   * one handle per card, so its email never reached `emails` — and a mail stub
   * minted for that very address. Migration 20260930022046 repairs the card
   * from its own `Emails`, the self claims follow, and the detector proposes
   * the pair on the email: the deterministic tier the drain folds. Before, the
   * most anything tied them was a surname token in the stub's address — a 0.55
   * question for a human, where the identity was an exact email all along.
   */
  describe('a contact card imported before its email was indexed', () => {
    const hana = randomUUID();
    const hanaStub = randomUUID();

    function migrationUp(): string {
      const file = path.resolve(
        __dirname,
        '../../../../../db/postgres/migrations/20260930022046_index_contact_card_emails_and_phones.sql',
      );
      const sql = readFileSync(file, 'utf8');

      return sql.slice(sql.indexOf('-- migrate:up') + '-- migrate:up'.length, sql.indexOf('-- migrate:down'));
    }

    it('is proposed with the stub on the email once the migration has run', async () => {
      // The pre-fix push: the phone sorted first, so it was the only handle.
      await seedPerson(hana, 'Hana Obi', {
        Emails: ['hana@obi.example'],
        Phones: ['(202) 555-0180'],
        phones: ['2025550180'],
        phone: '2025550180',
      });
      await seedPerson(hanaStub, 'hana@obi.example', {
        emails: ['hana@obi.example'],
        email: 'hana@obi.example',
      });

      await detect([hana, hanaStub]);
      const before = await candidateFor(hana, hanaStub);
      expect(before?.evidence.some((item) => item.kind === 'email') ?? false).toBe(false);
      expect(before?.score ?? 0).toBeLessThan(0.95);

      await q(migrationUp());
      await detect([hana, hanaStub]);

      expect(await candidateFor(hana, hanaStub)).toMatchObject({
        score: 0.95,
        evidence: expect.arrayContaining([{ kind: 'email', value: 'hana@obi.example', score: 0.95 }]),
      });
    });
  });

  /**
   * With every card email indexed, a card that lists the OWNER's address
   * under someone else's name shares a mailbox with the self Person — the
   * deterministic tier, folded without asking, into "you". A real export has
   * one: named for a friend, listing the friend's address and the owner's.
   */
  describe("the owner's address on someone else's card", () => {
    const ivy = randomUUID();
    const joCard = randomUUID();
    const ivyStub = randomUUID();

    it('is held for review, and the owner’s own mail stub still folds', async () => {
      await seedPerson(ivy, 'Ivy Ren', { emails: ['ivy@ren.example'], email: 'ivy@ren.example' });
      await q(`UPDATE ci.users SET entity_id = $2 WHERE id = $1`, [ctx.userId, ivy]);
      await seedPerson(joCard, 'Jo Sato', {
        Emails: ['jo@sato.example', 'ivy@ren.example'],
        emails: ['jo@sato.example', 'ivy@ren.example'],
        email: 'jo@sato.example',
      });
      await seedPerson(ivyStub, 'ivy@ren.example', { emails: ['ivy@ren.example'], email: 'ivy@ren.example' });

      await detect([ivy, joCard, ivyStub]);

      expect(await candidateFor(ivy, joCard)).toMatchObject({
        score: 0.85,
        evidence: expect.arrayContaining([
          { kind: 'email', value: 'ivy@ren.example', score: 0.85 },
          { kind: 'email_check', value: 'self_endpoint', score: 0 },
        ]),
      });
      const stubPair = await candidateFor(ivy, ivyStub);
      expect(stubPair).toMatchObject({
        score: 0.95,
        evidence: expect.arrayContaining([{ kind: 'email', value: 'ivy@ren.example', score: 0.95 }]),
      });
      expect(stubPair?.evidence.some((item) => item.kind === 'email_check')).toBe(false);

      // The drain never selects the held pair; the queue shows it.
      const page = await merges.findCandidates(ctx, { includePhone: true, includeProfileUrl: true });
      const shown = page.candidates.find((candidate) =>
        candidate.people.some((person) => person.id === joCard),
      );
      expect(shown?.evidence).toEqual(
        expect.arrayContaining([{ kind: 'email_check', value: 'self_endpoint', score: 0 }]),
      );
      expect(
        page.candidates.some((candidate) => candidate.people.some((person) => person.id === ivyStub)),
      ).toBe(false);
    });
  });

  /**
   * The owner's own contact cards are ordinary Persons — the self Person is
   * minted from the account, not from a card — so a friend's card listing the
   * owner's address meets them as two contacts, and the self-endpoint hold
   * never sees it. Their names share nothing; a mailbox alone must not
   * overrule that. The real export's friend card sits beside two of the
   * owner's cards exactly like this.
   */
  describe("the owner's address on a friend's card, against the owner's own cards", () => {
    const kaiCard = randomUUID();
    const kaiCardToo = randomUUID();
    const lumiCard = randomUUID();

    it("holds the friend for review, and the owner's two cards still fold", async () => {
      const kai = { Emails: ['kai@mori.example'], emails: ['kai@mori.example'], email: 'kai@mori.example' };
      await seedPerson(kaiCard, 'Kai D Mori', kai);
      await seedPerson(kaiCardToo, 'Kai Mori', kai);
      await seedPerson(lumiCard, 'Lumi Park', {
        Emails: ['lumi@park.example', 'kai@mori.example'],
        emails: ['lumi@park.example', 'kai@mori.example'],
        email: 'lumi@park.example',
      });

      await detect([kaiCard, kaiCardToo, lumiCard]);

      const held = { kind: 'email_check', value: 'name_conflict', score: 0 };

      for (const card of [kaiCard, kaiCardToo]) {
        expect(await candidateFor(card, lumiCard)).toMatchObject({
          score: 0.85,
          evidence: expect.arrayContaining([{ kind: 'email', value: 'kai@mori.example', score: 0.85 }, held]),
        });
      }

      const ownCards = await candidateFor(kaiCard, kaiCardToo);
      expect(ownCards).toMatchObject({
        score: 0.95,
        evidence: expect.arrayContaining([{ kind: 'email', value: 'kai@mori.example', score: 0.95 }]),
      });
      expect(ownCards?.evidence.some((item) => item.kind === 'email_check')).toBe(false);

      // The queue shows the friend, labelled; the owner's cards are the drain's to fold.
      const page = await merges.findCandidates(ctx, { includePhone: true, includeProfileUrl: true });
      const withLumi = page.candidates.filter((candidate) =>
        candidate.people.some((person) => person.id === lumiCard),
      );
      expect(withLumi.length).toBeGreaterThan(0);
      for (const candidate of withLumi) {
        expect(candidate.evidence).toEqual(expect.arrayContaining([held]));
      }

      expect(
        page.candidates.some(
          (candidate) =>
            candidate.people.length === 2 &&
            candidate.people.every((person) => person.id === kaiCard || person.id === kaiCardToo),
        ),
      ).toBe(false);
    });
  });
});
