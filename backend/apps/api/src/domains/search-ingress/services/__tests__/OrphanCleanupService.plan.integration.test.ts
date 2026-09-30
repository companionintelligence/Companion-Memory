import { randomUUID } from 'node:crypto';

import { DataSource, type QueryRunner } from 'typeorm';

import { INDEXABLE_ENTITIES, type IndexableEntity } from '@ci/domains/search-next';

import { databaseAvailability, resolveConnection } from '../../../__tests__/support/databaseConnection';
import { OrphanCleanupService } from '../OrphanCleanupService';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE SWEEP'S QUERIES MUST BE ANSWERABLE FROM AN INDEX.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `OrphanCleanupService` correlates an index row to its source row by uuid.
 * When BOTH sides were cast to text (`src."event_id"::text = s.entity_id::text`)
 * the source primary key became unusable and the planner answered "does this id
 * still exist?" by reading the whole source table — measured on 400k `ci.events`
 * rows against 238 index rows: a hash anti join over a full sequential scan,
 * 1,322 temp blocks written, ~150 ms. The nightly sweep issues one statement of
 * that shape per (index table x indexable type).
 *
 * A unit test can only assert the SQL text. This asks the planner, against the
 * real schema:
 *
 *  1. is the correlation an INDEX CONDITION on the source, or a filter applied
 *     to rows a full scan produced;
 *  2. does it type-check uncast for every indexable type — the one risk in
 *     dropping a cast is a source id column that is not uuid, and only the real
 *     schema knows that.
 *
 * ── Why the seed, and why `enable_seqscan = off` ───────────────────────────
 *
 * Both make the answer depend on the QUERY rather than on today's row counts.
 * On empty tables every plan costs nothing and the planner picks arbitrarily;
 * with a few thousand source rows and sequential scans priced out, "probe the
 * key" beats "read the table" decisively — unless the cast has made the key
 * unusable, which no row count can fix. Seeding more only widens that gap, so
 * this reads the same on an appliance with a real archive.
 *
 * `enable_mergejoin = off` for the same reason. The seeded ids come from the
 * `ci.gen_uuid_v7()` default, which mints real UUIDv7 since migration
 * 20260930141141, so they arrive in key order: `events_pkey` matches the heap
 * exactly, and on a freshly migrated database a merge anti join over the whole
 * key index prices below a few hundred probes. That plan still uses the key
 * uncast — a costing choice, not the whole-table read this guards against —
 * but it has no `Index Cond` to assert on. Priced out, a usable key is probed;
 * a cast still falls back to a `Hash Cond` over a full read.
 *
 * ── Why a rolled-back transaction is enough here ───────────────────────────
 *
 * `domains/__tests__/support/scratchDatabase.ts` is right that rollback is a
 * weak fence when a test drives services that take their own connections. This
 * one drives none: the service is used only to BUILD the SQL (against a mocked
 * runner), and every statement that reaches Postgres is issued by this file on
 * one runner inside one transaction. The queries under test are EXPLAINed, never
 * executed.
 */
