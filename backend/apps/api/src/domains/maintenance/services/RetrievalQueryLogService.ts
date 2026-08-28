import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';

import { LoggerService } from '@ci/common/logging';

import { RetrievalQueryLogEntity } from '../entities/RetrievalQueryLogEntity';

import type { RaisableAlert } from './RetrievalHealthService';

/**
 * How far back the zero-result rate is measured.
 *
 * A week, matching `RetrievalHealthService.BASELINE_LOOKBACK_DAYS`:
 * long enough that a handful of odd questions on one evening cannot carry the
 * rate, short enough that a hole opened by last night's failed backfill is
 * visible before the week is out.
 */
export const ZERO_RESULT_LOOKBACK_DAYS = 7;

/**
 * Fewest queries in the window before the rate is allowed to say anything.
 *
 * Three searches, two of them empty, is not a 67% failure rate — it is three
 * searches. On a 1–5 user appliance the window is small by nature, so the floor
 * is the difference between an alert and a coin flip.
 */
export const ZERO_RESULT_MIN_QUERIES = 20;

/**
 * Share of a window's queries that must come back empty to raise a card.
 *
 * Deliberately well above "some searches find nothing" — a personal archive
 * legitimately cannot answer plenty of questions, and `searchAnchored` returns
 * nothing BY DESIGN when no term in the question is selective. Two in five is
 * the level at which the likelier explanation is the index rather than the
 * questions.
 */
export const ZERO_RESULT_RATE_THRESHOLD = 0.4;

/**
 * How long query-log rows are kept, matching
 * `RetrievalHealthService.RETENTION_DAYS`. Hundreds of rows a day on an appliance is small, but
 * nothing else would ever delete them, and a query log is the last table that
 * should grow without a stated end.
 */
export const QUERY_LOG_RETENTION_DAYS = 365;

/** Most zero-result cards one run may raise. One page, not one per caller. */
export const MAX_ZERO_RESULT_ALERTS_PER_RUN = 3;

const DAY_MS = 24 * 60 * 60 * 1000;

/** One (user, caller) pair's retrieval behaviour over the lookback window. */
export interface RetrievalQueryWindow {
  userId: string;
  caller: string;
  total: number;
  zeroResults: number;
  /** `zeroResults / total`, in [0,1]. */
  zeroResultRate: number;
  meanResultCount: number;
  meanLatencyMs: number;
}

/** A {@link RaisableAlert} that belongs to one user rather than to the appliance. */
export interface RetrievalQueryAlert {
  userId: string;
  alert: RaisableAlert;
}

export interface RetrievalQueryLogRun {
  capturedAt: Date;
  windows: RetrievalQueryWindow[];
  alerts: RetrievalQueryAlert[];
  /** Query-log rows deleted by the retention prune. */
  pruned: number;
}

/**
 * The rollup half of `ci.retrieval_query_log`.
 *
 * The table on its own is a pile of rows nobody reads — the same failure mode
 * `EmbedCoverageTelemetryService` had before `RetrievalHealthCron` existed. This
 * service is what turns it into an answer: aggregate the recent window per
 * (user, caller), and say so when a materially large share of a person's real
 * questions came back empty.
 *
 * It measures a question the two existing mechanisms structurally cannot.
 * `ci.retrieval_health_snapshots` measures index COVERAGE, and
 * `ci.recall_probe_results` measures ANN recall against query vectors SAMPLED
 * FROM THE INDEX — rows that are present by construction. Both can read healthy
 * while every question a person actually asks returns nothing.
 */
@Injectable()
export class RetrievalQueryLogService {
  constructor(
    @InjectRepository(RetrievalQueryLogEntity)
    private readonly repository: Repository<RetrievalQueryLogEntity>,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(RetrievalQueryLogService.name);
  }

  /**
   * Roll up the window, prune, and return the alerts worth a card. Raising them
   * is the caller's job (`RetrievalHealthCron`), for the same reason the
   * coverage half splits that way: this service touches only its own table, and
   * writing `ci.actions` rows against a user is a different kind of act.
   */
  async capture(now: Date = new Date()): Promise<RetrievalQueryLogRun> {
    const windows = await this.summarize(now);
    const pruned = await this.prune(now);
    const alerts = buildZeroResultAlerts(windows);

    this.logger.log('Retrieval query log rolled up', {
      windows: windows.length,
      queries: windows.reduce((sum, window) => sum + window.total, 0),
      zeroResults: windows.reduce((sum, window) => sum + window.zeroResults, 0),
      alerts: alerts.length,
      pruned,
    });

    return { capturedAt: now, windows, alerts, pruned };
  }

