import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { LoggerService } from '@ci/common/logging';
import { Cron } from '@ci/common/schedule';

import { DEAD_LETTER_QUEUE } from '../constants';
import { JobMetricEntity } from '../entities/JobMetricEntity';

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
 * Samples what every queue is doing and writes it to `ci.job_metrics`.
 *
 * The whole reason this exists: pg-boss's tables are a working set, not a
 * record. Terminal jobs move to `pgboss.archive` after twelve hours and are
 * deleted twelve hours after that, so "how did this queue behave yesterday" had
 * no answer, and neither did "is the backlog draining or growing" — a single
 * count is a gauge with nothing to compare against.
 *
 * Two queries per tick, both grouped, both bounded. Cheap enough to run
 * alongside real work; the alternative (a metrics service) would mean running a
 * second datastore to observe the one we already have.
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
   * Returns the number of queue rows written, so a test can assert the sweep
   * did something without reading the table.
   */
  async sample(now: Date = new Date()): Promise<number> {
    // `pgboss.job` only exists once pg-boss has started — absent under
    // LocalEventService (tests, some dev setups). A monitoring sweep must not
    // be the thing that breaks those.
    if (!(await this.pgBossInstalled())) {
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

    return rows.length;
  }

  /** Drop samples past the retention horizon. */
  async purge(now: Date = new Date()): Promise<void> {
    const cutoff = new Date(now.getTime() - RETENTION_DAYS * 24 * 60 * 60_000);

    const result = await this.metricRepository.manager.query(
      `DELETE FROM ci.job_metrics WHERE sampled_at < $1`,
      [cutoff],
    );

    this.logger.debug(`Purged job metrics older than ${cutoff.toISOString()}`, {
      rows: Array.isArray(result) ? result.length : undefined,
    });
  }

  private async pgBossInstalled(): Promise<boolean> {
    const [{ present }] = (await this.metricRepository.manager.query(
      `SELECT to_regclass('pgboss.job') IS NOT NULL AS present`,
    )) as [{ present: boolean }];

    return present;
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
}
