import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import type { UserServiceContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';
import { PersonEntity, PersonMergeService } from '@ci/domains/memory';

import { databaseAvailability, resolveConnection } from '../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock, type SchemaLock } from '../../__tests__/support/schemaLock';
import { IdentifierArrivalService } from '../services/IdentifierArrivalService';
import { PipelineStateService } from '../services/PipelineStateService';
import { DuplicateDetectStage } from '../stages/clean/DuplicateDetectStage';
import { PersonSelfClaimStage } from '../stages/enrich/PersonSelfClaimStage';
import type { Stage } from '../types';

/**
 * A merge moves the merged-away card's evidence onto the survivor, and the
 * survivor is re-examined — against Postgres.
 *
 * Three copies of one contact. The survivor and the source share an address,
 * which is how they come to be merged; the source's card also lists a work
 * address, and the third copy — a nameless row, so the name pass cannot pair
 * it — holds only that work address. Before the fix the source's claims stayed
 * on the tombstone, the detector's holder join (live people only) dropped
 * them, the detector's pre-merge source~third pair became moot, and nothing
 * re-examined the survivor: the third copy was never proposed against it.
 *
 * And one stranger: the source's card also lists a home address a different
 * person holds, and a human has already said the source is not them. Once the
 * survivor holds the source's claims that "no" must hold for the survivor too,
 * or its re-examination re-proposes the pair.
 *
 * Every statement here is real — the merge's transaction, both stages, the
 * ledger, and the merge-survivor re-open — because the parts this pins are
 * SQL: an UPDATE that must not collide with the observation key, an EXISTS
 * that interpolates a stage's predicate written in bare column names, and a
 * detector whose holder join decides what counts as evidence.
 *
 * Opt-in like the sibling integration specs: set PIPELINE_TEST_DATABASE_URL.
 */
const availability = databaseAvailability({ urlEnvVar: 'PIPELINE_TEST_DATABASE_URL' });
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[pipeline/mergeSurvivorEvidence.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

const SHARED_ADDRESS = 'wren@example.net';
const WORK_ADDRESS = 'wren.adair@work.example';
const HOME_ADDRESS = 'home@adair.example';
const REJECTED_ADDRESS = 'desk@example.net';

interface Corpus {
  userId: string;
  ctx: UserServiceContext;
  survivor: string;
  source: string;
  third: string;
  stranger: string;
  message: string;
}

interface ClaimRow {
  subject_type: string;
  subject_id: string;
  role: string;
  kind: string;
  value_normalized: string;
  entity_id: string;
  disposition: string | null;
  disposed_at: Date | null;
}

describeWithDb(`merge survivor evidence against Postgres (${availability.target})`, () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let state: PipelineStateService;
  let selfClaim: PersonSelfClaimStage;
  let detect: DuplicateDetectStage;
  let arrival: IdentifierArrivalService;
  let merger: PersonMergeService;
  const users: string[] = [];

  const logger = {
    setContext: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    verbose: jest.fn(),
  } as unknown as LoggerService;

  const pairKey = (a: string, b: string) => [a, b].sort().join('~');

  /** Run a stage over `ids` and record its answers on the ledger, as the worker does. */
  async function sweep(stage: Stage, corpus: Corpus, ids: string[]): Promise<void> {
    // Under the entity_type the stage DECLARES, as PipelineSliceListener
    // insists — 'Person' for the self-claim stage, 'entity' for the detector.
    // claim() itself would take any string, and a test that used one type for
    // both would write detector rows under a key production never uses.
    const [entityType] = stage.entityTypes;
    const claimed = await state.claim(stage, entityType, ids, corpus.userId);
    await state.complete(stage, entityType, await stage.run(corpus.ctx, claimed));
  }

  async function seedCorpus(): Promise<Corpus> {
    const userId = uuidv7();
    const corpus: Corpus = {
      userId,
      ctx: { userId } as UserServiceContext,
      survivor: uuidv7(),
      source: uuidv7(),
      third: uuidv7(),
      stranger: uuidv7(),
      message: uuidv7(),
    };
    users.push(userId);

    await dataSource.query(`INSERT INTO ci.users (id, name, email, timezone) VALUES ($1, $2, $3, 'UTC')`, [
      userId,
      'Merge survivor fixture',
      `owner.${userId}@example.invalid`,
    ]);

    for (const [id, name, emails] of [
      [corpus.survivor, 'Wren Adair', [SHARED_ADDRESS]],
      [corpus.source, 'Wren A.', [SHARED_ADDRESS, WORK_ADDRESS, HOME_ADDRESS]],
      [corpus.third, null, [WORK_ADDRESS]],
      [corpus.stranger, 'Robin Vale', [HOME_ADDRESS]],
    ] as const) {
      await dataSource.query(
        `INSERT INTO ci.entities (entity_id, entity_type, name, properties, owner_user_id)
         VALUES ($1, 'Person', $2, $3::jsonb, $4)`,
        [id, name, JSON.stringify({ emails }), userId],
      );
    }

    // A message recipient enrich.person_link resolved to the source, which a
    // human then rejected. It must move with the person, and stay rejected.
    await dataSource.query(
      `INSERT INTO ci.identifier_claims
              (owner_user_id, subject_type, subject_id, role, kind, value_normalized,
               entity_id, confidence, method, stage, disposition, disposed_at)
       VALUES ($1, 'communication', $2, 'to', 'email', $3, $4, 0.9, 'email_exact',
               'enrich.person_link', 'rejected', '2026-09-01T00:00:00Z')`,
      [userId, corpus.message, REJECTED_ADDRESS, corpus.source],
    );

    // "Wren A. is not Robin Vale", as rejectPersonDuplicates records it.
    await dataSource.query(
      `INSERT INTO ci.entity_merge_blocks (owner_user_id, entity_id_a, entity_id_b, reason)
       VALUES ($1, LEAST($2::uuid, $3::uuid), GREATEST($2::uuid, $3::uuid), 'user_rejected')`,
      [userId, corpus.source, corpus.stranger],
    );

    const everyone = [corpus.survivor, corpus.source, corpus.third, corpus.stranger];
    await sweep(selfClaim, corpus, everyone);
    await sweep(detect, corpus, everyone);

    return corpus;
  }

  async function pairs(userId: string): Promise<Map<string, Array<{ kind: string; value: string }>>> {
    const rows: Array<{
      entity_id_a: string;
      entity_id_b: string;
      evidence: Array<{ kind: string; value: string }>;
    }> = await dataSource.query(
      `SELECT entity_id_a, entity_id_b, evidence FROM ci.merge_candidates
          WHERE owner_user_id = $1 AND status = 'pending'`,
      [userId],
    );

    return new Map(rows.map((row) => [pairKey(row.entity_id_a, row.entity_id_b), row.evidence]));
  }

  async function versions(userId: string, stage: Stage): Promise<Record<string, number>> {
    const rows: Array<{ entity_id: string; stage_version: number }> = await dataSource.query(
      `SELECT entity_id, stage_version FROM ci.pipeline_state
        WHERE user_id = $1 AND stage = $2 AND entity_type = ANY($3::text[])`,
      [userId, stage.id, [...stage.entityTypes]],
    );

    return Object.fromEntries(rows.map((row) => [row.entity_id, Number(row.stage_version)]));
  }

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
    });
    await dataSource.initialize();
    schemaLock = await acquireSchemaWriteLock(dataSource, 'pipeline/mergeSurvivorEvidence.integration');

    state = new PipelineStateService(dataSource, logger);
    selfClaim = new PersonSelfClaimStage(dataSource, logger);
    detect = new DuplicateDetectStage(dataSource, logger);
    // The real stages, so the re-open reads their real declarations.
    const stages = new Map<string, Stage>([
      [selfClaim.id, selfClaim],
      [detect.id, detect],
    ]);
    arrival = new IdentifierArrivalService(
      dataSource,
      state,
      { get: (stageId: string) => stages.get(stageId) } as never,
      logger,
    );
    merger = new PersonMergeService(
      {
        manager: dataSource.manager,
        // The merge's last step reads the target back for its return value;
        // what it returns is not under test here.
        findOne: jest.fn(async () =>
          Object.assign(new PersonEntity(), {
            id: uuidv7(),
            entityType: 'Person',
            properties: {},
            isActive: true,
            mergedIntoEntityId: null,
          }),
        ),
      } as never,
      logger,
      { send: jest.fn(async () => []) } as never,
      { recordMany: jest.fn(async () => undefined) } as never,
    );
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.query('DELETE FROM ci.merge_candidates WHERE owner_user_id = ANY($1)', [users]);
      await dataSource.query('DELETE FROM ci.entity_merge_blocks WHERE owner_user_id = ANY($1)', [users]);
      await dataSource.query('DELETE FROM ci.identifier_claims WHERE owner_user_id = ANY($1)', [users]);
      await dataSource.query('DELETE FROM ci.entity_merges WHERE owner_user_id = ANY($1)', [users]);
      await dataSource.query('DELETE FROM ci.pipeline_state WHERE user_id = ANY($1)', [users]);
      await dataSource.query('DELETE FROM ci.entities WHERE owner_user_id = ANY($1)', [users]);
      await dataSource.query('DELETE FROM ci.users WHERE id = ANY($1)', [users]);
      await schemaLock?.release();
      await dataSource.destroy();
    }
  });

  it("moves the source's claims onto the survivor, re-opens the survivor, and its re-examination finds the third copy", async () => {
    const corpus = await seedCorpus();
    const { userId, survivor, source, third, stranger } = corpus;

    // Before the merge: survivor~source on the shared address, source~third on
    // the work address — nothing between the survivor and the third copy, and
    // nothing between the source and the stranger, whom a human ruled out.
    const before = await pairs(userId);
    expect([...before.keys()].sort()).toEqual([pairKey(survivor, source), pairKey(source, third)].sort());

    const claimsBefore: ClaimRow[] = await dataSource.query(
      `SELECT subject_type, subject_id, role, kind, value_normalized, entity_id, disposition, disposed_at
         FROM ci.identifier_claims WHERE owner_user_id = $1 AND entity_id = $2
        ORDER BY subject_type, kind, value_normalized`,
      [userId, source],
    );
    // The source's name and three addresses from its own card, and the rejected recipient.
    expect(claimsBefore).toHaveLength(5);

    await merger.mergePeople(corpus.ctx, [source], survivor);

    // Every claim that resolved to the source now resolves to the survivor,
    // observed exactly where it was, the rejection and its instant included.
    const claimsAfter: ClaimRow[] = await dataSource.query(
      `SELECT subject_type, subject_id, role, kind, value_normalized, entity_id, disposition, disposed_at
         FROM ci.identifier_claims
        WHERE owner_user_id = $1 AND (subject_id = $2 OR subject_type = 'communication')
        ORDER BY subject_type, kind, value_normalized`,
      [userId, source],
    );
    expect(claimsAfter).toEqual(claimsBefore.map((row) => ({ ...row, entity_id: survivor })));

    const [audit]: Array<{ details: { counts: { claims: number; blocksCarried: number } } }> =
      await dataSource.query(
        `SELECT details FROM ci.entity_merges WHERE owner_user_id = $1 AND source_entity_id = $2`,
        [userId, source],
      );
    expect(audit.details.counts).toEqual(expect.objectContaining({ claims: 5, blocksCarried: 1 }));

    // "Not Robin Vale" now holds for the survivor, and the source's own row stays.
    const blocks: Array<{ pair: string; reason: string }> = await dataSource.query(
      `SELECT entity_id_a || '~' || entity_id_b AS pair, reason
         FROM ci.entity_merge_blocks WHERE owner_user_id = $1`,
      [userId],
    );
    // Sorted here, not in SQL: the database collation need not order uuid text as JS does.
    const byPair = (x: { pair: string }, y: { pair: string }) => (x.pair < y.pair ? -1 : 1);
    expect(blocks.sort(byPair)).toEqual(
      [
        { pair: pairKey(source, stranger), reason: 'user_rejected' },
        { pair: pairKey(survivor, stranger), reason: 'user_rejected' },
      ].sort(byPair),
    );

    // The source~third pair was graded against a person who is now a tombstone.
    // The survivor's decisions predate the merge: both are re-opened, and only
    // the survivor's — the tombstone no longer applies, the third copy was not
    // merged into.
    const selfClaimDecided = await versions(userId, selfClaim);
    const detectDecided = await versions(userId, detect);

    await arrival.reopenForUser(userId);

    expect(await versions(userId, selfClaim)).toEqual({ ...selfClaimDecided, [survivor]: 0 });
    expect(await versions(userId, detect)).toEqual({ ...detectDecided, [survivor]: 0 });

    // The re-opened sweep re-examines the survivor.
    await sweep(detect, corpus, [survivor]);

    const after = await pairs(userId);
    expect(after.get(pairKey(survivor, third))).toEqual([
      expect.objectContaining({ kind: 'email', value: WORK_ADDRESS }),
    ]);
    // The survivor holds the home address now too, and the stranger is still
    // not proposed: the human's "no" came across with the claims.
    expect(after.has(pairKey(survivor, stranger))).toBe(false);

    // That evidence is the source's claim, now the survivor's: the survivor's
    // own card never listed the work address, and its self claims have not been
    // re-derived from the folded card yet.
    const ownClaims: Array<{ value_normalized: string }> = await dataSource.query(
      `SELECT value_normalized FROM ci.identifier_claims
        WHERE owner_user_id = $1 AND subject_id = $2 AND kind = 'email'`,
      [userId, survivor],
    );
    expect(ownClaims.map((row) => row.value_normalized)).toEqual([SHARED_ADDRESS]);
  });

  it('re-opens a decision recorded within a lease of the merge once more, and one recorded after it never', async () => {
    const corpus = await seedCorpus();
    const { userId, survivor, source } = corpus;

    await merger.mergePeople(corpus.ctx, [source], survivor);
    await arrival.reopenForUser(userId);
    expect((await versions(userId, detect))[survivor]).toBe(0);

    // Re-decided seconds after the merge began: inside the margin for a slice
    // that read the survivor while the merge was still committing, so it is
    // re-opened once more.
    await sweep(detect, corpus, [survivor]);
    expect((await versions(userId, detect))[survivor]).toBe(detect.version);
    await arrival.reopenForUser(userId);
    expect((await versions(userId, detect))[survivor]).toBe(0);

    // A merge an hour older than the decision: the decision saw it.
    await sweep(detect, corpus, [survivor]);
    await dataSource.query(
      `UPDATE ci.entity_merges SET created_at = now() - interval '1 hour' WHERE owner_user_id = $1`,
      [userId],
    );
    await arrival.reopenForUser(userId);
    expect((await versions(userId, detect))[survivor]).toBe(detect.version);
  });

  it('leaves the survivor of a merge that predates carrying evidence to the next version bump', async () => {
    const corpus = await seedCorpus();
    const { userId, survivor, source } = corpus;

    await merger.mergePeople(corpus.ctx, [source], survivor);
    // What a merge recorded before merges re-pointed claims and carried
    // blocks looks like in the log: no blocksCarried count.
    await dataSource.query(
      `UPDATE ci.entity_merges SET details = details #- '{counts,blocksCarried}' WHERE owner_user_id = $1`,
      [userId],
    );

    const selfClaimDecided = await versions(userId, selfClaim);
    const detectDecided = await versions(userId, detect);

    await arrival.reopenForUser(userId);

    expect(await versions(userId, selfClaim)).toEqual(selfClaimDecided);
    expect(await versions(userId, detect)).toEqual(detectDecided);
  });
});
