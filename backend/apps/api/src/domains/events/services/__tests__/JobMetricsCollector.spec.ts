import { DataSource } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import type { LoggerService } from '@ci/common/logging';

import { databaseAvailability, resolveConnection } from '../../../__tests__/support/databaseConnection';
import { acquireSchemaWriteLock, type SchemaLock } from '../../../__tests__/support/schemaLock';
import { DEAD_LETTER_QUEUE, DEFAULT_QUEUE } from '../../constants';
import { JobMetricEntity } from '../../entities/JobMetricEntity';
import { JobMetricsCollector } from '../JobMetricsCollector';

const logger = {
  setContext() {},
  log() {},
  warn() {},
  error() {},
  debug() {},
} as unknown as LoggerService;

/**
 * `readGauges()`'s dead-letter attribution, proved against real Postgres.
 *
 * pg-boss's own `dlq_jobs` insert (pg-boss `src/plans.js`) discards the origin
 * queue name: the new row it writes into the `dead-letter` queue carries
 * `name = 'dead-letter'`, nothing else. What DOES survive is the ORIGINAL job
 * row — `failJobs` (same file) leaves it behind in `pgboss.job` with
 * `state = 'failed'`, still under its own queue's `name`. A mock of
 * `manager.query()` cannot catch a wrong `FILTER` clause here; it would just
 * hand back whatever the mock was told to, which is exactly how a
 * dead_lettered column that was always 0 for every real queue went
 * unnoticed.
 *
 * Opt-in: set `EVENTS_TEST_DATABASE_URL` (or `DATABASE_URL` / `DATABASE_PASSWORD`,
 * as `yarn test` already does from the repo-root `.env`) to a database with
 * migrations applied.
 */
const availability = databaseAvailability({ urlEnvVar: 'EVENTS_TEST_DATABASE_URL' });
const describeWithDatabase = availability.available ? describe : describe.skip;

if (!availability.available) {
  console.warn(`[events/JobMetricsCollector.integration] SKIPPED — ${availability.reason}`);
}

jest.setTimeout(60_000);

