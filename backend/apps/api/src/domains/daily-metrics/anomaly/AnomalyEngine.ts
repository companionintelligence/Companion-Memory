import { Injectable } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import type { UserServiceContext } from '@ci/common/context';
import { FeatureService } from '@ci/common/feature';
import { LoggerService } from '@ci/common/logging';
import { ActionService } from '@ci/domains/intelligence';

import { MAX_DERIVED_ACTIONS_PER_DAY } from '../coldStart';
import { shiftIso, todayIsoInTimezone } from '../dateUtil';
import { MetricAnomalyEntity, type MetricAnomaly } from '../entities/MetricAnomalyEntity';
import { DailyMetricsService } from '../services/DailyMetricsService';
import { METRIC_KEYS, METRIC_SOURCES, type MetricKey } from '../types';

import {
  cusumChangepoints,
  hbpeL0Divergence,
  robustZSeries,
  type AnomalyFinding,
  type HbpeBucket,
  type SeriesPoint,
} from './anomalyMath';

const HISTORY_DAYS = 90;
const HBPE_N_BUCKETS_FLOOR = 50;

@Injectable()
export class AnomalyEngine {
  constructor(
    @InjectRepository(MetricAnomalyEntity)
    private readonly repository: Repository<MetricAnomalyEntity>,
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly metricsService: DailyMetricsService,
    private readonly actionService: ActionService,
    private readonly featureService: FeatureService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(AnomalyEngine.name);
  }

  async scan(context: UserServiceContext, timezone = 'UTC'): Promise<MetricAnomaly[]> {
    // The most recent day the STORE has, not the most recent day the clock
    // has. `DailyMetricsService.analysisAnchor` documents why; the short
    // version is that this window used to be positioned on `today - 1` over a
    // corpus whose newest row was two months old, so it swept 90 days of
    // all-NULL rows on every run and this table sat at zero. HISTORY_DAYS is
    // unchanged: the width was never the problem.
    const yesterday =
      (await this.metricsService.analysisAnchor(context, timezone)) ??
      shiftIso(todayIsoInTimezone(timezone), -1);
    const from = shiftIso(yesterday, -(HISTORY_DAYS - 1));
    const rows = await this.metricsService.getRange(context, from, yesterday);

    const findings: Array<AnomalyFinding & { metric: string }> = [];

    for (const metric of METRIC_KEYS) {
      const series: SeriesPoint[] = rows
        .filter((row) => row.metrics[metric] !== null)
        .map((row) => ({
          date: row.date,
          value: row.metrics[metric] as number,
          coverage: row.coverage[metric] ?? 0,
        }));

      for (const finding of robustZSeries(series)) {
        findings.push({ ...finding, metric });
      }

      for (const finding of cusumChangepoints(series)) {
        findings.push({ ...finding, metric });
      }
    }

    const hbpe = await this.scanHbpe(context, timezone, from, yesterday);
    findings.push(...hbpe);

    const persisted: MetricAnomaly[] = [];
    for (const finding of findings) {
      persisted.push(await this.upsert(context.userId, finding));
    }

    const promote = await this.featureService.isFeatureEnabled('derivation.engines');
    if (promote) {
      await this.promote(context, persisted, yesterday, timezone);
    }

    this.logger.log('Anomaly scan complete', {
      userId: context.userId,
      rows: persisted.length,
      promoted: promote,
    });

    return persisted;
  }

  async list(
    context: UserServiceContext,
    options: { since?: string; metric?: string } = {},
  ): Promise<MetricAnomaly[]> {
    const qb = this.repository
      .createQueryBuilder('row')
      .where('row.user_id = :userId', { userId: context.userId })
      .orderBy('row.date', 'DESC')
      .addOrderBy('row.score', 'DESC');

    if (options.since) {
      qb.andWhere('row.date >= :since', { since: options.since });
    }

    if (options.metric) {
      qb.andWhere('row.metric = :metric', { metric: options.metric });
    }

    const rows = await qb.getMany();

    return rows.map((entity) => MetricAnomalyEntity.toEgressType(entity));
  }

