import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Between, LessThan, Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import { LoggerService } from '@ci/common/logging';

import { RetrievalHealthSnapshotEntity } from '../entities/RetrievalHealthSnapshotEntity';

import { EmbedCoverageTelemetryService, type EntityIndexHealth } from './EmbedCoverageTelemetryService';

/** How far back the week-over-week baseline looks. */
export const BASELINE_LOOKBACK_DAYS = 7;

/**
 * Widest age a row may have and still serve as the baseline. Without an upper
 * bound, an appliance that was off for a month would compare today against a
 * month-old reading and call ordinary growth a regression; without a lower
 * bound (the 7 days above) it would compare today against yesterday and call
 * an in-flight backfill one.
 */
export const BASELINE_MAX_AGE_DAYS = 14;

/** Percentage-point drop in a coverage ratio that counts as a regression. */
export const REGRESSION_DROP = 0.1;

/**
 * How long snapshots are kept. 18 rows a night is small, but "small and
 * unbounded" is still unbounded, and nothing else would ever delete them. A
 * year covers every week-over-week and season-over-season question the table
 * exists to answer.
 */
export const RETENTION_DAYS = 365;

/** Most alerts one run may raise, most severe first — a wiped index is one page, not 72. */
export const MAX_ALERTS_PER_RUN = 5;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Why a type is being flagged. Ordered by severity — {@link ALERT_SEVERITY}
 * relies on this being the ranking an operator would act on.
 */
export type RetrievalHealthAlertReason =
  /** Source rows exist, vectors do not: the type answers no search at all. */
  | 'vector_zero'
  /**
   * A materially large share of the user's REAL retrieval calls came back
   * empty over the recent window. Unlike every other reason here, this one is
   * measured from `ci.retrieval_query_log` — answers rather than index rows —
   * and is raised by {@link RetrievalQueryLogService}, not by
   * {@link buildRetrievalHealthAlerts}.
   */
  | 'zero_result_rate'
  /** Source rows exist, embeddings do not: retrieval falls back to lexical only. */
  | 'embed_zero'
  /** A coverage ratio fell materially against the ~week-old baseline. */
  | 'coverage_regression'
  /** The two index tables disagree: one half is ahead of the other. */
  | 'index_divergence';

const ALERT_SEVERITY: Record<RetrievalHealthAlertReason, number> = {
  vector_zero: 0,
  // Above the coverage reasons below it: a coverage ratio is a proxy for
  // whether searches can be answered, and this is the thing itself.
  zero_result_rate: 1,
  embed_zero: 2,
  coverage_regression: 3,
  index_divergence: 4,
};

/**
 * The shape `RetrievalHealthCron` can turn into a `ci.actions` card, whatever
 * measured it. Named separately from {@link RetrievalHealthAlert} because the
 * zero-result-rate alert is about a USER's queries rather than an entity type,
 * so it has no `entityType` to carry — and inventing a placeholder one would
 * put a lie in the card's metadata.
 */
export interface RaisableAlert {
  reason: RetrievalHealthAlertReason;
  /**
   * Stable dedupe key, written to `ci.actions.metadata.key`. One open card per
   * subject until the repeat window elapses — a nightly cron that re-raises the
   * same card every night is a cron nobody reads.
   */
  key: string;
  title: string;
  text: string;
  /** The numbers behind the card, kept on the action so the claim is checkable. */
  detail: Record<string, unknown>;
  /** The search entity type this is about, where there is one. */
  entityType?: string;
}

export interface RetrievalHealthAlert extends RaisableAlert {
  entityType: string;
}

/** The ~week-old reading a run is compared against, per type. */
export interface RetrievalHealthBaseline {
  entityType: string;
  capturedAt: Date;
  embedRatio: number;
  vectorRatio: number;
}

export interface RetrievalHealthRun {
  runId: string;
  capturedAt: Date;
  perType: Record<string, EntityIndexHealth>;
  baselines: Record<string, RetrievalHealthBaseline>;
  alerts: RetrievalHealthAlert[];
  /** Snapshot rows written this run (one per measured type). */
  persisted: number;
  /** Snapshot rows deleted by the retention prune. */
  pruned: number;
}

/**
 * The KNOWING half of the search index: measure both index tables, persist the
 * measurement so trend is answerable, and turn "a type went dark" into an
 * alert instead of a silence.
 *
 * The measurement itself is not reimplemented here — it is
 * {@link EmbedCoverageTelemetryService.computeIndexHealth}, the service that
 * already existed and whose only caller was an HTTP route waiting for a metrics
 * scraper the appliance does not have.
 */
