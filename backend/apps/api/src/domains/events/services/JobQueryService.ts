import { Injectable, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, Repository } from 'typeorm';

import { RequestContext } from '@ci/common/context';

import { DEAD_LETTER_QUEUE } from '../constants';
import { JobCategoryMetricEntity } from '../entities/JobCategoryMetricEntity';
import { JobMetricEntity } from '../entities/JobMetricEntity';
import { PgBossArchiveEntity } from '../entities/PgBossArchiveEntity';
import { PgBossJobEntity } from '../entities/PgBossJobEntity';
import {
  categoryOfEvent,
  describeJob,
  jobCategorySelector,
  JOB_TYPES,
  UNCLASSIFIED_CATEGORY,
} from '../taxonomy';

export interface JobListItemDto {
  readonly id: string;
  readonly queue: string;
  readonly state: string;
  readonly event: string | null;
  readonly workType: string | null;
  /** Human label from the taxonomy — what this job actually does. */
  readonly label: string;
  readonly category: string;
  readonly description: string;
  readonly interactive: boolean;
  readonly createdOn: string;
  readonly startedOn: string | null;
  readonly completedOn: string | null;
  /** Wall-clock run time in ms, when the job has both timestamps. */
  readonly durationMs: number | null;
  readonly retryCount: number;
  readonly retryLimit: number;
  readonly payloadBytes: number;
  readonly failure: { message: string; stack?: string; failedAt?: string } | null;
  /** True when this row is the dead-letter copy rather than the original. */
  readonly deadLettered: boolean;
}

export interface JobListDto {
  readonly items: readonly JobListItemDto[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
  /** Distinct queues present, so the filter can be populated without a second call. */
  readonly queues: readonly string[];
  /** Per-state counts for the CURRENT filter, minus the state filter itself. */
  readonly stateCounts: Readonly<Record<string, number>>;
  /**
   * Per-category counts for the CURRENT filter, minus the category and type
   * filters — so a category chip shows what selecting it would yield, the same
   * contract {@link stateCounts} gives the state tabs.
   *
   * `type` is dropped as well as `category` because picking a category clears
   * the type filter in the UI; leaving `type` applied would make every chip but
   * one read zero.
   *
   * Includes the {@link UNCLASSIFIED_CATEGORY} key for jobs whose event name has
   * no taxonomy entry. Without it the chips cannot sum to the "All" state tab
   * and the shortfall is unexplainable on screen — measured on a live appliance
   * as 587 of 9,557 jobs, and 54% of everything not dead-lettered.
   */
  readonly categoryCounts: Readonly<Record<string, number>>;
}

export interface JobHistoryPointDto {
  readonly at: string;
  readonly pending: number;
  readonly active: number;
  readonly retry: number;
  readonly deadLettered: number;
  readonly completed: number;
  readonly failed: number;
  readonly avgDurationMs: number | null;
  readonly p95DurationMs: number | null;
}

export interface JobHistoryDto {
  readonly points: readonly JobHistoryPointDto[];
  readonly queues: readonly string[];
  readonly bucketMinutes: number;
  readonly windowHours: number;
}

export interface JobCategoryHistoryPointDto {
  readonly at: string;
  /**
   * Jobs of each category ENQUEUED in this bucket. Zero-filled across every key
   * in {@link JobCategoryHistoryDto.categories}, so a chart can read a series
   * straight off the points without deciding what an absent key means.
   */
  readonly counts: Readonly<Record<string, number>>;
}

export interface JobCategoryHistoryDto {
  readonly points: readonly JobCategoryHistoryPointDto[];
  /** Categories actually present in the window, sorted — the chart's series. */
  readonly categories: readonly string[];
  readonly bucketMinutes: number;
  readonly windowHours: number;
  /**
   * Which store the returned buckets came from.
   *
   * `live` — every bucket was counted from `pgboss.job`/`archive` directly.
   * `metrics` — every bucket came from the sampled `ci.job_category_metrics`.
   * `mixed` — the recent end is live and the older end is sampled.
   *
   * Reported rather than inferred because the two differ in kind: the live
   * count is exact and the sampled one is only as complete as the collector's
   * uptime, and a reader cannot tell which they are looking at from the shape
   * of the curve.
   */
  readonly source: 'live' | 'metrics' | 'mixed';
}

export interface JobQuery {
  readonly state?: string;
  readonly queue?: string;
  readonly category?: string;
  /** Exact event name, e.g. `smart.rotation.work`. Narrower than `category`. */
  readonly type?: string;
  readonly search?: string;
  readonly limit?: number;
  readonly offset?: number;
}

/** Hard ceiling on a page, whatever the caller asks for. */
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

/** Window bounds shared by every chart endpoint. 30 days is the collector's retention. */
const MIN_WINDOW_HOURS = 1;
const MAX_WINDOW_HOURS = 24 * 30;
const DEFAULT_WINDOW_HOURS = 24;

/**
 * Bucket width for a window, so a 30-day chart is not 8,640 points.
 *
 * Shared by every series on the Jobs dashboard: two charts drawn from the same
 * window must land on the SAME x-axis, and they only do if they round time with
 * the same divisor. 5 minutes is the floor because that is the collector's
 * sample interval — a narrower bucket would draw gaps that are an artefact of
 * the sampler rather than of the queue.
 */
function bucketMinutesFor(windowHours: number): number {
  return windowHours <= 6 ? 5 : windowHours <= 48 ? 30 : 180;
}

/** Clamp a caller-supplied window to what the stores can actually answer for. */
function clampWindowHours(windowHours: number | undefined): number {
  return Math.min(Math.max(windowHours ?? DEFAULT_WINDOW_HOURS, MIN_WINDOW_HOURS), MAX_WINDOW_HOURS);
}

/**
 * The queryable view of the job tables.
 *
 * Split from `JobMonitorService` (which answers "how is the appliance doing?")
 * because this answers a different question — "find me these specific jobs" —
 * and it needs filtering, paging and a stable ordering that the summary does
 * not. Both read the same tables; neither writes.
 *
 * As with the dashboard summary, job payloads never leave here: rows are
 * projected to their taxonomy description plus a parsed failure. See
 * `JobRecordDto` in JobMonitorService for the reasoning.
 */
@Injectable()
export class JobQueryService {
  constructor(
    @InjectRepository(PgBossJobEntity)
    private readonly jobRepository: Repository<PgBossJobEntity>,
    @InjectRepository(PgBossArchiveEntity)
    private readonly archiveRepository: Repository<PgBossArchiveEntity>,
    @InjectRepository(JobMetricEntity)
    private readonly metricRepository: Repository<JobMetricEntity>,
    @InjectRepository(JobCategoryMetricEntity)
    private readonly categoryMetricRepository: Repository<JobCategoryMetricEntity>,
  ) {}

