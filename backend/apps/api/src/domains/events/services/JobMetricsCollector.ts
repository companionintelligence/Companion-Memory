import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { LoggerService } from '@ci/common/logging';
import { Cron } from '@ci/common/schedule';

import { DEAD_LETTER_QUEUE } from '../constants';
import { JobMetricEntity } from '../entities/JobMetricEntity';
import { categoryOfEvent } from '../taxonomy';

/**
 * How often a sample is taken. Also the width of the `completed`/`failed`
 * deltas, so changing it changes the meaning of those columns — the collector
 * counts terminal transitions inside exactly this window.
 *
 * Five minutes is a compromise: fine enough to see a backlog turn over during
 * an import, coarse enough that a week of history for ~22 queues is around
 * 44k rows.
 */
const SAMPLE_INTERVAL_MINUTES = 5;

// Seconds 18 and 48, not 0. Both bodies are full-table scans of `pgboss.job`
// / `ci.job_metrics`, and second 0 is where every schedule that never picked
// one already fires. The offset does not change the sample window: successive
// ticks stay SAMPLE_INTERVAL_MINUTES apart, which is what `sample()` subtracts
// from its own fire time. See
// common/schedule/__tests__/cronSecondOffsets.test.ts for who holds what.
const SAMPLE_CRON = `18 */${SAMPLE_INTERVAL_MINUTES} * * * *`;

/** Purge daily, off the top of the hour to avoid piling onto other crons. */
const PURGE_CRON = '48 25 4 * * *';

/**
 * How much history to keep. Long enough to answer "is this worse than last
 * week?", short enough that the table stays trivially small.
 */
const RETENTION_DAYS = 30;

/**
 * Samples what every queue is doing and writes it to `ci.job_metrics`, and what
 * every job CATEGORY is doing and writes that to `ci.job_category_metrics`.
 *
 * The whole reason this exists: pg-boss's tables are a working set, not a
 * record. Terminal jobs move to `pgboss.archive` after twelve hours and are
 * deleted twelve hours after that, so "how did this queue behave yesterday" had
 * no answer, and neither did "is the backlog draining or growing" — a single
 * count is a gauge with nothing to compare against.
 *
 * The two tables exist separately because a queue cannot be folded to a
 * category after the fact: pg-boss rewrites `name` to `dead-letter` on the copy
 * it makes of a job that exhausted its retries — 8,431 of 19,606 rows (43%) on
 * a live appliance — so the queue is gone, while the event name in `data`
 * survives. Categories therefore have to be counted from their own scan of
 * `data->>'name'`, not derived from the per-queue rows.
 *
 * Four queries per tick, all grouped, all bounded. Measured on a live appliance
 * (19,606 rows over 39 LIST partitions) a grouped scan of `pgboss.job` is ~6 ms
 * execution / ~7 ms planning, so doubling the sweep costs about 13 ms every
 * five minutes. Cheap enough to run alongside real work; the alternative (a
 * metrics service) would mean running a second datastore to observe the one we
 * already have.
 */
@Injectable()
export class JobMetricsCollector {
  constructor(
    // The entity manager behind this repository, not an injected DataSource:
    // the collector's queries span `pgboss.job` and `ci.job_metrics`, so no
    // single repository covers them — but `manager.query()` does, and taking it
    // this way keeps EventsModule compilable without a DataSource provider
    // (which is what an isolated test module has).
    @InjectRepository(JobMetricEntity)
    private readonly metricRepository: Repository<JobMetricEntity>,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(JobMetricsCollector.name);
  }

  @Cron(SAMPLE_CRON, { name: 'JobMetricsCollector.sampleOnSchedule' })
  async sampleOnSchedule(): Promise<void> {
    await this.sample();
  }

  @Cron(PURGE_CRON, { name: 'JobMetricsCollector.purgeOnSchedule' })
  async purgeOnSchedule(): Promise<void> {
    await this.purge();
  }