@Injectable()
export class RetrievalHealthService {
  constructor(
    @InjectRepository(RetrievalHealthSnapshotEntity)
    private readonly snapshotRepository: Repository<RetrievalHealthSnapshotEntity>,
    private readonly embedCoverageTelemetryService: EmbedCoverageTelemetryService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(RetrievalHealthService.name);
  }

  /**
   * Measure, persist, prune, and compare against the ~week-old baseline.
   * Read-and-append only: it writes its own snapshot rows and deletes its own
   * expired ones, and touches no user data. Raising the alerts is the caller's
   * job (`RetrievalHealthCron`), because that half writes `ci.actions` rows
   * against a user. It does NOT consult the trust dial to do so — a COUNT
   * saying the appliance's own index is broken is not an inference about the
   * user, so it carries no confidence for the dial to rate. What the dial
   * still gates is placement, one hop downstream: `ActionService` emits
   * `ActionCreatedEvent` and personalization's `FeedQueuePopulationListener`
   * runs the `feed_action` decision before anything reaches `ci.feed_queue`.
   */
  async capture(now: Date = new Date()): Promise<RetrievalHealthRun> {
    const report = await this.embedCoverageTelemetryService.computeIndexHealth();
    const capturedAt = new Date(report.computedAt);
    const runId = uuidv7();

    const baselines = await this.loadBaselines(now);

    const rows = Object.entries(report.perType).map(([entityType, health]) =>
      this.snapshotRepository.create({
        id: uuidv7(),
        runId,
        capturedAt,
        entityType,
        sourceTotal: health.total,
        embeddedCount: health.embedded,
        vectorCount: health.vectored,
        embedRatio: health.ratio,
        vectorRatio: health.vectorRatio,
        embedAlarm: health.alarm,
        vectorAlarm: health.vectorAlarm,
        underThreshold: health.underThreshold,
        divergent: health.divergent,
      }),
    );

    if (rows.length > 0) {
      await this.snapshotRepository.save(rows);
    }

    const pruned = await this.prune(now);
    const alerts = buildRetrievalHealthAlerts(report.perType, baselines);

    this.logger.log('Retrieval health snapshot captured', {
      runId,
      types: rows.length,
      vectorAlarms: report.vectorAlarms,
      embedAlarms: report.alarms,
      divergent: report.divergent,
      alerts: alerts.length,
      pruned,
    });

    return {
      runId,
      capturedAt,
      perType: report.perType,
      baselines,
      alerts,
      persisted: rows.length,
      pruned,
    };
  }

  /**
   * Latest snapshot per type inside the baseline window (between
   * {@link BASELINE_LOOKBACK_DAYS} and {@link BASELINE_MAX_AGE_DAYS} old).
   *
   * Read whole and reduced in memory rather than with DISTINCT ON: the window
   * holds one week of 18 rows a night, so this is ~126 rows, and the ranking
   * rule stays visible in the code that depends on it.
   */
  async loadBaselines(now: Date = new Date()): Promise<Record<string, RetrievalHealthBaseline>> {
    const rows = await this.snapshotRepository.find({
      where: {
        capturedAt: Between(
          new Date(now.getTime() - BASELINE_MAX_AGE_DAYS * DAY_MS),
          new Date(now.getTime() - BASELINE_LOOKBACK_DAYS * DAY_MS),
        ),
      },
      order: { capturedAt: 'ASC' },
    });

    const baselines: Record<string, RetrievalHealthBaseline> = {};

    for (const row of rows) {
      // Ascending order means the last write per type wins: the newest reading
      // still old enough to be a baseline.
      baselines[row.entityType] = {
        entityType: row.entityType,
        capturedAt: row.capturedAt,
        embedRatio: Number(row.embedRatio),
        vectorRatio: Number(row.vectorRatio),
      };
    }

    return baselines;
  }

  /** Drop snapshots past {@link RETENTION_DAYS}. Returns the number deleted. */
  async prune(now: Date = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - RETENTION_DAYS * DAY_MS);
    const result = await this.snapshotRepository.delete({ capturedAt: LessThan(cutoff) });

    return result.affected ?? 0;
  }
}

