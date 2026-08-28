import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import type { UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import {
  BaseEntity,
  EntityMergeBlockEntity,
  EntityMergeBlockService,
  ItemEntity,
  ObjectDuplicateService,
} from '@ci/domains/memory';

import { databaseAvailability, resolveConnection } from '../../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';
import {
  CLEAN_OBJECT_DUPLICATE_DETECT_STAGE_ID,
  ObjectDuplicateDetectStage,
} from '../clean/ObjectDuplicateDetectStage';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE PROPOSAL IS REAL, AND IT IS ONLY A PROPOSAL. IN POSTGRES.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `ObjectDuplicateService.findDuplicateGroups` is ~90 lines of SQL — three
 * union rungs, a `jsonb_each_text` lateral, a grouped `HAVING`, a truncating
 * `array_agg`. A stubbed `manager.query` returning hand-written rows would
 * assert this file's own fixtures and would have caught none of the four things
 * below, all of which are properties of rows rather than of statements:
 *
 *  1. two genuinely duplicate units produce a `ci.merge_candidates` row, under
 *     an `entity_type` the readers of that table can actually resolve;
 *  2. a pair the user has recorded in `ci.entity_merge_blocks` produces none;
 *  3. running the same slice twice produces the same one row — the unique index
 *     and the `ON CONFLICT` clause are what make a nightly sweep safe;
 *  4. NOTHING IS MERGED. Not a `merged_into_object_id`, not a
 *     `merged_into_entity_id`, not an `ci.entity_merges` row. CLEAN proposes.
 *
 * Opt-in exactly like its neighbours: set `PIPELINE_TEST_DATABASE_URL` (or the
 * `DATABASE_*` variables) to a database with the migrations applied. The suite
 * SKIPS legibly when nothing is reachable rather than failing every test on a
 * connection error.
 *
 *   DATABASE_PORT=57122 yarn workspace @ci/be-api jest ObjectDuplicateDetectStage.integration
 */

const availability = databaseAvailability({ urlEnvVar: 'PIPELINE_TEST_DATABASE_URL' });
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[pipeline/ObjectDuplicateDetectStage.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

describeWithDb(`clean.object_duplicate_detect proposes and never merges (${availability.target})`, () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let stage: ObjectDuplicateDetectStage;
  let duplicates: ObjectDuplicateService;

  const ctx = { userId: uuidv7() } as UserServiceContext;

  /**
   * The fixture, chosen so the two shapes that actually break a detector are
   * both present:
   *
   *  - `twinOne` / `twinTwo` share an ASIN AND a brand+model+day, so the
   *    detector returns TWO groups containing the same pair (their member sets
   *    differ, so its strictly-weaker suppression does not collapse them);
   *  - `cousin` shares only the brand+model+day, so it is proposed against both
   *    twins and against neither by identifier;
   *  - `blockedOne` / `blockedTwo` share an ASIN and are recorded in
   *    `ci.entity_merge_blocks`;
   *  - `loner` carries a perfectly good identifier nobody else has.
   */
  const ids = {
    twinOne: uuidv7(),
    twinTwo: uuidv7(),
    cousin: uuidv7(),
    blockedOne: uuidv7(),
    blockedTwo: uuidv7(),
    loner: uuidv7(),
  };

  const ACQUIRED_AT = '2026-01-02T10:00:00Z';

  async function insertUnit(
    objectId: string,
    unit: { name: string; asin: string; brand: string | null; model: string | null },
  ): Promise<void> {
    await dataSource.query(
      `INSERT INTO ci.entities (entity_id, entity_type, name, owner_user_id, linked_table, linked_id)
       VALUES ($1::uuid, 'Item', $2, $3::uuid, 'objects', $1::uuid)`,
      [objectId, unit.name, ctx.userId],
    );
    await dataSource.query(
      `INSERT INTO ci.objects (object_id, user_id, entity_type, identifier_codes, brand, model, acquired_at)
       VALUES ($1::uuid, $2::uuid, 'Item', $3::jsonb, $4, $5, $6::timestamptz)`,
      [objectId, ctx.userId, JSON.stringify({ asin: unit.asin }), unit.brand, unit.model, ACQUIRED_AT],
    );
  }

  function pendingCandidates(): Promise<
    Array<{
      entity_id_a: string;
      entity_id_b: string;
      entity_type: string;
      score: number;
      status: string;
      detected_by: string;
      detector_version: number;
      evidence: Array<{ kind: string; value: string; score: number }>;
    }>
  > {
    return dataSource.query(
      `SELECT entity_id_a, entity_id_b, entity_type, score, status, detected_by, detector_version, evidence
         FROM ci.merge_candidates
        WHERE owner_user_id = $1::uuid
        ORDER BY score DESC, entity_id_a, entity_id_b`,
      [ctx.userId],
    );
  }

  /** `[a, b]` in the order the `CHECK (entity_id_a < entity_id_b)` demands. */
  function pair(one: string, two: string): [string, string] {
    return one < two ? [one, two] : [two, one];
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
      entities: [ItemEntity, BaseEntity, EntityMergeBlockEntity],
    });
    await dataSource.initialize();

    schemaLock = await acquireSchemaWriteLock(dataSource, 'pipeline/ObjectDuplicateDetectStage.integration');

    await dataSource.query(
      `INSERT INTO ci.users (id, name, email) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
      [ctx.userId, 'Object duplicate spec fixture', `objdupe.${ctx.userId}@example.invalid`],
    );

    await insertUnit(ids.twinOne, { name: 'Acme X1', asin: 'B00ACMEX11', brand: 'Acme', model: 'X1' });
    await insertUnit(ids.twinTwo, { name: 'Acme X1', asin: 'B00ACMEX11', brand: 'Acme', model: 'X1' });
    await insertUnit(ids.cousin, { name: 'Acme X1 spare', asin: 'B00COUSIN1', brand: 'Acme', model: 'X1' });
    await insertUnit(ids.blockedOne, { name: 'Nope one', asin: 'B00BLOCKED', brand: null, model: null });
    await insertUnit(ids.blockedTwo, { name: 'Nope two', asin: 'B00BLOCKED', brand: null, model: null });
    await insertUnit(ids.loner, { name: 'Only one of these', asin: 'B00LONER01', brand: null, model: null });

    const [blockA, blockB] = pair(ids.blockedOne, ids.blockedTwo);

    await dataSource.query(
      `INSERT INTO ci.entity_merge_blocks (owner_user_id, entity_id_a, entity_id_b, reason)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'user_rejected')`,
      [ctx.userId, blockA, blockB],
    );

    const logger = new LoggerService();
    duplicates = new ObjectDuplicateService(
      dataSource.getRepository(ItemEntity),
      new EntityMergeBlockService(dataSource.getRepository(EntityMergeBlockEntity), new LoggerService()),
      new LoggerService(),
    );

    stage = new ObjectDuplicateDetectStage(dataSource, duplicates, logger);
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.query('DELETE FROM ci.merge_candidates WHERE owner_user_id = $1', [ctx.userId]);
      await dataSource.query('DELETE FROM ci.entity_merge_blocks WHERE owner_user_id = $1', [ctx.userId]);
      await dataSource.query(
        'DELETE FROM ci.pipeline_state WHERE stage = $1 AND entity_id = ANY($2::uuid[])',
        [CLEAN_OBJECT_DUPLICATE_DETECT_STAGE_ID, Object.values(ids)],
      );
      await dataSource.query('DELETE FROM ci.objects WHERE user_id = $1', [ctx.userId]);
      await dataSource.query('DELETE FROM ci.entities WHERE owner_user_id = $1', [ctx.userId]);
      await dataSource.query('DELETE FROM ci.users WHERE id = $1', [ctx.userId]);
      await schemaLock?.release();
      await dataSource.destroy();
    }
  });

  it('proposes the duplicate pair, with the evidence that produced it', async () => {
    const results = await stage.run(ctx, Object.values(ids));

    const rows = await pendingCandidates();
    const [twinA, twinB] = pair(ids.twinOne, ids.twinTwo);
    const proposed = rows.find((row) => row.entity_id_a === twinA && row.entity_id_b === twinB);

    expect(proposed).toBeDefined();
    expect(Number(proposed?.score)).toBe(0.8);
    expect(proposed?.status).toBe('pending');
    expect(proposed?.detected_by).toBe(CLEAN_OBJECT_DUPLICATE_DETECT_STAGE_ID);
    expect(proposed?.evidence.map((item) => item.kind)).toEqual(['identifier', 'brand_model']);
    expect(proposed?.evidence[0].value).toBe('B00ACMEX11');

    // The weaker brand+model+day evidence still proposes the cousin against
    // both twins — a real answer, at a real (lower) score.
    expect(rows).toHaveLength(3);
    expect(rows.filter((row) => Number(row.score) === 0.55)).toHaveLength(2);

    expect(results.get(ids.twinOne)).toEqual({
      outcome: 'done',
      detail: { candidates: 2, truncated: false },
    });
    expect(results.get(ids.loner)).toEqual({ outcome: 'done', detail: { candidates: 0, truncated: false } });
  });

  /**
   * `ci.entity_merge_blocks` is the user's permanent "these are NOT the same
   * thing". It is honoured inside `ObjectDuplicateService`, before scoring, so
   * a blocked pair never reaches the queue and never costs a row — one
   * definition of "the user said no", shared by this sweep and the review UI.
   */
  it('proposes nothing for a pair the user has already rejected', async () => {
    await stage.run(ctx, Object.values(ids));

    const [blockA, blockB] = pair(ids.blockedOne, ids.blockedTwo);
    const rows = await pendingCandidates();

    expect(rows.some((row) => row.entity_id_a === blockA && row.entity_id_b === blockB)).toBe(false);
  });

  /**
   * The property that makes a NIGHTLY sweep safe: the pair is the key, so the
   * second pass rescores in place rather than piling up a second proposal of
   * the same question.
   *
   * The OUTCOMES are asserted alongside the row count, and that is the half
   * that has teeth. Dropping the `ON CONFLICT` clause leaves the row count
   * identical — the duplicate insert raises 23505, the stage catches it and
   * records `failed: candidate_write_failed`, and a count-only assertion calls
   * that idempotent. It is the opposite: a nightly sweep that dead-letters
   * every slice from its second night onward.
   */
  it('is idempotent — a second run adds no rows and fails nothing', async () => {
    const before = await pendingCandidates();

    await stage.run(ctx, Object.values(ids));
    const results = await stage.run(ctx, Object.values(ids));

    const after = await pendingCandidates();

    expect(after).toHaveLength(before.length);
    expect(after.map((row) => `${row.entity_id_a}|${row.entity_id_b}`)).toEqual(
      before.map((row) => `${row.entity_id_a}|${row.entity_id_b}`),
    );
    expect([...results.values()].map((result) => result.outcome)).toEqual(
      Object.values(ids).map(() => 'done'),
    );
  });

  /**
   * The one change this stage needed in `ObjectDuplicateService`: a slice
   * filter, applied AFTER the group is formed.
   *
   * Both halves matter. Narrowing has to WORK, or every slice re-proposes the
   * whole corpus and a nightly sweep does O(users × corpus) redundant writes.
   * And it has to narrow which GROUPS come back, never which units may join
   * one — the unit a slice's duplicate pairs with is usually outside the slice,
   * so filtering the `units` CTE instead would find almost nothing.
   */
  it('narrows to the slice’s groups while resolving their members corpus-wide', async () => {
    const everything = await duplicates.findDuplicateGroups(ctx, {});
    const lonerOnly = await duplicates.findDuplicateGroups(ctx, { objectIds: [ids.loner] });
    const cousinOnly = await duplicates.findDuplicateGroups(ctx, { objectIds: [ids.cousin] });

    expect(everything.groups).toHaveLength(2);
    expect(lonerOnly.groups).toEqual([]);

    // One group, and it carries the two twins the slice never mentioned.
    expect(cousinOnly.groups).toHaveLength(1);
    expect(cousinOnly.groups[0].items.map((item) => item.id).sort()).toEqual(
      [ids.cousin, ids.twinOne, ids.twinTwo].sort(),
    );
  });

  /**
   * The row has to be filed under the `entity_type` the READERS join on:
   * `MergeCandidateService`'s live-pair predicate requires
   * `ci.entities.entity_type = ci.merge_candidates.entity_type` on both
   * endpoints, and `ObjectMergeService` resolves its endpoints with
   * `entity_type = 'Item'`. Filing under anything else writes a row nightly
   * that no queue can show and no executor can act on.
   */
  it('files pairs under an entity_type both endpoints actually carry', async () => {
    await stage.run(ctx, Object.values(ids));

    const [visible] = await dataSource.query<Array<{ n: string }>>(
      `SELECT count(*) AS n
         FROM ci.merge_candidates mc
        WHERE mc.owner_user_id = $1::uuid
          AND EXISTS (SELECT 1 FROM ci.entities a
                       WHERE a.entity_id = mc.entity_id_a
                         AND a.owner_user_id = mc.owner_user_id
                         AND a.entity_type = mc.entity_type)
          AND EXISTS (SELECT 1 FROM ci.entities b
                       WHERE b.entity_id = mc.entity_id_b
                         AND b.owner_user_id = mc.owner_user_id
                         AND b.entity_type = mc.entity_type)`,
      [ctx.userId],
    );

    expect(Number(visible.n)).toBe((await pendingCandidates()).length);
    expect(Number(visible.n)).toBeGreaterThan(0);
  });

  /**
   * THE GUARANTEE. Everything above is a proposal; this is the assertion that
   * it stayed one. A merge is irreversible in practice — `ObjectMergeService`
   * repoints identifiers, observations and receipt line items and DELETES the
   * sources' search rows — and "you own two of the same thing" is an ordinary
   * state of the world no evidence here can rule out.
   */
  it('merges nothing', async () => {
    await stage.run(ctx, Object.values(ids));

    const [counts] = await dataSource.query<
      Array<{ units: string; tombstoned: string; entity_tombstoned: string }>
    >(
      `SELECT (SELECT count(*) FROM ci.objects WHERE user_id = $1::uuid) AS units,
              (SELECT count(*) FROM ci.objects
                WHERE user_id = $1::uuid AND merged_into_object_id IS NOT NULL) AS tombstoned,
              (SELECT count(*) FROM ci.entities
                WHERE owner_user_id = $1::uuid
                  AND (merged_into_entity_id IS NOT NULL OR is_active IS FALSE)) AS entity_tombstoned`,
      [ctx.userId],
    );

    expect(Number(counts.units)).toBe(Object.keys(ids).length);
    expect(Number(counts.tombstoned)).toBe(0);
    expect(Number(counts.entity_tombstoned)).toBe(0);

    const [merges] = await dataSource.query<Array<{ n: string }>>(
      'SELECT count(*) AS n FROM ci.entity_merges WHERE owner_user_id = $1::uuid',
      [ctx.userId],
    );

    expect(Number(merges.n)).toBe(0);
  });
});
