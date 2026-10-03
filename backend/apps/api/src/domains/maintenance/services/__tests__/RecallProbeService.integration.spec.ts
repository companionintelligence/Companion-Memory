import { randomUUID } from 'node:crypto';

import { DataSource } from 'typeorm';

import type { LoggerService } from '@ci/common/logging';
import { RETRIEVAL_POLICY_DEFAULTS } from '@ci/domains/retrieval-policy';
import { SearchService } from '@ci/domains/search-next';

import { createSyntheticTestUser } from '../../../__tests__/support/applianceUser';
import { databaseAvailability, resolveConnection } from '../../../__tests__/support/databaseConnection';
import { RecallProbeResultEntity } from '../../entities/RecallProbeResultEntity';
import { MIN_POPULATION, PROBE_K, RecallProbeService, SAMPLES_PER_TYPE } from '../RecallProbeService';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE HALF NO MOCK CAN COVER.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `RecallProbeService.test.ts` proves the service asks the right questions. It
 * cannot prove the database answers them, and every one of these is a real way
 * the probe could be silently useless:
 *
 *  1. `SET LOCAL hnsw.ef_search` has to be a setting THIS Postgres has. If
 *     pgvector's GUC were named differently, or unsettable inside a
 *     transaction, every ANN leg would throw and the table would stay empty.
 *  2. A stored embedding has to survive the round trip back in as a query
 *     vector — `embedding::text` out, a bind parameter in. If pgvector's text
 *     form were not accepted where the plan expects a vector, the probe would
 *     have no query vectors at all.
 *  3. The entity has to match the migration: eighteen columns, a `bigint`
 *     population through a transformer, a nullable `ef_search`, and a
 *     `UNIQUE NULLS NOT DISTINCT` that the server-default leg has to satisfy.
 *
 * ── What this corpus does and does not prove ──────────────────────────────
 *
 * ~2,500 rows of uniform random vectors. At that size, with current planner
 * statistics (`beforeAll` runs an ANALYZE for exactly that reason), Postgres does
 * not use the HNSW index at all — it sequential-scans and sorts, which IS the
 * exact answer — so recall comes out at 1.0 and that number is a statement about
 * the planner, not about pgvector's recall. It is asserted here anyway, because it
 * is the one thing that is knowable at this size and because a corpus this
 * small reading anything OTHER than 1.0 would mean the exact leg and the
 * production leg disagree about which rows exist.
 *
 * The interesting measurement — an HNSW-served plan losing rows to the
 * post-filter — needs a corpus past the planner's crossover (~35k rows on this
 * hardware), which is a minute of seeding and not a unit of CI time. That is
 * what the cron is for.
 */

