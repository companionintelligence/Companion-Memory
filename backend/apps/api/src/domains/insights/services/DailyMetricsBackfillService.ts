import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import type { UserServiceContext } from '@ci/common/context';
import { LoggerService } from '@ci/common/logging';
import { EventService } from '@ci/domains/events';

import { shiftIso, todayIso } from '../dateUtil';
import { DailyMetricEntity } from '../entities/DailyMetricEntity';
import { DAILY_METRICS_QUEUE, DailyMetricsComputeRequestEvent } from '../events';

/** Default window width per enqueued chunk job. */
export const DEFAULT_CHUNK_DAYS = 30;

/** One (endDate, days) compute window; maps 1:1 onto an enqueued PGBoss job. */
export interface BackfillChunk {
  endDate: string;
  days: number;
}

export interface BackfillOptions {
  /** Inclusive start date (YYYY-MM-DD). Default: the user's earliest captured data. */
  fromDate?: string;
  /** Inclusive end date (YYYY-MM-DD). Default: today (UTC). */
  toDate?: string;
  /** Days per chunk job (default {@link DEFAULT_CHUNK_DAYS}). */
  chunkDays?: number;
  /** IANA timezone for day bucketing (default UTC). */
  timezone?: string;
}

export interface BackfillResult {
  status: 'enqueued' | 'noop';
  /** The resolved range actually enqueued (null when noop). */
  fromDate: string | null;
  toDate: string | null;
  /** Total days across all chunks. */
  days: number;
  /** Number of chunk jobs enqueued on the daily-metrics queue. */
  chunks: number;
}

/** Inclusive day count between two YYYY-MM-DD dates (UTC, DST-free). */
function daysBetweenInclusive(from: string, to: string): number {
  const a = new Date(`${from}T00:00:00Z`).getTime();
  const b = new Date(`${to}T00:00:00Z`).getTime();

  return Math.round((b - a) / 86_400_000) + 1;
}

/**
 * Split an inclusive [fromDate, toDate] range into contiguous compute windows of
 * at most `chunkDays` days, oldest first. Pure — exported for unit tests.
 */
export function planBackfillChunks(fromDate: string, toDate: string, chunkDays: number): BackfillChunk[] {
  if (chunkDays < 1 || fromDate > toDate) {
    return [];
  }

  const chunks: BackfillChunk[] = [];
  let chunkStart = fromDate;

  while (chunkStart <= toDate) {
    const idealEnd = shiftIso(chunkStart, chunkDays - 1);
    const chunkEnd = idealEnd <= toDate ? idealEnd : toDate;

    chunks.push({ endDate: chunkEnd, days: daysBetweenInclusive(chunkStart, chunkEnd) });
    chunkStart = shiftIso(chunkEnd, 1);
  }

  return chunks;
}

/**
 * Historical backfill for ci_derived.daily_metrics. Resolves the user's data
 * range (earliest captured row across the four source tables → today), splits
 * it into bounded chunks, and enqueues one PGBoss job per chunk on the
 * daily-metrics queue — the SAME consumer as the nightly cron. Safe at ~1M-row
 * scale: each job computes at most `chunkDays` days (17 indexed sub-aggregates
 * per day), and the queue drains them sequentially out-of-band.
 *
 * Resumable/idempotent: every day is an upsert on (user_id, date); re-running
 * the backfill (or retrying a failed chunk) just recomputes those days.
 */
@Injectable()
export class DailyMetricsBackfillService {
  constructor(
    @InjectRepository(DailyMetricEntity)
    private readonly repository: Repository<DailyMetricEntity>,
    private readonly eventService: EventService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(DailyMetricsBackfillService.name);
  }

  async backfill(context: UserServiceContext, options: BackfillOptions = {}): Promise<BackfillResult> {
    const timezone = options.timezone ?? 'UTC';
    const toDate = options.toDate ?? todayIso();
    const fromDate = options.fromDate ?? (await this.findEarliestDataDate(context, timezone));

    if (fromDate === null || fromDate > toDate) {
      return { status: 'noop', fromDate: null, toDate: null, days: 0, chunks: 0 };
    }

    const chunks = planBackfillChunks(fromDate, toDate, options.chunkDays ?? DEFAULT_CHUNK_DAYS);
    const days = chunks.reduce((acc, chunk) => acc + chunk.days, 0);

    for (const chunk of chunks) {
      await this.eventService.send(
        DailyMetricsComputeRequestEvent,
        { userId: context.userId, endDate: chunk.endDate, days: chunk.days, timezone },
        { queue: DAILY_METRICS_QUEUE },
      );
    }

    this.logger.log('Enqueued daily-metrics backfill', {
      userId: context.userId,
      fromDate,
      toDate,
      days,
      chunks: chunks.length,
      timezone,
    });

    return { status: 'enqueued', fromDate, toDate, days, chunks: chunks.length };
  }

  /**
   * The user's earliest captured local calendar day across the four raw source
   * tables, or null when the user has no capture data at all. LEAST ignores
   * NULLs, so a user with (say) only communications still resolves.
   */
  async findEarliestDataDate(context: UserServiceContext, timezone: string): Promise<string | null> {
    const rows = (await this.repository.query(
      `SELECT to_char(
                (LEAST(
                  (SELECT min(c.time)        FROM ci.communications c   WHERE c.user_id = $1),
                  (SELECT min(pos.time)      FROM ci.position pos       WHERE pos.user_id = $1),
                  (SELECT min(b.time)        FROM ci.browser_activity b WHERE b.user_id = $1),
                  (SELECT min(i.acquired_at) FROM ci.inventory i        WHERE i.user_id = $1)
                ) AT TIME ZONE $2)::date,
                'YYYY-MM-DD'
              ) AS min_date`,
      [context.userId, timezone],
    )) as Array<{ min_date: string | null }>;

    return rows[0]?.min_date ?? null;
  }
}