  /**
   * Take one sample.
   *
   * Returns the number of QUEUE rows written, so a test can assert the sweep
   * did something without reading the table. Unchanged by the category sweep:
   * the two tables have different grains and a single number cannot describe
   * both.
   */
  async sample(now: Date = new Date()): Promise<number> {
    const tables = await this.tablesPresent();

    // `pgboss.job` only exists once pg-boss has started — absent under
    // LocalEventService (tests, some dev setups). A monitoring sweep must not
    // be the thing that breaks those.
    if (!tables.pgBoss) {
      this.logger.debug('pgboss.job is not present; skipping job metrics sample');

      return 0;
    }

    const since = new Date(now.getTime() - SAMPLE_INTERVAL_MINUTES * 60_000);

    const [gauges, throughput] = await Promise.all([this.readGauges(), this.readThroughput(since)]);

    const queues = new Set([...gauges.keys(), ...throughput.keys()]);

    if (queues.size === 0) {
      return 0;
    }

    const rows = [...queues].map((queue) => {
      const gauge = gauges.get(queue);
      const flow = throughput.get(queue);

      return {
        queue,
        pending: gauge?.pending ?? 0,
        active: gauge?.active ?? 0,
        retry: gauge?.retry ?? 0,
        deadLettered: gauge?.deadLettered ?? 0,
        completed: flow?.completed ?? 0,
        failed: flow?.failed ?? 0,
        avgDurationMs: flow?.avgDurationMs ?? null,
        p95DurationMs: flow?.p95DurationMs ?? null,
      };
    });

    // ON CONFLICT DO NOTHING rather than an upsert: the primary key is
    // (sampled_at, queue), and two collectors racing the same tick are writing
    // the same observation. First one wins, silently.
    await this.metricRepository.manager.query(
      `
      INSERT INTO ci.job_metrics
        (sampled_at, queue, pending, active, retry, dead_lettered, completed, failed, avg_duration_ms, p95_duration_ms)
      SELECT $1, r.queue, r.pending, r.active, r.retry, r.dead_lettered, r.completed, r.failed, r.avg_duration_ms, r.p95_duration_ms
        FROM jsonb_to_recordset($2::jsonb) AS r(
          queue text, pending int, active int, retry int, dead_lettered int,
          completed int, failed int, avg_duration_ms int, p95_duration_ms int
        )
      ON CONFLICT DO NOTHING
      `,
      [
        now,
        JSON.stringify(
          rows.map((row) => ({
            queue: row.queue,
            pending: row.pending,
            active: row.active,
            retry: row.retry,
            dead_lettered: row.deadLettered,
            completed: row.completed,
            failed: row.failed,
            avg_duration_ms: row.avgDurationMs,
            p95_duration_ms: row.p95DurationMs,
          })),
        ),
      ],
    );

    this.logger.debug(`Sampled job metrics for ${rows.length} queues`);

    if (tables.categoryMetrics) {
      await this.sampleCategories(now, since);
    }

    return rows.length;
  }

  /** Drop samples past the retention horizon, from both tables. */
  async purge(now: Date = new Date()): Promise<void> {
    const cutoff = new Date(now.getTime() - RETENTION_DAYS * 24 * 60 * 60_000);

    const result = await this.metricRepository.manager.query(
      `DELETE FROM ci.job_metrics WHERE sampled_at < $1`,
      [cutoff],
    );

    // Same horizon, deliberately: the two charts sit on the same screen and a
    // window that runs off the end of one of them is worse than a shorter
    // window on both.
    if ((await this.tablesPresent()).categoryMetrics) {
      await this.metricRepository.manager.query(`DELETE FROM ci.job_category_metrics WHERE sampled_at < $1`, [
        cutoff,
      ]);
    }

    this.logger.debug(`Purged job metrics older than ${cutoff.toISOString()}`, {
      rows: Array.isArray(result) ? result.length : undefined,
    });
  }