  async list(context: RequestContext, query: JobQuery): Promise<JobListDto> {
    if (!context.userId) {
      throw new UnauthorizedException('A user context is required.');
    }

    const userId = context.userId;

    const limit = Math.min(Math.max(query.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    const offset = Math.max(query.offset ?? 0, 0);

    const builder = this.jobRepository.createQueryBuilder('job');

    this.applyFilters(builder, query, userId);

    // `created_on DESC, id` — id breaks ties so paging cannot repeat or skip a
    // row when several jobs share a timestamp, which they routinely do during a
    // bulk enqueue.
    const [rows, total] = await builder
      .orderBy('job.createdOn', 'DESC')
      .addOrderBy('job.id', 'DESC')
      .skip(offset)
      .take(limit)
      .getManyAndCount();

    const [queues, counts] = await Promise.all([this.distinctQueues(), this.facetCounts(query, userId)]);

    return {
      items: rows.map((row) => this.toListItem(row)),
      total,
      limit,
      offset,
      queues,
      stateCounts: counts.stateCounts,
      categoryCounts: counts.categoryCounts,
    };
  }

  /**
   * Time series for the charts.
   *
   * Reads `ci.job_metrics`, not pg-boss: pg-boss's own tables hold roughly
   * thirty-six hours of working set, so anything older than that only exists
   * because the collector wrote it down.
   */
  async history(
    context: RequestContext,
    options: { windowHours?: number; queue?: string } = {},
  ): Promise<JobHistoryDto> {
    if (!context.userId) {
      throw new UnauthorizedException('A user context is required.');
    }

    const windowHours = clampWindowHours(options.windowHours);
    const since = new Date(Date.now() - windowHours * 60 * 60_000);
    const bucketMinutes = bucketMinutesFor(windowHours);

    const builder = this.metricRepository
      .createQueryBuilder('metric')
      .select(
        `to_timestamp(floor(extract(epoch from metric.sampled_at) / :bucketSeconds) * :bucketSeconds)`,
        'at',
      )
      // Depth is a GAUGE: summing across queues inside a bucket is right (total
      // work outstanding), but summing across TIME is not — so take the last
      // sample in the bucket per queue, then add up. AVG over the bucket is the
      // honest simplification here and avoids a window function per queue.
      .addSelect('ROUND(AVG(metric.pending))::int', 'pending')
      .addSelect('ROUND(AVG(metric.active))::int', 'active')
      .addSelect('ROUND(AVG(metric.retry))::int', 'retry')
      .addSelect('ROUND(AVG(metric.dead_lettered))::int', 'deadLettered')
      // Throughput is a DELTA: summing across both queue and time is correct.
      .addSelect('SUM(metric.completed)::int', 'completed')
      .addSelect('SUM(metric.failed)::int', 'failed')
      .addSelect('ROUND(AVG(metric.avg_duration_ms))::int', 'avgDurationMs')
      .addSelect('MAX(metric.p95_duration_ms)::int', 'p95DurationMs')
      .where('metric.sampled_at >= :since', { since })
      .setParameter('bucketSeconds', bucketMinutes * 60)
      .groupBy('1')
      .orderBy('1', 'ASC');

    if (options.queue) {
      builder.andWhere('metric.queue = :queue', { queue: options.queue });
    }

    const rows = await builder.getRawMany<{
      at: Date;
      pending: number;
      active: number;
      retry: number;
      deadLettered: number;
      completed: number;
      failed: number;
      avgDurationMs: number | null;
      p95DurationMs: number | null;
    }>();

    const queues = await this.metricRepository
      .createQueryBuilder('metric')
      .select('DISTINCT metric.queue', 'queue')
      .where('metric.sampled_at >= :since', { since })
      .orderBy('queue', 'ASC')
      .getRawMany<{ queue: string }>();

    return {
      points: rows.map((row) => ({
        at: new Date(row.at).toISOString(),
        pending: Number(row.pending) || 0,
        active: Number(row.active) || 0,
        retry: Number(row.retry) || 0,
        deadLettered: Number(row.deadLettered) || 0,
        completed: Number(row.completed) || 0,
        failed: Number(row.failed) || 0,
        avgDurationMs: row.avgDurationMs == null ? null : Number(row.avgDurationMs),
        p95DurationMs: row.p95DurationMs == null ? null : Number(row.p95DurationMs),
      })),
      queues: queues.map((row) => row.queue),
      bucketMinutes,
      windowHours,
    };
  }

  /**
   * Job volume by CATEGORY over time — the second chart on the Jobs dashboard.
   *
   * Two stores, unioned, because neither one alone can answer the question
   * honestly:
   *
   *  - `pgboss.job` + `pgboss.archive` hold about thirty-six hours (twelve to
   *    archive, twenty-four of archive retention). Inside that window they are
   *    the exact answer, and they are the answer from the moment this ships —
   *    a chart that only read the sampled table would be empty until the
   *    collector had run for a day.
   *  - `ci.job_category_metrics` is the only thing that remembers anything
   *    older, and it starts accumulating from the first sample after deploy.
   *
   * So: live for every bucket pg-boss still covers, sampled for the rest, and
   * {@link JobCategoryHistoryDto.source} says which happened. The seam is a
   * bucket boundary, never mid-bucket — a bucket only half-covered by pg-boss
   * would silently under-count, which on a chart is indistinguishable from a
   * quiet period.
   *
   * Both halves count ARRIVALS (`created_on`), not throughput. It is the only
   * measure both stores can produce for the same jobs, and the only one that
   * shows a category which is backing up rather than draining — which is when
   * anyone actually opens this chart.
   */
  async categoryHistory(
    context: RequestContext,
    options: { windowHours?: number } = {},
  ): Promise<JobCategoryHistoryDto> {
    if (!context.userId) {
      throw new UnauthorizedException('A user context is required.');
    }

    const windowHours = clampWindowHours(options.windowHours);
    const now = Date.now();
    const since = new Date(now - windowHours * 60 * 60_000);
    // Same scaling as history(), so the two charts share an x-axis.
    const bucketMinutes = bucketMinutesFor(windowHours);
    const bucketSeconds = bucketMinutes * 60;

    const liveFrom = await this.liveCoverageFrom(bucketSeconds);

    // `at` (epoch ms) -> category -> count. A Map keyed on the bucket instant
    // is what lets the two sources be poured into the same series without
    // either one having to know the other exists.
    const buckets = new Map<number, Map<string, number>>();

    const add = (at: Date | string, category: string, count: number): void => {
      const key = new Date(at).getTime();
      const bucket = buckets.get(key) ?? new Map<string, number>();

      bucket.set(category, (bucket.get(category) ?? 0) + count);
      buckets.set(key, bucket);
    };

    let usedLive = false;
    let usedMetrics = false;

    if (liveFrom != null && liveFrom.getTime() < now) {
      const liveSince = new Date(Math.max(liveFrom.getTime(), since.getTime()));

      // Raw SQL, not a QueryBuilder: this is a UNION ALL across two tables that
      // map to two different entities, which is not a shape TypeORM's builder
      // expresses. `JobMetricsCollector.readThroughput` unions the same pair for
      // the same reason.
      //
      // GROUPED ON `data->>'name'` — THE EVENT — NEVER ON `name`, the queue. A
      // dead-lettered row's queue column is the literal `dead-letter`: pg-boss
      // copies `data` verbatim onto the DLQ row and rewrites the queue, so the
      // queue is gone for 8,431 of 19,606 rows (43%) on a live appliance. A
      // queue-keyed grouping would file all of them under one bucket that maps
      // to no category at all.
      //
      // Those DLQ copies are excluded outright, because the copy carries a
      // FRESH `created_on` — the instant the job was dead-lettered, not the
      // instant the work arrived. Counting it would draw a surge of new work at
      // exactly the moment work started failing. The original row survives in
      // its own partition with `state = 'failed'` and is what supplies the
      // arrival.
      const liveRows = (await this.jobRepository.manager.query(
        `
        SELECT to_timestamp(floor(extract(epoch from live.created_on) / $2) * $2) AS at,
               live.data->>'name' AS event,
               COUNT(*)::int AS count
          FROM (
            SELECT data, created_on FROM pgboss.job     WHERE created_on >= $1 AND name <> $3
            UNION ALL
            SELECT data, created_on FROM pgboss.archive WHERE created_on >= $1 AND name <> $3
          ) AS live
         GROUP BY 1, 2
        `,
        [liveSince, bucketSeconds, DEAD_LETTER_QUEUE],
      )) as Array<{ at: Date; event: string | null; count: number }>;

      for (const row of liveRows) {
        // categoryOfEvent, the same fold facetCounts uses for the chips —
        // never describeJob(), whose per-queue overrides would put an event
        // under a category its own filter resolves somewhere else.
        add(row.at, categoryOfEvent(row.event), Number(row.count) || 0);
      }

      usedLive = liveRows.length > 0;
    }

    // Only when live coverage does not already reach the start of the window.
    // Rows the live half has counted must not be counted a second time here,
    // which is what the `< liveFrom` bound below enforces.
    if (liveFrom == null || liveFrom.getTime() > since.getTime()) {
      const builder = this.categoryMetricRepository
        .createQueryBuilder('metric')
        .select(
          `to_timestamp(floor(extract(epoch from metric.sampled_at) / :bucketSeconds) * :bucketSeconds)`,
          'at',
        )
        .addSelect('metric.category', 'category')
        // `arrived` is a DELTA over the sample interval, so summing across both
        // category and time is correct — unlike the gauges in this table.
        .addSelect('SUM(metric.arrived)::int', 'count')
        .where('metric.sampled_at >= :since', { since })
        .setParameter('bucketSeconds', bucketSeconds)
        .groupBy('1, 2');

      if (liveFrom != null) {
        builder.andWhere('metric.sampled_at < :liveFrom', { liveFrom });
      }

      const metricRows = await builder.getRawMany<{ at: Date; category: string; count: number }>();

      for (const row of metricRows) {
        add(row.at, row.category, Number(row.count) || 0);
      }

      usedMetrics = metricRows.length > 0;
    }

    const categories = [...new Set([...buckets.values()].flatMap((bucket) => [...bucket.keys()]))].sort();

    const points = [...buckets.entries()]
      .sort(([a], [b]) => a - b)
      .map(([at, counts]) => ({
        at: new Date(at).toISOString(),
        // Zero-filled: a chart drawing one line per category needs a value at
        // every point it plots, and "this category had no jobs in this bucket"
        // is a real zero, not missing data.
        counts: Object.fromEntries(categories.map((category) => [category, counts.get(category) ?? 0])),
      }));

    return {
      points,
      categories,
      bucketMinutes,
      windowHours,
      // Nothing came back from either store: say which one was actually
      // authoritative rather than guessing. `liveFrom == null` means pg-boss
      // holds no rows at all, so only the sampled table could have answered.
      source:
        usedLive && usedMetrics
          ? 'mixed'
          : usedLive
            ? 'live'
            : usedMetrics
              ? 'metrics'
              : liveFrom == null
                ? 'metrics'
                : 'live',
    };
  }

  /**
   * The oldest instant `pgboss.job`/`archive` can still be trusted for, rounded
   * UP to the next bucket boundary.
   *
   * Excludes the dead-letter queue, and that exclusion is the whole point.
   * Every work queue is pruned on the ~36h cycle, but the DLQ carries a 30-day
   * retention and nothing consumes it (see `PGBossEventService.onModuleInit`),
   * so an unfiltered `MIN(created_on)` reports up to a MONTH of live coverage
   * that exists only for dead-letter copies. Every bucket older than 36h would
   * then be served from a live query that finds nothing, and the chart would
   * render weeks of confident zeros instead of falling back to the sampled
   * table.
   *
   * Rounded up rather than down because the bucket containing this instant is
   * only partly covered — the rows before it have been pruned. Handing that
   * bucket to the sampled table (which has the whole interval, if the collector
   * was running) is right; drawing it from a partial live scan is a dip that
   * never happened.
   */
  private async liveCoverageFrom(bucketSeconds: number): Promise<Date | null> {
    const [row] = (await this.jobRepository.manager.query(
      `
      SELECT MIN(created_on) AS oldest
        FROM (
          SELECT created_on FROM pgboss.job     WHERE name <> $1
          UNION ALL
          SELECT created_on FROM pgboss.archive WHERE name <> $1
        ) AS live
      `,
      [DEAD_LETTER_QUEUE],
    )) as Array<{ oldest: Date | string | null }>;

    if (row?.oldest == null) {
      return null;
    }

    const bucketMs = bucketSeconds * 1000;

    return new Date(Math.ceil(new Date(row.oldest).getTime() / bucketMs) * bucketMs);
  }

  /**
   * Filters shared by the list and its state-count sidebar.
   *
   * `category` resolves through the taxonomy to a set of event names and is
   * matched on `data->>'name'`, so filtering by "what kind of work is this"
   * happens in SQL rather than by over-fetching and filtering in the browser.
   */
  private applyFilters(
    builder: ReturnType<Repository<PgBossJobEntity>['createQueryBuilder']>,
    query: JobQuery,
    userId: string,
    options: { skipState?: boolean; skipCategory?: boolean; skipType?: boolean } = {},
  ): void {
    if (query.state && !options.skipState) {
      if (query.state === 'dead-letter') {
        builder.andWhere('job.name = :deadLetter', { deadLetter: DEAD_LETTER_QUEUE });
      } else {
        builder
          .andWhere('job.state = :state', { state: query.state })
          .andWhere('job.name != :deadLetter', { deadLetter: DEAD_LETTER_QUEUE });
      }
    }

    if (query.queue) {
      builder.andWhere('job.name = :queue', { queue: query.queue });
    }

    // Exact event name. `category` groups many events; this picks one, which is
    // what an operator wants once they know WHICH job is misbehaving.
    if (query.type && !options.skipType) {
      builder.andWhere(`job.data->>'name' = :type`, { type: query.type });
    }

    if (query.category && !options.skipCategory) {
      if (query.category === UNCLASSIFIED_CATEGORY) {
        // The complement of the taxonomy: every row whose event has no
        // JOB_TYPES entry. Without this the chip counts a bucket nobody can
        // click into, which is worse than not counting it — it names a problem
        // and then refuses to show you which jobs cause it.
        //
        // Note this stays keyed on JOB_TYPES alone, deliberately, even though
        // the real-category branch below is queue-aware: `jobCategorySelector`
        // can only move events that HAVE an entry, so the complement is the
        // same set either way, and matching it queue-aware would exclude
        // dead-lettered rows whose queue column no longer says where they ran.
        const known = Object.keys(JOB_TYPES);

        builder.andWhere(
          new Brackets((where) => {
            where.where(`job.data->>'name' IS NULL`);

            if (known.length > 0) {
              where.orWhere(`job.data->>'name' NOT IN (:...known)`, { known });
            }
          }),
        );
      } else {
        // A category is not simply a set of event names: `describeJob` resolves
        // a row's category from the (event, queue) pair, so the handful of
        // events that mean different things on different queues have to be
        // moved in and out here too. Selecting on event alone returned rows
        // this same endpoint then labelled with a DIFFERENT category — see
        // `jobCategorySelector`.
        const selector = jobCategorySelector(query.category);
        // `job.name` is the queue; `data->>'name'` is the event.
        const queueKey = `(job.data->>'name' || '::' || job.name)`;

        builder.andWhere(
          new Brackets((where) => {
            // An unknown category matches nothing rather than everything — a
            // typo in a query string should return an empty table, not the
            // unfiltered one — so an empty event list becomes a sentinel.
            const excludes =
              selector.excludeQueueKeys.length > 0
                ? ` AND ${queueKey} NOT IN (:...excludedQueueKeys)`
                : '';

            where.where(`job.data->>'name' IN (:...categoryEvents)${excludes}`, {
              categoryEvents: selector.events.length > 0 ? selector.events : ['__no-such-category__'],
              excludedQueueKeys: selector.excludeQueueKeys,
            });

            if (selector.includeQueueKeys.length > 0) {
              where.orWhere(`${queueKey} IN (:...includedQueueKeys)`, {
                includedQueueKeys: selector.includeQueueKeys,
              });
            }
          }),
        );
      }
    }

    if (query.search) {
      const term = `%${query.search.trim()}%`;

      // Event name, queue name and the failure message — the three things an
      // operator actually types. NOT the payload: that is user content, and the
      // whole point of the projection is that it never leaves the server.
      //
      // Event/queue names are taxonomy values, the same for every user, so they
      // stay unscoped. The failure message is a different user's job output —
      // this is a multi-user appliance with no admin role, so matching it is
      // restricted to jobs `data->>'userId'` says the caller owns.
      builder.andWhere(
        new Brackets((where) => {
          where
            .where(`job.data->>'name' ILIKE :term`, { term })
            .orWhere('job.name ILIKE :term', { term })
            .orWhere(`job.output->>'message' ILIKE :term AND job.data->>'userId' = :userId`, {
              term,
              userId,
            });
        }),
      );
    }
  }

  /**
   * Both badge sets, from ONE grouped scan.
   *
   * The state tabs and the category chips make the same promise — each shows
   * what selecting it would yield — and they differ only in which filter each
   * one drops. That makes them two folds of a single
   * `GROUP BY bucket, event`, rather than two full scans of a partitioned table
   * on every 15-second poll. Measured on a live appliance (9,557 rows, 39
   * partitions): 6.3 ms execution against 4.5 ms for the state counts alone, so
   * the second badge set is very nearly free and the request keeps its original
   * query count.
   *
   * Folding both from the same rows is also what makes the two sets consistent
   * by construction: they cannot disagree about a job, because they are counting
   * the same job.
   *
   * GROUPING IS ON `data->>'name'` — THE EVENT — NEVER ON `job.name`. A
   * dead-lettered row's `job.name` is the literal `dead-letter`: pg-boss copies
   * `data` verbatim onto the DLQ row but rewrites the queue column, so the queue
   * it died on is gone forever. On a live appliance 88% of rows are
   * dead-lettered, which would make any queue-keyed grouping report almost
   * nothing.
   */
  private async facetCounts(
    query: JobQuery,
    userId: string,
  ): Promise<{ stateCounts: Record<string, number>; categoryCounts: Record<string, number> }> {
    const builder = this.jobRepository
      .createQueryBuilder('job')
      // `job.state::text` is load-bearing. Postgres unifies a CASE's branches to
      // one type, and without the cast it picks the `pgboss.job_state` ENUM from
      // the ELSE branch — then tries to coerce the literal `'dead-letter'` into
      // it and fails with "invalid input value for enum". `dead-letter` is a
      // QUEUE, never a state, so the bucket column has to be text.
      .select(`CASE WHEN job.name = :deadLetter THEN 'dead-letter' ELSE job.state::text END`, 'bucket')
      .addSelect(`job.data->>'name'`, 'event')
      .addSelect('COUNT(*)::int', 'count')
      .setParameter('deadLetter', DEAD_LETTER_QUEUE)
      // One `groupBy` call, not `groupBy().addGroupBy()` — the unit suite drives
      // this through a hand-rolled mock builder that implements neither.
      .groupBy('1, 2');

    this.applyFilters(builder, query, userId, { skipState: true, skipCategory: true, skipType: true });

    const rows = await builder.getRawMany<{ bucket: string; event: string | null; count: number }>();

    const stateCounts: Record<string, number> = {};
    const categoryCounts: Record<string, number> = {};

    for (const row of rows) {
      const count = Number(row.count) || 0;
      // JOB_TYPES, NOT describeJob() — see categoryOfEvent for why, and why the
      // expression is shared rather than repeated: the category chart samples
      // and aggregates through the same function, so a chip and a series can
      // never put the same job in two different buckets.
      const categoryKey = categoryOfEvent(row.event);

      // Each fold re-applies the filter the OTHER one dropped, so both sets keep
      // the "what would selecting this yield" contract. `bucket` has already
      // collapsed the dead-letter queue, so comparing it to `query.state`
      // reproduces both arms of the SQL predicate in applyFilters.
      const matchesState = !query.state || row.bucket === query.state;
      const matchesCategory = !query.category || categoryKey === query.category;
      const matchesType = !query.type || row.event === query.type;

      if (matchesCategory && matchesType) {
        stateCounts[row.bucket] = (stateCounts[row.bucket] ?? 0) + count;
      }

      if (matchesState) {
        categoryCounts[categoryKey] = (categoryCounts[categoryKey] ?? 0) + count;
      }
    }

    return { stateCounts, categoryCounts };
  }

  private async distinctQueues(): Promise<string[]> {
    const rows = await this.jobRepository
      .createQueryBuilder('job')
      .select('DISTINCT job.name', 'queue')
      .orderBy('queue', 'ASC')
      .getRawMany<{ queue: string }>();

    return rows.map((row) => row.queue);
  }

  private toListItem(job: PgBossJobEntity | PgBossArchiveEntity): JobListItemDto {
    const data = job.data ?? {};
    const event = typeof data['name'] === 'string' ? data['name'] : null;
    const workType = typeof data['workType'] === 'string' ? data['workType'] : null;
    // job.name is the pg-boss QUEUE (see PgBossJobEntity), not the event —
    // it's what disambiguates an event two unrelated listeners share.
    const descriptor = describeJob(event, workType, job.name);

    const durationMs =
      job.startedOn && job.completedOn
        ? Math.max(job.completedOn.getTime() - job.startedOn.getTime(), 0)
        : null;

    return {
      id: job.id,
      queue: job.name,
      state: job.state,
      event,
      workType,
      label: descriptor.label,
      category: descriptor.category,
      description: descriptor.description,
      interactive: Boolean(descriptor.interactive),
      createdOn: job.createdOn.toISOString(),
      startedOn: job.startedOn ? job.startedOn.toISOString() : null,
      completedOn: job.completedOn ? job.completedOn.toISOString() : null,
      durationMs,
      retryCount: job.retryCount,
      retryLimit: job.retryLimit,
      payloadBytes: this.byteLength(data),
      failure: this.toFailure(job.output),
      deadLettered: job.name === DEAD_LETTER_QUEUE,
    };
  }

  private toFailure(
    output: Record<string, unknown> | null,
  ): { message: string; stack?: string; failedAt?: string } | null {
    if (!output || typeof output !== 'object') {
      return null;
    }

    const message = typeof output['message'] === 'string' ? output['message'].trim() : '';

    if (!message) {
      return null;
    }

    return {
      message,
      stack: typeof output['stack'] === 'string' ? output['stack'] : undefined,
      failedAt: typeof output['failedAt'] === 'string' ? output['failedAt'] : undefined,
    };
  }

  private byteLength(data: Record<string, unknown>): number {
    try {
      return Buffer.byteLength(JSON.stringify(data) ?? '', 'utf8');
    } catch {
      return 0;
    }
  }
}