  /**
   * One row per (user, caller) over the last {@link ZERO_RESULT_LOOKBACK_DAYS}.
   *
   * Grouped by CALLER and not just by user, because the callers have genuinely
   * different expected zero-result rates and averaging them together hides
   * both: `search_anchored` is designed to return nothing when a question has no
   * selective term, while a `search` that finds nothing usually means the index
   * does not hold what the person asked for.
   */
  async summarize(now: Date = new Date()): Promise<RetrievalQueryWindow[]> {
    const since = new Date(now.getTime() - ZERO_RESULT_LOOKBACK_DAYS * DAY_MS);

    const rows: Array<{
      user_id: string;
      caller: string;
      total: string;
      zero_results: string;
      mean_result_count: string | null;
      mean_latency_ms: string | null;
    }> = await this.repository.query(
      `SELECT
         user_id,
         caller,
         count(*) AS total,
         count(*) FILTER (WHERE zero_result) AS zero_results,
         avg(result_count) AS mean_result_count,
         avg(latency_ms) AS mean_latency_ms
       FROM ci.retrieval_query_log
       WHERE ts >= $1
       GROUP BY user_id, caller
       ORDER BY user_id, caller`,
      [since],
    );

    return rows.map((row) => {
      const total = Number(row.total);
      const zeroResults = Number(row.zero_results);

      return {
        userId: String(row.user_id),
        caller: String(row.caller),
        total,
        zeroResults,
        zeroResultRate: total > 0 ? zeroResults / total : 0,
        meanResultCount: row.mean_result_count == null ? 0 : Number(row.mean_result_count),
        meanLatencyMs: row.mean_latency_ms == null ? 0 : Number(row.mean_latency_ms),
      };
    });
  }

  /** Drop rows past {@link QUERY_LOG_RETENTION_DAYS}. Returns the number deleted. */
  async prune(now: Date = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - QUERY_LOG_RETENTION_DAYS * DAY_MS);
    const result = await this.repository.delete({ ts: LessThan(cutoff) });

    return result.affected ?? 0;
  }
}

/**
 * Turn rolled-up windows into the cards worth raising. Pure, so every rule is
 * testable without a database.
 *
 * Quiet in three places, on purpose:
 *   - a window under {@link ZERO_RESULT_MIN_QUERIES} never alerts, however bad
 *     its ratio looks;
 *   - a window at or below {@link ZERO_RESULT_RATE_THRESHOLD} never alerts,
 *     because a personal archive genuinely cannot answer every question;
 *   - only the worst {@link MAX_ZERO_RESULT_ALERTS_PER_RUN} survive, so an
 *     appliance whose index was wiped raises a handful of cards rather than one
 *     per caller per user.
 */
export function buildZeroResultAlerts(windows: RetrievalQueryWindow[]): RetrievalQueryAlert[] {
  const ranked: Array<RetrievalQueryAlert & { rate: number }> = [];

  for (const window of windows) {
    if (window.total < ZERO_RESULT_MIN_QUERIES) {
      continue;
    }

    if (window.zeroResultRate <= ZERO_RESULT_RATE_THRESHOLD) {
      continue;
    }

    ranked.push({
      userId: window.userId,
      rate: window.zeroResultRate,
      alert: {
        reason: 'zero_result_rate',
        key: zeroResultAlertKey(window.caller),
        title: 'Most of your recent searches found nothing',
        text:
          `${window.zeroResults.toLocaleString()} of your last ` +
          `${window.total.toLocaleString()} searches (${percent(window.zeroResultRate)}) came back empty ` +
          `over the past ${ZERO_RESULT_LOOKBACK_DAYS} days. That usually means part of your archive is ` +
          `missing from the search index rather than that the answers are not there.`,
        detail: {
          caller: window.caller,
          total: window.total,
          zeroResults: window.zeroResults,
          zeroResultRate: window.zeroResultRate,
          meanResultCount: window.meanResultCount,
          meanLatencyMs: window.meanLatencyMs,
          lookbackDays: ZERO_RESULT_LOOKBACK_DAYS,
        },
      },
    });
  }

  return ranked
    .sort((a, b) => b.rate - a.rate)
    .slice(0, MAX_ZERO_RESULT_ALERTS_PER_RUN)
    .map(({ userId, alert }) => ({ userId, alert }));
}

/** `ci.actions.metadata.key` for one caller's zero-result-rate card. */
export function zeroResultAlertKey(caller: string): string {
  return `retrieval_query_log:${caller}:zero_result_rate`;
}

function percent(ratio: number): string {
  return `${(ratio * 100).toFixed(0)}%`;
}
