import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

import { LoggerService } from '@ci/common/logging';
import { PythonFunctionService } from '@ci/domains/python-functions';
import { SummaryEntity } from '@ci/domains/summaries';

/** Safety bound on a single call's blast radius (see {@link SummaryBackfillOptions.maxDays}). */
const DEFAULT_MAX_DAYS = 400;

/** How long a phase waits for its dispatched jobs to land before giving up on the drain. */
const DEFAULT_DRAIN_TIMEOUT_MS = 20 * 60 * 1000;

/** @internal Test seam — poll cadence of the per-phase drain. */
const DEFAULT_DRAIN_POLL_INTERVAL_MS = 3_000;

/**
 * Source tables the day-activity pre-check treats as evidence a UTC day is
 * worth summarizing. A subset of `ci.summary`'s own aggregator (`TABLES` in
 * `data_aggregator.py`, which also reads `messages`, `api_logs` and
 * `screen_captures`) — those three are appliance-runtime tables (AI chat
 * turns, desktop-capture telemetry) rather than anything a bulk IMPORT
 * populates, and excluding them keeps this a single bounded query instead of
 * ten. A day whose ONLY content lands in one of the excluded tables is
 * skipped by the pre-check (never dispatched) even though it has real
 * activity — the trade-off documented in {@link SummaryBackfillService}.
 *
 * `data_aggregator.py`'s `TABLES` also lists `activities` and `measurements`,
 * but neither exists anywhere in the `ci` schema (verified directly against
 * `information_schema.tables` — not merely missing the `ci.` prefix every
 * other entry here has). The Python aggregator survives this: it introspects
 * a table's columns before querying and treats "no columns found" as "no
 * rows", so those two entries have always silently contributed nothing.
 * This UNION query has no such guard, so including them here made every
 * single backfill call fail outright with `relation "activities" does not
 * exist` — not degraded, not partial, a 100% failure of the whole leg,
 * confirmed live against a real 844,885-record import where `ci.summaries`
 * stayed completely empty as a result. Left out rather than guessed at:
 * whatever "activities"/"measurements" were meant to name doesn't exist to
 * query either way, so dropping them is strictly a bug fix, not a narrowing
 * of real coverage.
 */
const ACTIVITY_SOURCES = [
  { table: 'ci.events', column: 'start_time' },
  { table: 'ci.communications', column: 'time' },
  { table: 'ci.files', column: 'created_at' },
  { table: 'ci.position', column: 'time' },
  { table: 'ci.browser_activity', column: 'time' },
] as const;

export interface SummaryBackfillOptions {
  /** Lower bound (inclusive). Defaults to the earliest activity on record. */
  startTime?: Date;
  /** Upper bound (exclusive). Defaults to the latest activity on record, capped at the current UTC hour. */
  endTime?: Date;
  /**
   * Hard cap on the [start, end) span this ONE call will act on (default 400
   * days) — the backstop against a first, option-less call over years of
   * history turning into tens of thousands of hourly dispatches. The call is
   * safe to repeat: each invocation only dispatches windows that still lack a
   * summary, so a range wider than the cap is covered by calling again with
   * `startTime` advanced past what the previous call reported.
   */
  maxDays?: number;
  /** Per-phase drain timeout in ms (default 20 minutes). */
  drainTimeoutMs?: number;
  /** @internal Test seam — poll cadence of the per-phase drain. */
  drainPollIntervalMs?: number;
  /** Invoked once per phase transition with cumulative counts. */
  onProgress?: (partial: SummaryBackfillProgressEvent) => void;
}

export interface SummaryBackfillProgressEvent {
  phase: 'hourly' | 'daily' | 'weekly' | 'monthly';
  enqueued: number;
  deduped: number;
  landed: number;
  expected: number;
  drained: boolean;
}