const availability = databaseAvailability();
const describeWithDb = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[OrphanCleanupService plan] skipped: ${availability.reason}`);
}

/** Source rows to seed. Enough that reading them all is visibly the wrong plan. */
const SEEDED_EVENTS = 20_000;
/** Index rows: mostly live, a few orphans — the shape the sweep meets nightly. */
const SEEDED_LIVE_INDEX_ROWS = 200;
const SEEDED_ORPHAN_INDEX_ROWS = 38;

function makeLogger() {
  return { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

/**
 * The statements the service itself would issue for a dry-run sweep of one
 * type, in SEARCH_TABLES order. Captured rather than re-written here: a test
 * that hand-writes the query proves nothing about the query that ships.
 */
async function captureCountStatements(entityType: IndexableEntity): Promise<Array<[string, string[]]>> {
  const calls: Array<[string, string[]]> = [];
  const query = jest.fn(async (sql: string, params?: string[]) => {
    calls.push([sql, params ?? []]);

    return [{ count: 0 }];
  });
  const runner = {
    connect: jest.fn().mockResolvedValue(undefined),
    query,
    release: jest.fn().mockResolvedValue(undefined),
  };
  const service = new OrphanCleanupService(
    { createQueryRunner: () => runner } as unknown as DataSource,
    makeLogger() as never,
  );

  await service.cleanOrphans({ entityTypes: [entityType], dryRun: true });

  return calls.filter(([sql]) => !sql.includes('statement_timeout'));
}

describeWithDb('OrphanCleanupService query plans (integration)', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    const connection = resolveConnection();

    if (connection == null) {
      throw new Error('database reported available but no connection resolved');
    }

    dataSource = new DataSource({
      type: 'postgres',
      host: connection.host,
      port: connection.port,
      username: connection.username,
      password: connection.password,
      database: connection.database,
      synchronize: false,
      entities: [],
    });

    await dataSource.initialize();
  }, 30_000);

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      await dataSource.destroy();
    }
  });

  /** Runs `work` on one runner inside a transaction that is always rolled back. */
  async function inRolledBackTransaction<T>(work: (runner: QueryRunner) => Promise<T>): Promise<T> {
    const runner = dataSource.createQueryRunner();

    await runner.connect();
    await runner.startTransaction();

    try {
      // Structural question, not tuning: can the source key be used to probe
      // for this correlation at all? A cast on the indexed side answers no at
      // every table size.
      await runner.query('SET LOCAL enable_seqscan = off');
      // Time-ordered ids make a merge over the whole key index cheap at this
      // seed size (see the header), so it is priced out for the same reason.
      await runner.query('SET LOCAL enable_mergejoin = off');

      return await work(runner);
    } finally {
      await runner.rollbackTransaction();
      await runner.release();
    }
  }

  async function explain(runner: QueryRunner, sql: string, params: string[]): Promise<string> {
    return JSON.stringify(await runner.query(`EXPLAIN (FORMAT JSON, COSTS OFF) ${sql}`, params));
  }

  it('probes the source primary key by index condition rather than reading the whole table', async () => {
    const [[sql, params]] = await captureCountStatements('event');

    const plan = await inRolledBackTransaction(async (runner) => {
      const userId = randomUUID();

      await runner.query(
        `INSERT INTO ci.users (id, email, name, onboarded) VALUES ($1, $2, 'orphan-plan', true)`,
        [userId, `orphan-plan.${userId}@example.test`],
      );
      await runner.query(
        `INSERT INTO ci.events (event_id, user_id, start_time)
         SELECT ci.gen_uuid_v7(), $1, now() FROM generate_series(1, $2)`,
        [userId, SEEDED_EVENTS],
      );
      await runner.query(
        `INSERT INTO ci_search.embeddings (id, entity_type, entity_id)
         SELECT gen_random_uuid(), 'event', event_id FROM ci.events WHERE user_id = $1 LIMIT $2`,
        [userId, SEEDED_LIVE_INDEX_ROWS],
      );
      await runner.query(
        `INSERT INTO ci_search.embeddings (id, entity_type, entity_id)
         SELECT gen_random_uuid(), 'event', gen_random_uuid() FROM generate_series(1, $1)`,
        [SEEDED_ORPHAN_INDEX_ROWS],
      );
      await runner.query('ANALYZE ci.events');
      await runner.query('ANALYZE ci_search.embeddings');

      return explain(runner, sql, params);
    });

    // What a usable primary key looks like in a plan. With a cast on either
    // side the correlation drops out of the index and reappears as a "Hash
    // Cond" / "Join Filter" over a full read of ci.events — the whole-table
    // scan this test exists to prevent.
    expect(plan).toContain('"Index Cond":"(event_id = s.entity_id)"');
    expect(plan).not.toContain('"Hash Cond"');
    expect(plan).not.toContain('"Join Filter"');
  }, 60_000);

  it('correlates uncast for every indexable type, so no type needs its cast back', async () => {
    await inRolledBackTransaction(async (runner) => {
      for (const entityType of INDEXABLE_ENTITIES) {
        for (const [sql, params] of await captureCountStatements(entityType)) {
          // Planning alone raises `operator does not exist: text = uuid` if a
          // source id column is ever not a uuid, naming the type that broke.
          await expect(explain(runner, sql, params)).resolves.toContain('"Node Type"');
        }
      }
    });
  }, 60_000);
});