/**
 * Turn a health report (plus its baseline) into the alerts worth a card. Pure,
 * so every rule below is testable without a database.
 *
 * Deliberately quiet in three places:
 *   - an EMPTY type never alerts (nothing to index is not a hole);
 *   - `index_divergence` is suppressed when the same type already tripped a
 *     zero alarm, because "vectors are 0" and "vectors disagree with
 *     embeddings" would otherwise be two cards about one fact;
 *   - only the worst {@link MAX_ALERTS_PER_RUN} survive, so a truncated index
 *     raises a handful of cards rather than one per type per reason.
 */
export function buildRetrievalHealthAlerts(
  perType: Record<string, EntityIndexHealth>,
  baselines: Record<string, RetrievalHealthBaseline>,
): RetrievalHealthAlert[] {
  const alerts: RetrievalHealthAlert[] = [];

  for (const [entityType, health] of Object.entries(perType)) {
    if (health.total === 0) {
      continue;
    }

    if (health.vectorAlarm) {
      alerts.push({
        entityType,
        reason: 'vector_zero',
        key: alertKey(entityType, 'vector_zero'),
        title: `Search cannot find your ${entityType} records`,
        text:
          `All ${health.total.toLocaleString()} ${entityType} records are missing from the search index ` +
          `(${health.embedded.toLocaleString()} have embeddings, but 0 have search vectors). ` +
          `Until the index is rebuilt for this type, searches will not return any of them.`,
        detail: {
          total: health.total,
          embedded: health.embedded,
          vectored: health.vectored,
        },
      });
    } else if (health.alarm) {
      alerts.push({
        entityType,
        reason: 'embed_zero',
        key: alertKey(entityType, 'embed_zero'),
        title: `Your ${entityType} records are not searchable by meaning`,
        text:
          `None of the ${health.total.toLocaleString()} ${entityType} records have embeddings, ` +
          `so they can only be matched on exact words, not on meaning.`,
        detail: {
          total: health.total,
          embedded: health.embedded,
          vectored: health.vectored,
        },
      });
    } else if (health.divergent) {
      // Only reachable when BOTH counts are non-zero: the two branches above
      // own the zero cases.
      alerts.push({
        entityType,
        reason: 'index_divergence',
        key: alertKey(entityType, 'index_divergence'),
        title: `Part of your ${entityType} history is missing from search`,
        text:
          `${entityType} has ${health.embedded.toLocaleString()} embeddings but ` +
          `${health.vectored.toLocaleString()} search vectors. The two halves of the index should match; ` +
          `whichever side is behind is the part search will not return.`,
        detail: {
          total: health.total,
          embedded: health.embedded,
          vectored: health.vectored,
          divergence: health.divergence,
        },
      });
    }

    const baseline = baselines[entityType];

    if (baseline == null) {
      continue;
    }

    const embedDrop = baseline.embedRatio - health.ratio;
    const vectorDrop = baseline.vectorRatio - health.vectorRatio;
    const worstDrop = Math.max(embedDrop, vectorDrop);

    if (worstDrop >= REGRESSION_DROP) {
      alerts.push({
        entityType,
        reason: 'coverage_regression',
        key: alertKey(entityType, 'coverage_regression'),
        title: `Search coverage for ${entityType} is falling behind`,
        text:
          `${entityType} search coverage dropped ${(worstDrop * 100).toFixed(0)} points since ` +
          `${baseline.capturedAt.toISOString().slice(0, 10)} ` +
          `(embeddings ${percent(baseline.embedRatio)} → ${percent(health.ratio)}, ` +
          `vectors ${percent(baseline.vectorRatio)} → ${percent(health.vectorRatio)}). ` +
          `New records are arriving faster than they are being indexed, or indexing has stopped.`,
        detail: {
          total: health.total,
          embedRatio: health.ratio,
          vectorRatio: health.vectorRatio,
          baselineEmbedRatio: baseline.embedRatio,
          baselineVectorRatio: baseline.vectorRatio,
          baselineCapturedAt: baseline.capturedAt.toISOString(),
        },
      });
    }
  }

  return alerts
    .sort((a, b) => ALERT_SEVERITY[a.reason] - ALERT_SEVERITY[b.reason])
    .slice(0, MAX_ALERTS_PER_RUN);
}

/** `ci.actions.metadata.key` for one (type, reason) pair. */
export function alertKey(entityType: string, reason: RetrievalHealthAlertReason): string {
  return `retrieval_health:${entityType}:${reason}`;
}

function percent(ratio: number): string {
  return `${(ratio * 100).toFixed(0)}%`;
}