export interface SummaryBackfillPhaseResult {
  /** Windows this call dispatched a job for. */
  enqueued: number;
  /** Windows a job was already pending for (pg-boss singletonKey collapsed the dispatch). */
  deduped: number;
  /** Of the windows THIS call dispatched, how many now have a summary row. */
  landed: number;
  /** Windows this call dispatched (== enqueued + deduped); the drain's denominator. */
  expected: number;
  /** Whether every dispatched window landed before the drain timeout elapsed. */
  drained: boolean;
}

export interface SummaryBackfillResult {
  /** The [start, end) actually scanned (ISO strings), or null when there is no activity at all. */
  range: { start: string; end: string } | null;
  /** UTC days in range with at least one row in an {@link ACTIVITY_SOURCES} table. */
  daysWithActivity: number;
  /** Of those, days that already had a `daily` summary and were left alone. */
  daysAlreadySummarized: number;
  /** Days with activity whose hourly dispatch landed nothing, so no daily rollup was attempted. */
  daysWithoutLandedHourly: string[];
  /** True when the resolved range exceeded `maxDays` and was clamped. */
  truncated: boolean;
  hourly: SummaryBackfillPhaseResult;
  daily: SummaryBackfillPhaseResult;
  weekly: SummaryBackfillPhaseResult;
  monthly: SummaryBackfillPhaseResult;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const DAY_MS = 24 * 60 * 60 * 1000;

function utcDayStart(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function utcHourStart(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), d.getUTCHours()));
}

/** Monday-start UTC week containing `d`. */
function utcWeekStart(d: Date): Date {
  const day = utcDayStart(d);
  const dow = day.getUTCDay(); // 0 = Sunday .. 6 = Saturday
  const sinceMonday = dow === 0 ? 6 : dow - 1;

  return new Date(day.getTime() - sinceMonday * DAY_MS);
}

function utcMonthStart(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

function addMonths(d: Date, n: number): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
}

const hourKeyOf = (d: Date) => d.toISOString().slice(0, 13);
const dayKeyOf = (d: Date) => d.toISOString().slice(0, 10);
const weekKeyOf = (d: Date) => `week:${d.toISOString().slice(0, 10)}`;
const monthKeyOf = (d: Date) => d.toISOString().slice(0, 7);

/**
 * Historical summary backfill.
 *
 * `ci.summary`'s hourly/daily/weekly/monthly functions only ever run against
 * "now" — `PythonFunctionCrons` fans them out once per live tick, and nothing
 * else calls them with a past `start_time`/`end_time` in bulk. Bulk-imported
 * content whose timestamps predate a user's onboarding therefore never gets a
 * summary and can never reach `ci.summaries` — those functions already accept
 * explicit windows (see `functions.py`), so this service supplies the missing
 * half: it enumerates the UTC hours/days/weeks/months in a range, dispatches
 * one job per window that doesn't already have a summary, and drains each
 * cascade level (hourly -> daily -> weekly -> monthly) before starting the
 * next, because a rollup errors out when it finds zero children
 * (`_rollup_summary` in functions.py).
 *
 * Deliberately does NOT touch `dossier_refresh`: the dossier is a ROLLING
 * recent-context window (`fetch_summaries_for_dossier_activity` only looks
 * back `lookback_days` from `end_time`), not an append-only archive. Calling
 * it with a historical `end_time` would overwrite the user's current dossier
 * with a stale one built only from the backfilled range. The existing hourly
 * dossier cron (`end_time = now`) picks up newly-backfilled summaries on its
 * own the moment they fall inside its lookback window; for anything older
 * than that, the dossier is simply out of scope for a historical backfill.
 *
 * Re-runnable and idempotent: every dispatch is gated on a summary not
 * already existing for that window (checked here) AND carries the same
 * `fn:<function>:<userId>:<windowKey>` singleton key the live crons use
 * (enforced pg-boss-side, `policy: 'short'` — see PYTHON_FUNCTION_QUEUE_OPTIONS),
 * so a second call — or a retry after a drain timeout — only ever dispatches
 * what is still missing.
 *
 * Operator-triggered via the `backfill_summaries` orchestrate leg or its
 * standalone endpoint; never auto-run. Unlike the enqueue-and-return legs
 * (geocode, media_dimensions), this runs the full multi-phase cascade
 * in-process and can take a long time on a wide range — exactly the shape
 * `extract_graph`/`search_index` already accept from the orchestrator's NDJSON
 * streaming + heartbeat.
 */