  /**
   * Which of the tables this sweep writes actually exist.
   *
   * `pgboss.job` only exists once pg-boss has started. `ci.job_category_metrics`
   * shipped after `ci.job_metrics`, so a process that boots against a database
   * whose migrations have not finished — a rolling deploy, a developer stack
   * pointed at an older schema — has one and not the other. Probed rather than
   * assumed because the failure mode is silent and repeating: an unguarded
   * INSERT would throw inside a cron every five minutes forever, and take the
   * per-queue sample down with it for a table it does not even write.
   */
  private async tablesPresent(): Promise<{ pgBoss: boolean; categoryMetrics: boolean }> {
    const [row] = (await this.metricRepository.manager.query(
      `SELECT to_regclass('pgboss.job') IS NOT NULL              AS pg_boss,
              to_regclass('ci.job_category_metrics') IS NOT NULL AS category_metrics`,
    )) as [{ pg_boss: boolean; category_metrics: boolean }];

    return { pgBoss: row.pg_boss, categoryMetrics: row.category_metrics };
  }

  /**
   * Queue depth right now.
   *
   * Attributing a dead-lettered job back to the queue it came from is NOT
   * "read the origin off the job's own partition" — pg-boss's `dlq_jobs`
   * insert (plans.js) writes a brand-new row into the `dead-letter` queue,
   * and that row's `name` is the DLQ's own name, not the origin's. The
   * origin is nowhere on it: no back-reference id, nothing in `data`. What
   * DOES survive is the ORIGINAL job row: `failJobs` leaves it behind in
   * this same table with `state = 'failed'`, still under its own queue's
   * `name` — pg-boss just never deletes it. Every queue here is provisioned
   * with `deadLetter: DEAD_LETTER_QUEUE` (`PGBossEventService.onModuleInit`'s
   * queue-creation loop), so for this app specifically, `state = 'failed'`
   * outside the DLQ's own partition IS "gave up and got dead-lettered" —
   * that equivalence is an app-level invariant, not something pg-boss
   * guarantees in general.
   *
   * The DLQ's own row keeps its old meaning (every job sitting in it,
   * regardless of state) via `name = $1`, which is also why `pending`
   * excludes it — counting it there is the bug this dashboard already had
   * once.
   */
  private async readGauges(): Promise<
    Map<string, { pending: number; active: number; retry: number; deadLettered: number }>
  > {
    const rows = (await this.metricRepository.manager.query(
      `
      SELECT name AS queue,
             COUNT(*) FILTER (WHERE state = 'created' AND name <> $1)::int    AS pending,
             COUNT(*) FILTER (WHERE state = 'active')::int                    AS active,
             COUNT(*) FILTER (WHERE state = 'retry')::int                     AS retry,
             COUNT(*) FILTER (WHERE name = $1 OR state = 'failed')::int       AS dead_lettered
        FROM pgboss.job
       GROUP BY name
      `,
      [DEAD_LETTER_QUEUE],
    )) as Array<{
      queue: string;
      pending: number;
      active: number;
      retry: number;
      dead_lettered: number;
    }>;

    return new Map(
      rows.map((row) => [
        row.queue,
        {
          pending: Number(row.pending) || 0,
          active: Number(row.active) || 0,
          retry: Number(row.retry) || 0,
          deadLettered: Number(row.dead_lettered) || 0,
        },
      ]),
    );
  }