  private async scanHbpe(
    context: UserServiceContext,
    timezone: string,
    from: string,
    to: string,
  ): Promise<Array<AnomalyFinding & { metric: string }>> {
    try {
      const scores = (await this.dataSource.query(
        `
        SELECT n_buckets
        FROM hbpe.prediction_score
        WHERE user_id = $1
        ORDER BY scored_at DESC
        LIMIT 1
        `,
        [context.userId],
      )) as Array<{ n_buckets: number | string | null }>;

      const nBuckets = Number(scores[0]?.n_buckets ?? 0);
      if (!Number.isFinite(nBuckets) || nBuckets < HBPE_N_BUCKETS_FLOOR) {
        return [];
      }

      const buckets = (await this.dataSource.query(
        `
        SELECT horizon_start, actual_l0, l0_probs
        FROM hbpe.prediction_log
        WHERE user_id = $1
          AND actual_l0 IS NOT NULL
          AND horizon_start >= $2::date
          AND horizon_start < ($3::date + INTERVAL '1 day')
        `,
        [context.userId, from, to],
      )) as Array<{ horizon_start: Date | string; actual_l0: string; l0_probs: Record<string, number> }>;

      const byDay = new Map<string, HbpeBucket[]>();
      for (const row of buckets) {
        const day = localDay(row.horizon_start, timezone);
        const list = byDay.get(day) ?? [];
        list.push({
          actualL0: row.actual_l0,
          l0Probs: row.l0_probs ?? {},
        });
        byDay.set(day, list);
      }

      const findings: Array<AnomalyFinding & { metric: string }> = [];
      for (const [date, dayBuckets] of byDay) {
        const finding = hbpeL0Divergence(date, dayBuckets);
        if (finding) {
          findings.push({ ...finding, metric: 'hbpe.l0_divergence' });
        }
      }

      return findings;
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === '42P01' || code === '3F000') {
        return [];
      }

      this.logger.warn('HBPE divergence scan skipped', {
        userId: context.userId,
        error: error instanceof Error ? error.message : String(error),
      });

      return [];
    }
  }

  private async promote(
    context: UserServiceContext,
    anomalies: MetricAnomaly[],
    yesterday: string,
    timezone: string,
  ): Promise<void> {
    const recent = anomalies
      .filter((row) => row.date === yesterday && !row.actionId)
      .sort((left, right) => right.score * right.coverage - left.score * left.coverage);

    // Deliberately still the WALL CLOCK, unlike the scan window above. This is
    // a rate limit on how many derived actions the appliance may put in front
    // of its owner in one real day; the corpus has no opinion about that, and
    // anchoring it to the corpus would let a stale-corpus appliance re-spend
    // the same daily allowance on every tick.
    const used = await this.actionService.countDerivedOnLocalDay(
      context,
      todayIsoInTimezone(timezone),
      timezone,
    );
    const remaining = Math.max(0, MAX_DERIVED_ACTIONS_PER_DAY - used);

    for (const anomaly of recent.slice(0, remaining)) {
      const action = await this.actionService.create(context, {
        title: anomalyTitle(anomaly),
        text: anomalyText(anomaly),
        priority: 3,
        source: 'anomaly',
        metadata: { metric: anomaly.metric, detector: anomaly.detector, anomalyId: anomaly.id },
      });

      await this.repository.update({ id: anomaly.id }, { actionId: action.id });
      anomaly.actionId = action.id;
    }
  }

  private async upsert(userId: string, finding: AnomalyFinding & { metric: string }): Promise<MetricAnomaly> {
    const existing = await this.repository.findOne({
      where: {
        userId,
        metric: finding.metric,
        date: finding.date,
        detector: finding.detector,
      },
    });

    const entity = existing ?? this.repository.create({ id: uuidv7(), userId });
    entity.metric = finding.metric;
    entity.date = finding.date;
    entity.detector = finding.detector;
    entity.value = finding.value;
    entity.baseline = finding.baseline;
    entity.score = finding.score;
    entity.direction = finding.direction;
    entity.coverage = finding.coverage;
    entity.metadata = finding.metadata;
    entity.computedAt = new Date();

    const saved = await this.repository.save(entity);

    return MetricAnomalyEntity.toEgressType(saved);
  }
}

function localDay(value: Date | string, timezone: string): string {
  const date = value instanceof Date ? value : new Date(value);
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}

function anomalyTitle(anomaly: MetricAnomaly): string {
  if (anomaly.detector === 'hbpe_l0') {
    return 'A day that looked unlike the usual pattern';
  }

  return `${anomaly.metric.replaceAll('_', ' ')} looked unusual`;
}

function anomalyText(anomaly: MetricAnomaly): string {
  if (anomaly.detector === 'hbpe_l0') {
    return 'That day looked unlike the usual pattern. This is consistency against pipeline labels, not a claim that a forecast was wrong.';
  }

  const sources = METRIC_SOURCES[anomaly.metric as MetricKey] ?? [];
  const value = anomaly.value === null ? 'n/a' : String(Math.round(anomaly.value * 10) / 10);
  const baseline = anomaly.baseline === null ? 'n/a' : String(Math.round(anomaly.baseline * 10) / 10);

  return `${anomaly.metric} was ${value} vs a typical ${baseline} (${anomaly.direction}). Sources: ${sources.join(', ') || 'derived'}.`;
}