@Injectable()
export class SummaryBackfillService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly pythonFunctionService: PythonFunctionService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(SummaryBackfillService.name);
  }

  async backfill(userId: string, options: SummaryBackfillOptions = {}): Promise<SummaryBackfillResult> {
    const maxDays = options.maxDays ?? DEFAULT_MAX_DAYS;
    const drainTimeoutMs = options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
    const drainPollIntervalMs = options.drainPollIntervalMs ?? DEFAULT_DRAIN_POLL_INTERVAL_MS;

    const empty: SummaryBackfillResult = {
      range: null,
      daysWithActivity: 0,
      daysAlreadySummarized: 0,
      daysWithoutLandedHourly: [],
      truncated: false,
      hourly: emptyPhase(),
      daily: emptyPhase(),
      weekly: emptyPhase(),
      monthly: emptyPhase(),
    };

    const bounds = await this.resolveBounds(userId, options.startTime, options.endTime);
    if (bounds == null) {
      return empty;
    }

    const { start } = bounds;
    let { end } = bounds;
    let truncated = false;
    const cappedEnd = new Date(start.getTime() + maxDays * DAY_MS);
    if (cappedEnd < end) {
      end = cappedEnd;
      truncated = true;
      this.logger.warn('Summary backfill range exceeds maxDays — clamping', {
        userId,
        requestedEnd: bounds.end.toISOString(),
        clampedEnd: end.toISOString(),
        maxDays,
      });
    }

    if (end <= start) {
      return { ...empty, range: { start: start.toISOString(), end: end.toISOString() }, truncated };
    }

    const activeDays = await this.daysWithActivity(userId, start, end);
    const existingDaily = await this.existingWindowStarts(userId, 'daily', start, end);

    const daysToProcess = activeDays.filter((day) => !existingDaily.has(day.getTime()));
    const daysAlreadySummarized = activeDays.length - daysToProcess.length;

    // ── Phase 1: hourly ──────────────────────────────────────────────────
    const existingHourly = await this.existingWindowStarts(userId, 'hourly', start, end);
    const dispatchedHours: Date[] = [];
    let hourlyEnqueued = 0;
    let hourlyDeduped = 0;

    for (const day of daysToProcess) {
      for (let h = 0; h < 24; h += 1) {
        const hourStart = new Date(day.getTime() + h * 60 * 60 * 1000);
        if (hourStart < start || hourStart >= end) {
          continue;
        }

        if (existingHourly.has(hourStart.getTime())) {
          continue;
        }

        const hourEnd = new Date(hourStart.getTime() + 60 * 60 * 1000);
        const enqueued = await this.dispatchWindow(
          userId,
          'hourly_summary',
          hourStart,
          hourEnd,
          hourKeyOf(hourStart),
        );
        if (enqueued) {
          hourlyEnqueued += 1;
        } else {
          hourlyDeduped += 1;
        }

        dispatchedHours.push(hourStart);
      }
    }

    const hourlyExpected = hourlyEnqueued + hourlyDeduped;
    const hourlyDrain = await this.drainPhase(
      dispatchedHours,
      () => this.existingWindowStarts(userId, 'hourly', start, end),
      drainTimeoutMs,
      drainPollIntervalMs,
    );
    options.onProgress?.({
      phase: 'hourly',
      enqueued: hourlyEnqueued,
      deduped: hourlyDeduped,
      landed: hourlyDrain.landed,
      expected: hourlyExpected,
      drained: hourlyDrain.drained,
    });

    // ── Phase 2: daily ───────────────────────────────────────────────────
    const hourlyLandedSet = hourlyDrain.finalSet;
    const daysWithoutLandedHourly: Date[] = [];
    const dispatchedDays: Date[] = [];
    let dailyEnqueued = 0;
    let dailyDeduped = 0;

    for (const day of daysToProcess) {
      const dayEnd = new Date(day.getTime() + DAY_MS);
      const hasHourly =
        existingHourly.size > 0 &&
        [...existingHourly].some((t) => t >= day.getTime() && t < dayEnd.getTime());
      const hasLandedHourly =
        hasHourly || [...hourlyLandedSet].some((t) => t >= day.getTime() && t < dayEnd.getTime());

      if (!hasLandedHourly) {
        daysWithoutLandedHourly.push(day);
        continue;
      }

      const enqueued = await this.dispatchWindow(userId, 'daily_summary', day, dayEnd, dayKeyOf(day));
      if (enqueued) {
        dailyEnqueued += 1;
      } else {
        dailyDeduped += 1;
      }

      dispatchedDays.push(day);
    }

    const dailyExpected = dailyEnqueued + dailyDeduped;
    const dailyDrain = await this.drainPhase(
      dispatchedDays,
      () => this.existingWindowStarts(userId, 'daily', start, end),
      drainTimeoutMs,
      drainPollIntervalMs,
    );
    options.onProgress?.({
      phase: 'daily',
      enqueued: dailyEnqueued,
      deduped: dailyDeduped,
      landed: dailyDrain.landed,
      expected: dailyExpected,
      drained: dailyDrain.drained,
    });

    // ── Phase 3: weekly ──────────────────────────────────────────────────
    const dailyLandedSet = dailyDrain.finalSet;
    const existingWeekly = await this.existingWindowStarts(userId, 'weekly', utcWeekStart(start), end);
    const weeksSeen = new Set<number>();
    const dispatchedWeeks: Date[] = [];
    let weeklyEnqueued = 0;
    let weeklyDeduped = 0;

    for (const day of dispatchedDays) {
      const weekStart = utcWeekStart(day);
      if (weeksSeen.has(weekStart.getTime())) {
        continue;
      }

      weeksSeen.add(weekStart.getTime());

      if (existingWeekly.has(weekStart.getTime())) {
        continue;
      }

      const weekEnd = new Date(weekStart.getTime() + 7 * DAY_MS);
      const hasDaily = [...dailyLandedSet].some((t) => t >= weekStart.getTime() && t < weekEnd.getTime());
      if (!hasDaily) {
        continue;
      }

      const enqueued = await this.dispatchWindow(
        userId,
        'weekly_summary',
        weekStart,
        weekEnd,
        weekKeyOf(weekStart),
      );
      if (enqueued) {
        weeklyEnqueued += 1;
      } else {
        weeklyDeduped += 1;
      }

      dispatchedWeeks.push(weekStart);
    }

    const weeklyExpected = weeklyEnqueued + weeklyDeduped;
    const weeklyDrain = await this.drainPhase(
      dispatchedWeeks,
      () => this.existingWindowStarts(userId, 'weekly', utcWeekStart(start), end),
      drainTimeoutMs,
      drainPollIntervalMs,
    );
    options.onProgress?.({
      phase: 'weekly',
      enqueued: weeklyEnqueued,
      deduped: weeklyDeduped,
      landed: weeklyDrain.landed,
      expected: weeklyExpected,
      drained: weeklyDrain.drained,
    });

    // ── Phase 4: monthly ─────────────────────────────────────────────────
    const existingMonthly = await this.existingWindowStarts(userId, 'monthly', utcMonthStart(start), end);
    const monthsSeen = new Set<number>();
    const dispatchedMonths: Date[] = [];
    let monthlyEnqueued = 0;
    let monthlyDeduped = 0;

    for (const day of dispatchedDays) {
      const monthStart = utcMonthStart(day);
      if (monthsSeen.has(monthStart.getTime())) {
        continue;
      }

      monthsSeen.add(monthStart.getTime());

      if (existingMonthly.has(monthStart.getTime())) {
        continue;
      }

      const monthEnd = addMonths(monthStart, 1);
      const hasDaily = [...dailyLandedSet].some((t) => t >= monthStart.getTime() && t < monthEnd.getTime());
      if (!hasDaily) {
        continue;
      }

      const enqueued = await this.dispatchWindow(
        userId,
        'monthly_summary',
        monthStart,
        monthEnd,
        monthKeyOf(monthStart),
      );
      if (enqueued) {
        monthlyEnqueued += 1;
      } else {
        monthlyDeduped += 1;
      }

      dispatchedMonths.push(monthStart);
    }

    const monthlyExpected = monthlyEnqueued + monthlyDeduped;
    const monthlyDrain = await this.drainPhase(
      dispatchedMonths,
      () => this.existingWindowStarts(userId, 'monthly', utcMonthStart(start), end),
      drainTimeoutMs,
      drainPollIntervalMs,
    );
    options.onProgress?.({
      phase: 'monthly',
      enqueued: monthlyEnqueued,
      deduped: monthlyDeduped,
      landed: monthlyDrain.landed,
      expected: monthlyExpected,
      drained: monthlyDrain.drained,
    });

    const result: SummaryBackfillResult = {
      range: { start: start.toISOString(), end: end.toISOString() },
      daysWithActivity: activeDays.length,
      daysAlreadySummarized,
      daysWithoutLandedHourly: daysWithoutLandedHourly.map(dayKeyOf),
      truncated,
      hourly: { enqueued: hourlyEnqueued, deduped: hourlyDeduped, ...hourlyDrain.result(hourlyExpected) },
      daily: { enqueued: dailyEnqueued, deduped: dailyDeduped, ...dailyDrain.result(dailyExpected) },
      weekly: { enqueued: weeklyEnqueued, deduped: weeklyDeduped, ...weeklyDrain.result(weeklyExpected) },
      monthly: {
        enqueued: monthlyEnqueued,
        deduped: monthlyDeduped,
        ...monthlyDrain.result(monthlyExpected),
      },
    };

    this.logger.log('Summary backfill complete', {
      userId,
      range: result.range,
      daysWithActivity: result.daysWithActivity,
      daysAlreadySummarized,
      hourly: result.hourly,
      daily: result.daily,
      weekly: result.weekly,
      monthly: result.monthly,
    });

    return result;
  }

  /**
   * Resolve the [start, end) range to scan: caller-supplied bounds verbatim,
   * or fills the missing side from the same {@link ACTIVITY_SOURCES}' own
   * MIN/MAX(time). `end` never exceeds the start of the current UTC hour —
   * the live hourly cron owns the in-progress hour, and summarizing a
   * still-accumulating window would race it. Returns null when there is no
   * activity anywhere and no explicit range was given.
   */
  private async resolveBounds(
    userId: string,
    startTime: Date | undefined,
    endTime: Date | undefined,
  ): Promise<{ start: Date; end: Date } | null> {
    const nowHour = utcHourStart(new Date());

    if (startTime != null && endTime != null) {
      const end = endTime > nowHour ? nowHour : endTime;

      return startTime < end ? { start: startTime, end } : null;
    }

    const union = ACTIVITY_SOURCES.map(
      (s) => `SELECT ${s.column} AS t FROM ${s.table} WHERE user_id = $1`,
    ).join('\n      UNION ALL\n      ');

    const rows = await this.dataSource.query<Array<{ min_t: Date | null; max_t: Date | null }>>(
      `SELECT MIN(t) AS min_t, MAX(t) AS max_t FROM (\n      ${union}\n    ) sources`,
      [userId],
    );

    const minT = rows[0]?.min_t ?? null;
    const maxT = rows[0]?.max_t ?? null;
    if (minT == null || maxT == null) {
      return null;
    }

    const start = startTime ?? utcDayStart(new Date(minT));
    const detectedEnd = endTime ?? new Date(new Date(maxT).getTime() + 1);
    const end = detectedEnd > nowHour ? nowHour : detectedEnd;

    return start < end ? { start, end } : null;
  }

  /** UTC day-starts in [start, end) with at least one row across {@link ACTIVITY_SOURCES}. */
  private async daysWithActivity(userId: string, start: Date, end: Date): Promise<Date[]> {
    const union = ACTIVITY_SOURCES.map(
      (s) =>
        `SELECT ${s.column} AS t FROM ${s.table} WHERE user_id = $1 AND ${s.column} >= $2 AND ${s.column} < $3`,
    ).join('\n      UNION ALL\n      ');

    const rows = await this.dataSource.query<Array<{ day: Date }>>(
      `SELECT DISTINCT date_trunc('day', t) AS day FROM (\n      ${union}\n    ) sources ORDER BY day`,
      [userId, start, end],
    );

    return rows.map((row) => new Date(row.day));
  }

  /** Existing `ci.summaries.period_start` instants of one period_type in [start, end), as epoch-ms. */
  private async existingWindowStarts(
    userId: string,
    periodType: 'hourly' | 'daily' | 'weekly' | 'monthly',
    start: Date,
    end: Date,
  ): Promise<Set<number>> {
    if (end <= start) {
      return new Set();
    }

    const rows = await this.dataSource
      .getRepository(SummaryEntity)
      .createQueryBuilder('summary')
      .select('summary.periodStart', 'periodStart')
      .where('summary.userId = :userId', { userId })
      .andWhere('summary.periodType = :periodType', { periodType })
      .andWhere('summary.periodStart >= :start', { start })
      .andWhere('summary.periodStart < :end', { end })
      .getRawMany<{ periodStart: Date }>();

    return new Set(rows.map((row) => new Date(row.periodStart).getTime()));
  }

  private async dispatchWindow(
    userId: string,
    functionName: 'hourly_summary' | 'daily_summary' | 'weekly_summary' | 'monthly_summary',
    start: Date,
    end: Date,
    windowKey: string,
  ): Promise<boolean> {
    return this.pythonFunctionService.dispatch(
      'summary',
      functionName,
      userId,
      { start_time: start.toISOString(), end_time: end.toISOString(), timezone: 'UTC' },
      { singletonKey: `fn:${functionName}:${userId}:${windowKey}` },
    );
  }

  /**
   * Poll `fetchExisting` until every window in `dispatched` has landed, or
   * `timeoutMs` elapses. Returns the final existing-set (so the caller can
   * tell which specific windows landed, not just a count) alongside a
   * `result()` helper that shapes it into a {@link SummaryBackfillPhaseResult}.
   */
  private async drainPhase(
    dispatched: Date[],
    fetchExisting: () => Promise<Set<number>>,
    timeoutMs: number,
    pollIntervalMs: number,
  ): Promise<{
    landed: number;
    drained: boolean;
    finalSet: Set<number>;
    result: (expected: number) => Pick<SummaryBackfillPhaseResult, 'landed' | 'expected' | 'drained'>;
  }> {
    const keys = dispatched.map((d) => d.getTime());
    const landedCount = (set: Set<number>) => keys.filter((k) => set.has(k)).length;

    let finalSet = await fetchExisting();
    const startedAt = Date.now();

    while (keys.length > 0 && landedCount(finalSet) < keys.length && Date.now() - startedAt < timeoutMs) {
      await sleep(pollIntervalMs);
      finalSet = await fetchExisting();
    }

    const landed = landedCount(finalSet);
    const drained = landed >= keys.length;

    return {
      landed,
      drained,
      finalSet,
      result: (expected) => ({ landed, expected, drained }),
    };
  }
}

function emptyPhase(): SummaryBackfillPhaseResult {
  return { enqueued: 0, deduped: 0, landed: 0, expected: 0, drained: true };
}