  /**
   * What reached a terminal state during the interval, and how long it took.
   *
   * Unions `job` and `archive` because pg-boss moves a terminal row between
   * them twelve hours after it settles — inside one five-minute window the row
   * is almost always still in `job`, but a delayed tick after a restart would
   * otherwise silently under-count.
   */
  private async readThroughput(
    since: Date,
  ): Promise<
    Map<
      string,
      { completed: number; failed: number; avgDurationMs: number | null; p95DurationMs: number | null }
    >
  > {
    const rows = (await this.metricRepository.manager.query(
      `
      WITH settled AS (
        SELECT name, state, started_on, completed_on FROM pgboss.job    WHERE completed_on >= $1
        UNION ALL
        SELECT name, state, started_on, completed_on FROM pgboss.archive WHERE completed_on >= $1
      )
      SELECT name AS queue,
             COUNT(*) FILTER (WHERE state = 'completed')::int AS completed,
             COUNT(*) FILTER (WHERE state = 'failed')::int    AS failed,
             AVG(EXTRACT(EPOCH FROM (completed_on - started_on)) * 1000)
               FILTER (WHERE started_on IS NOT NULL)          AS avg_duration_ms,
             PERCENTILE_DISC(0.95) WITHIN GROUP (
               ORDER BY EXTRACT(EPOCH FROM (completed_on - started_on)) * 1000
             ) FILTER (WHERE started_on IS NOT NULL)          AS p95_duration_ms
        FROM settled
       GROUP BY name
      `,
      [since],
    )) as Array<{
      queue: string;
      completed: number;
      failed: number;
      avg_duration_ms: string | null;
      p95_duration_ms: string | null;
    }>;

    const toMs = (value: string | null): number | null => {
      if (value == null) {
        return null;
      }

      const parsed = Math.round(Number(value));

      return Number.isFinite(parsed) ? parsed : null;
    };

    return new Map(
      rows.map((row) => [
        row.queue,
        {
          completed: Number(row.completed) || 0,
          failed: Number(row.failed) || 0,
          avgDurationMs: toMs(row.avg_duration_ms),
          p95DurationMs: toMs(row.p95_duration_ms),
        },
      ]),
    );
  }

  /**
   * The same tick, counted by job category instead of by queue.
   *
   * Written from its own pair of scans rather than folded out of the per-queue
   * rows, because the per-queue rows no longer know which category they are:
   * `readGauges` groups on `name`, and for the 43% of rows pg-boss has copied
   * into the dead-letter queue that column reads `dead-letter`. The event name
   * in `data` is the only thing that survives the copy.
   */
  private async sampleCategories(now: Date, since: Date): Promise<number> {
    const [gauges, flow] = await Promise.all([this.readCategoryGauges(), this.readCategoryFlow(since)]);

    const categories = new Set([...gauges.keys(), ...flow.keys()]);

    if (categories.size === 0) {
      return 0;
    }

    const rows = [...categories].map((category) => {
      const gauge = gauges.get(category);
      const delta = flow.get(category);

      return {
        category,
        pending: gauge?.pending ?? 0,
        active: gauge?.active ?? 0,
        retry: gauge?.retry ?? 0,
        dead_lettered: gauge?.deadLettered ?? 0,
        arrived: delta?.arrived ?? 0,
        completed: delta?.completed ?? 0,
        failed: delta?.failed ?? 0,
      };
    });

    // ON CONFLICT DO NOTHING for the same reason as the per-queue insert: the
    // key is (sampled_at, category) and two collectors racing a tick are
    // writing the same observation.
    await this.metricRepository.manager.query(
      `
      INSERT INTO ci.job_category_metrics
        (sampled_at, category, pending, active, retry, dead_lettered, arrived, completed, failed)
      SELECT $1, r.category, r.pending, r.active, r.retry, r.dead_lettered, r.arrived, r.completed, r.failed
        FROM jsonb_to_recordset($2::jsonb) AS r(
          category text, pending int, active int, retry int, dead_lettered int,
          arrived int, completed int, failed int
        )
      ON CONFLICT DO NOTHING
      `,
      [now, JSON.stringify(rows)],
    );

    this.logger.debug(`Sampled job metrics for ${rows.length} categories`);

    return rows.length;
  }