describeWithDatabase(`JobMetricsCollector — against real Postgres (${availability.target})`, () => {
  let dataSource: DataSource;
  let schemaLock: SchemaLock | null = null;
  let collector: JobMetricsCollector;

  const insertedJobIds: string[] = [];
  const sampledTimestamps: Date[] = [];

  beforeAll(async () => {
    const connection = resolveConnection({ urlEnvVar: 'EVENTS_TEST_DATABASE_URL' });

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
      entities: [JobMetricEntity],
      synchronize: false,
    });

    await dataSource.initialize();

    // SHARED: this suite commits real pgboss.job / ci.job_metrics rows. See
    // domains/__tests__/support/schemaLock.ts.
    schemaLock = await acquireSchemaWriteLock(dataSource, 'JobMetricsCollector');

    collector = new JobMetricsCollector(dataSource.getRepository(JobMetricEntity), logger);

    // A baseline `active` row on each queue this suite reads, so a snapshot
    // never sees an empty GROUP BY partition — `active` never enters the
    // dead_lettered/pending FILTERs for a real queue, so it is invisible to
    // every before/after delta below, but it guarantees the queue's row
    // exists in every sample regardless of what else is on a shared database.
    await insertJob({ queue: DEFAULT_QUEUE, state: 'active' });
    await insertJob({ queue: DEAD_LETTER_QUEUE, state: 'active' });
  });

  afterAll(async () => {
    if (dataSource?.isInitialized) {
      if (insertedJobIds.length > 0) {
        await dataSource.query(`DELETE FROM pgboss.job WHERE id = ANY($1::uuid[])`, [insertedJobIds]);
      }

      for (const sampledAt of sampledTimestamps) {
        await dataSource.query(`DELETE FROM ci.job_metrics WHERE sampled_at = $1`, [sampledAt]);
      }

      // Before `destroy()`: the lock is held on a runner from this pool.
      await schemaLock?.release();
      await dataSource.destroy();
    }
  });

  // pgboss.job is `PARTITION BY LIST (name)` — a queue name with no partition
  // fails the insert outright, so this seeds into 'default' and 'dead-letter'
  // only, both pre-created on a migrated database (see PGBossEventService's
  // provisioning of the always-registered default queue and the shared DLQ).
  async function insertJob(fields: {
    queue: string;
    state: string;
    deadLetter?: string | null;
  }): Promise<string> {
    const id = uuidv7();

    insertedJobIds.push(id);

    await dataSource.query(
      `INSERT INTO pgboss.job (id, name, state, dead_letter) VALUES ($1, $2, $3::pgboss.job_state, $4)`,
      [id, fields.queue, fields.state, fields.deadLetter ?? null],
    );

    return id;
  }

  /** One `sample()` snapshot, read back for a single queue's gauge row. */
  async function gauge(
    queue: string,
    sampledAt: Date,
  ): Promise<{ pending: number; active: number; retry: number; deadLettered: number }> {
    sampledTimestamps.push(sampledAt);

    await collector.sample(sampledAt);

    const rows = (await dataSource.query(
      `SELECT pending, active, retry, dead_lettered AS "deadLettered"
         FROM ci.job_metrics
        WHERE sampled_at = $1 AND queue = $2`,
      [sampledAt, queue],
    )) as Array<{ pending: number; active: number; retry: number; deadLettered: number }>;

    return rows[0] ?? { pending: 0, active: 0, retry: 0, deadLettered: 0 };
  }

  it('attributes a permanently-failed job back to its OWN queue, not just the DLQ pseudo-queue', async () => {
    const t0 = Date.now();
    const before = await gauge(DEFAULT_QUEUE, new Date(t0 - 2000));

    // The row pg-boss leaves behind in the ORIGIN queue's own partition once a
    // job exhausts retries and gets dead-lettered — see pg-boss's `failJobs`.
    // `dead_letter` mirrors what a real dead-lettered job carries; the gauge
    // query does not read this column, but a job that reaches `state =
    // 'failed'` in this app always has it set (every queue is provisioned
    // with `deadLetter: DEAD_LETTER_QUEUE`).
    await insertJob({ queue: DEFAULT_QUEUE, state: 'failed', deadLetter: DEAD_LETTER_QUEUE });

    const after = await gauge(DEFAULT_QUEUE, new Date(t0 - 1000));

    expect(after.deadLettered - before.deadLettered).toBe(1);
    // The historical bug this file's top docstring warns about: a dead row
    // must not also read as live backlog.
    expect(after.pending - before.pending).toBe(0);
  });

  it('still counts everything sitting in the DLQ pseudo-queue itself, regardless of state', async () => {
    const t0 = Date.now();
    const before = await gauge(DEAD_LETTER_QUEUE, new Date(t0 - 4000));

    // The row pg-boss ACTUALLY inserts for a dead-lettered job — a fresh id,
    // `name = 'dead-letter'`, no origin queue anywhere on it.
    await insertJob({ queue: DEAD_LETTER_QUEUE, state: 'created' });

    const after = await gauge(DEAD_LETTER_QUEUE, new Date(t0 - 3000));

    expect(after.deadLettered - before.deadLettered).toBe(1);
    // Excluded from pending on purpose — see DEAD_LETTER_QUEUE's own docstring.
    expect(after.pending - before.pending).toBe(0);
  });

  it('does not attribute an ordinary retry-exhausted-but-undead job to dead_lettered', async () => {
    // A queue with NO dead-letter configured would still leave a `state =
    // 'failed'` row behind with `dead_letter IS NULL` — this app configures
    // one for every queue, so this only documents the boundary of the
    // invariant the fix relies on, not a case this app actually hits.
    const t0 = Date.now();
    const before = await gauge(DEFAULT_QUEUE, new Date(t0 - 6000));

    await insertJob({ queue: DEFAULT_QUEUE, state: 'active' });

    const after = await gauge(DEFAULT_QUEUE, new Date(t0 - 5000));

    expect(after.deadLettered - before.deadLettered).toBe(0);
    expect(after.active - before.active).toBe(1);
  });
});