const availability = databaseAvailability();
const describeWithDatabase = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[maintenance/RecallProbeService.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(180_000);

/** Big enough to clear MIN_POPULATION with room to spare, small enough to seed in seconds. */
const CORPUS_ROWS = MIN_POPULATION + 500;

/**
 * Deliberately under MIN_POPULATION: a type whose numbers would be arithmetic,
 * not evidence. Far under rather than just under — the assertion is that the
 * probe refuses it, which one row proves as well as 1,990, and seeding 1,990
 * more 768-dim vectors made this spec the slowest in the suite.
 */
const SMALL_CORPUS_ROWS = 25;

const noopLogger = {
  setContext: () => undefined,
  log: () => undefined,
  warn: () => undefined,
  debug: () => undefined,
  error: () => undefined,
} as unknown as LoggerService;

describeWithDatabase(`RecallProbeService against the live schema (${availability.target})`, () => {
  let dataSource: DataSource;
  let service: RecallProbeService;

  const userId = randomUUID();

  const seed = async (entityType: string, rows: number): Promise<void> => {
    await dataSource.query(
      `INSERT INTO ci_search.embeddings (id, entity_type, entity_id, embedding, user_id)
       SELECT gen_random_uuid(), $2, gen_random_uuid(), v.vec, $1::uuid
         FROM generate_series(1, $3::int) g
         CROSS JOIN LATERAL (
           SELECT array_agg(random())::vector AS vec
             FROM generate_series(1, 768) s
            WHERE g IS NOT NULL
         ) v`,
      [userId, entityType, rows],
    );
  };

  beforeAll(async () => {
    const connection = resolveConnection();

    if (connection == null) {
      throw new Error('databaseAvailability() said yes and resolveConnection() said no');
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
      entities: [RecallProbeResultEntity],
      synchronize: false,
    });

    await dataSource.initialize();

    // The probe measures whichever user has the largest index. Another suite's
    // leftovers would silently become the subject, so say so rather than
    // failing on an assertion that looks unrelated.
    const [intruder] = (await dataSource.query(
      `SELECT user_id, COUNT(*) AS population
         FROM ci_search.embeddings
        WHERE user_id IS NOT NULL
        GROUP BY user_id
       HAVING COUNT(*) >= $1
        LIMIT 1`,
      [MIN_POPULATION],
    )) as Array<{ user_id: string; population: string }>;

    if (intruder != null) {
      throw new Error(
        `ci_search.embeddings already holds ${intruder.population} rows for ${intruder.user_id}; ` +
          'this spec needs to be the largest index in the database. Clear the leftovers and re-run.',
      );
    }

    // Committed, not wrapped: the service takes its own connection from the
    // pool and could not see an uncommitted outer transaction's rows. Teardown
    // deletes everything by owner.
    await createSyntheticTestUser(
      (sql, params) => dataSource.query(sql, params as unknown[]),
      'recallprobe',
      userId,
    );
    await seed('note', CORPUS_ROWS);
    await seed('event', SMALL_CORPUS_ROWS);

    // `recall === 1` below presumes the planner answers the production statement
    // with an exact plan at this size, and that is a cost decision made from
    // statistics this seed does not write: the table's and the HNSW index's own
    // `reltuples`. They carry whatever ran in this database before. A VACUUM of an
    // emptied table leaves the index at 0, and another suite's ANALYZE inside a
    // rolled-back transaction still overwrites both in place. With the index at 0
    // the planner prices an HNSW scan at a tenth of the sequential scan, and the
    // default `ef_search` leg would come back from the approximate index. ANALYZE
    // makes the choice a function of this spec's own rows.
    await dataSource.query('ANALYZE ci_search.embeddings');

    service = new RecallProbeService(
      dataSource,
      dataSource.getRepository(RecallProbeResultEntity),
      new SearchService(
        dataSource,
        { generateEmbeddingString: jest.fn() } as never,
        { get: jest.fn().mockResolvedValue(RETRIEVAL_POLICY_DEFAULTS) } as never,
        { send: jest.fn().mockResolvedValue([]) } as never,
      ),
      noopLogger,
    );
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.query('DELETE FROM ci_search.embeddings WHERE user_id = $1', [userId]);
      // recall_probe_results cascades with the user.
      await dataSource.query('DELETE FROM ci.users WHERE id = $1', [userId]);
      await dataSource.destroy();
    }
  });

  it('measures every ef_search leg and persists them', async () => {
    const run = await service.probe();

    expect(run.userId).toBe(userId);
    expect(run.types).toEqual(['note']);
    // The undersized type is named rather than measured, and no row of its own
    // is written: a population the widest ef_search leg could hold entire scores
    // 1.0 by arithmetic, which is not evidence about anything.
    expect(run.tooSmall).toEqual(['event']);

    const persisted = (await dataSource.query(
      `SELECT ef_search, k, samples, population, mean_recall, min_recall, truncated_samples,
              exact_timeouts, ann_timeouts, mean_ann_rows, mean_exact_rows, mean_exact_ms
         FROM ci.recall_probe_results
        WHERE run_id = $1
        ORDER BY ef_search NULLS FIRST`,
      [run.runId],
    )) as Array<Record<string, string | number | null>>;

    expect(persisted.map((row) => row.ef_search)).toEqual([null, 100, 200, 400]);

    for (const row of persisted) {
      expect(Number(row.k)).toBe(PROBE_K);
      expect(Number(row.samples)).toBe(SAMPLES_PER_TYPE);
      expect(Number(row.population)).toBe(CORPUS_ROWS);
      expect(Number(row.exact_timeouts)).toBe(0);
      expect(Number(row.ann_timeouts)).toBe(0);
      // A full exact answer: the distance floor admits these vectors, so recall
      // is measured against 25 rows rather than against an empty set.
      expect(Number(row.mean_exact_rows)).toBe(PROBE_K);
      expect(Number(row.mean_exact_ms)).toBeGreaterThanOrEqual(0);
    }

    const byEf = new Map(persisted.map((row) => [row.ef_search, row]));

    // See the header: at this corpus size the planner answers exactly, so any
    // reading other than 1.0 means the two legs disagree about the corpus.
    expect(Number(byEf.get(null)?.mean_recall)).toBe(1);
    expect(Number(byEf.get(null)?.min_recall)).toBe(1);
    expect(Number(byEf.get(400)?.mean_recall)).toBeGreaterThanOrEqual(Number(byEf.get(null)?.mean_recall));
    expect(Number(byEf.get(null)?.mean_ann_rows)).toBe(PROBE_K);
    expect(Number(byEf.get(null)?.truncated_samples)).toBe(0);
  });

  it('leaves no planner setting behind on the connections it borrowed', async () => {
    await service.probe();

    // Every setting the probe uses is SET LOCAL, so a connection handed back to
    // the pool has to be at the server defaults. A bare SET would show up here
    // as 400 — and would then be silently applied to real searches.
    const [settings] = (await dataSource.query(
      `SELECT current_setting('hnsw.ef_search', true) AS ef_search,
              current_setting('enable_indexscan', true) AS enable_indexscan`,
    )) as Array<{ ef_search: string | null; enable_indexscan: string | null }>;

    expect(settings.enable_indexscan).toBe('on');
    expect(settings.ef_search == null || settings.ef_search === '40').toBe(true);
  });
});
