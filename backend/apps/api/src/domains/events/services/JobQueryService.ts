import { Injectable, UnauthorizedException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Brackets, Repository } from 'typeorm';

import { RequestContext } from '@ci/common/context';

import { DEAD_LETTER_QUEUE } from '../constants';
import { JobMetricEntity } from '../entities/JobMetricEntity';
import { PgBossArchiveEntity } from '../entities/PgBossArchiveEntity';
import { PgBossJobEntity } from '../entities/PgBossJobEntity';
import { describeJob, jobCategorySelector } from '../taxonomy';

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

    const [queues, stateCounts] = await Promise.all([this.distinctQueues(), this.stateCounts(query, userId)]);

    return {
      items: rows.map((row) => this.toListItem(row)),
      total,
      limit,
      offset,
      queues,
      stateCounts,
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

    const windowHours = Math.min(Math.max(options.windowHours ?? 24, 1), 24 * 30);
    const since = new Date(Date.now() - windowHours * 60 * 60_000);

    // Bucket width scales with the window so a 30-day chart is not 8,640
    // points. The collector samples every 5 minutes, so that is the floor.
    const bucketMinutes = windowHours <= 6 ? 5 : windowHours <= 48 ? 30 : 180;

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
    options: { skipState?: boolean } = {},
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
    if (query.type) {
      builder.andWhere(`job.data->>'name' = :type`, { type: query.type });
    }

    if (query.category) {
      // A category is not simply a set of event names: `describeJob` resolves a
      // row's category from the (event, queue) pair, so the handful of events
      // that mean different things on different queues have to be moved in and
      // out here too. Selecting on event alone returned rows this same endpoint
      // then labelled with a DIFFERENT category — see `jobCategorySelector`.
      const selector = jobCategorySelector(query.category);
      // `job.name` is the queue; `data->>'name'` is the event.
      const queueKey = `(job.data->>'name' || '::' || job.name)`;

      builder.andWhere(
        new Brackets((where) => {
          // An unknown category matches nothing rather than everything — a typo
          // in a query string should return an empty table, not the unfiltered
          // one — so an empty event list becomes a sentinel, not a no-op.
          const excludes =
            selector.excludeQueueKeys.length > 0 ? ` AND ${queueKey} NOT IN (:...excludedQueueKeys)` : '';

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
   * Counts per state under the current filter, ignoring the state filter itself
   * — so the tabs show what selecting each one would yield, rather than
   * collapsing to the tab you already picked.
   */
  private async stateCounts(query: JobQuery, userId: string): Promise<Record<string, number>> {
    const builder = this.jobRepository
      .createQueryBuilder('job')
      // `job.state::text` is load-bearing. Postgres unifies a CASE's branches to
      // one type, and without the cast it picks the `pgboss.job_state` ENUM from
      // the ELSE branch — then tries to coerce the literal `'dead-letter'` into
      // it and fails with "invalid input value for enum". `dead-letter` is a
      // QUEUE, never a state, so the bucket column has to be text.
      .select(`CASE WHEN job.name = :deadLetter THEN 'dead-letter' ELSE job.state::text END`, 'bucket')
      .addSelect('COUNT(*)::int', 'count')
      .setParameter('deadLetter', DEAD_LETTER_QUEUE)
      .groupBy('1');

    this.applyFilters(builder, query, userId, { skipState: true });

    const rows = await builder.getRawMany<{ bucket: string; count: number }>();

    return Object.fromEntries(rows.map((row) => [row.bucket, Number(row.count) || 0]));
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