  /**
   * Outstanding work right now, per category.
   *
   * `dead_lettered` counts ONLY rows sitting in the dead-letter queue, unlike
   * the per-queue gauge which must also count `state = 'failed'` rows in the
   * origin partition. That surrogate exists there because the DLQ copy has lost
   * its origin queue and would otherwise be attributable to nothing. Here it
   * has not lost anything: the copy carries the same `data->>'name'` as the
   * original, so both rows fold to the same category and counting both would
   * report every dead-lettered job twice.
   *
   * `pending` still excludes the DLQ by name — its rows are inserted in state
   * `created`, exactly like work that is waiting to run, which is the bug this
   * dashboard already had once (see DEAD_LETTER_QUEUE).
   */
  private async readCategoryGauges(): Promise<
    Map<string, { pending: number; active: number; retry: number; deadLettered: number }>
  > {
    const rows = (await this.metricRepository.manager.query(
      `
      SELECT data->>'name' AS event,
             COUNT(*) FILTER (WHERE state = 'created' AND name <> $1)::int AS pending,
             COUNT(*) FILTER (WHERE state = 'active')::int                 AS active,
             COUNT(*) FILTER (WHERE state = 'retry')::int                  AS retry,
             COUNT(*) FILTER (WHERE name = $1)::int                        AS dead_lettered
        FROM pgboss.job
       GROUP BY 1
      `,
      [DEAD_LETTER_QUEUE],
    )) as Array<{
      event: string | null;
      pending: number;
      active: number;
      retry: number;
      dead_lettered: number;
    }>;

    const folded = new Map<
      string,
      { pending: number; active: number; retry: number; deadLettered: number }
    >();

    for (const row of rows) {
      const category = categoryOfEvent(row.event);
      const bucket = folded.get(category) ?? { pending: 0, active: 0, retry: 0, deadLettered: 0 };

      bucket.pending += Number(row.pending) || 0;
      bucket.active += Number(row.active) || 0;
      bucket.retry += Number(row.retry) || 0;
      bucket.deadLettered += Number(row.dead_lettered) || 0;

      folded.set(category, bucket);
    }

    return folded;
  }

  /**
   * What arrived and what settled during the interval, per category.
   *
   * `arrived` is the column the category chart plots, and it is counted from
   * `created_on` because that is the only timestamp every row carries — a job
   * still queued has no `completed_on`, so a throughput-only series would show
   * nothing at all for a category that is backing up, which is precisely when
   * someone is looking at the chart.
   *
   * Dead-letter rows are excluded from `arrived` and nothing else. pg-boss
   * INSERTS a new row when a job exhausts its retries, stamped with the
   * dead-lettering time, so counting it as an arrival would draw a burst of
   * fresh work at the exact moment work started failing — on a live appliance,
   * 43% of all rows. They cannot double-count in `completed`/`failed` because
   * nothing consumes that queue: its rows stay in state `created` until they
   * age out.
   *
   * Unions `archive` for the same reason `readThroughput` does: pg-boss moves a
   * terminal row across twelve hours after it settles, so a tick delayed by a
   * restart would otherwise silently under-count.
   */
  private async readCategoryFlow(
    since: Date,
  ): Promise<Map<string, { arrived: number; completed: number; failed: number }>> {
    const rows = (await this.metricRepository.manager.query(
      `
      WITH recent AS (
        SELECT name, data, state, created_on, completed_on FROM pgboss.job
         WHERE created_on >= $1 OR completed_on >= $1
        UNION ALL
        SELECT name, data, state, created_on, completed_on FROM pgboss.archive
         WHERE created_on >= $1 OR completed_on >= $1
      )
      SELECT data->>'name' AS event,
             COUNT(*) FILTER (WHERE created_on >= $1 AND name <> $2)::int          AS arrived,
             COUNT(*) FILTER (WHERE completed_on >= $1 AND state = 'completed')::int AS completed,
             COUNT(*) FILTER (WHERE completed_on >= $1 AND state = 'failed')::int    AS failed
        FROM recent
       GROUP BY 1
      `,
      [since, DEAD_LETTER_QUEUE],
    )) as Array<{ event: string | null; arrived: number; completed: number; failed: number }>;

    const folded = new Map<string, { arrived: number; completed: number; failed: number }>();

    for (const row of rows) {
      const category = categoryOfEvent(row.event);
      const bucket = folded.get(category) ?? { arrived: 0, completed: 0, failed: 0 };

      bucket.arrived += Number(row.arrived) || 0;
      bucket.completed += Number(row.completed) || 0;
      bucket.failed += Number(row.failed) || 0;

      folded.set(category, bucket);
    }

    return folded;
  }
}
