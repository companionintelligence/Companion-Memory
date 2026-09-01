import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { v7 as uuidv7 } from 'uuid';

import type { UserServiceContext } from '@ci/common/context';
import { FeatureService } from '@ci/common/feature';
import { LoggerService } from '@ci/common/logging';
import { ActionService } from '@ci/domains/intelligence';

import { MAX_DERIVED_ACTIONS_PER_DAY } from '../coldStart';
import { CorrelationEngine } from '../correlation/CorrelationEngine';
import { shiftIso, todayIsoInTimezone } from '../dateUtil';
import type { MetricAnomaly } from '../entities/MetricAnomalyEntity';
import { MetricSuggestionEntity, type MetricSuggestion } from '../entities/MetricSuggestionEntity';
import { SuggestionArmEntity } from '../entities/SuggestionArmEntity';
import { DailyMetricsService } from '../services/DailyMetricsService';
import { METRIC_SOURCES, type MetricKey } from '../types';

import {
  armMean,
  detectArmTriggers,
  SUGGESTION_BASELINE_DAYS,
  SUGGESTION_MIN_BASELINE_N,
  updateArm,
  type SuggestionArmKey,
} from './suggestionMath';

@Injectable()
export class SuggestionEngine {
  constructor(
    @InjectRepository(MetricSuggestionEntity)
    private readonly suggestions: Repository<MetricSuggestionEntity>,
    @InjectRepository(SuggestionArmEntity)
    private readonly arms: Repository<SuggestionArmEntity>,
    private readonly metricsService: DailyMetricsService,
    private readonly correlationEngine: CorrelationEngine,
    private readonly actionService: ActionService,
    private readonly featureService: FeatureService,
    private readonly logger: LoggerService,
  ) {
    this.logger.setContext(SuggestionEngine.name);
  }

  async propose(
    context: UserServiceContext,
    anomalies: MetricAnomaly[],
    timezone = 'UTC',
  ): Promise<MetricSuggestion[]> {
    // Anchored to the newest stored day, not to the wall clock — see
    // `DailyMetricsService.analysisAnchor`. This must resolve to the SAME day
    // `AnomalyEngine.scan` used, or the `anomalies` argument it is handed (all
    // dated at that day) matches nothing here and every suggestion that
    // requires anomaly evidence is silently dropped.
    const yesterday =
      (await this.metricsService.analysisAnchor(context, timezone)) ??
      shiftIso(todayIsoInTimezone(timezone), -1);
    const from = shiftIso(yesterday, -(SUGGESTION_BASELINE_DAYS - 1));
    const rows = await this.metricsService.getRange(context, from, yesterday);
    const todayRow = rows.find((row) => row.date === yesterday) ?? null;
    const window = rows.filter((row) => row.date !== yesterday);
    const triggers = detectArmTriggers(todayRow, window, SUGGESTION_MIN_BASELINE_N);

    const correlations = await this.correlationEngine.list(context, { robustOnly: true });
    const persisted: MetricSuggestion[] = [];

    for (const trigger of triggers) {
      const anomaly = anomalies.find((row) => row.date === yesterday && row.metric === trigger.metric);
      const correlation = driverCorrelation(trigger.key, trigger.metric, correlations);

      if (!hasRequiredEvidence(trigger.key, anomaly, correlation)) {
        continue;
      }

      const evidence = {
        metric: trigger.metric,
        windowDays: SUGGESTION_BASELINE_DAYS,
        baseline: trigger.baseline,
        current: trigger.current,
        gap: trigger.gap,
        sources: [...(METRIC_SOURCES[trigger.metric as MetricKey] ?? [])],
      };

      const row = await this.upsertLive(context.userId, {
        key: trigger.key,
        title: trigger.title,
        text: withAssociation(trigger.text, correlation?.metricA, correlation?.metricB, trigger.metric),
        priority: trigger.priority,
        correlationId: correlation?.id ?? null,
        anomalyId: anomaly?.id ?? null,
        evidence,
      });

      persisted.push(row);
    }

    const promote = await this.featureService.isFeatureEnabled('derivation.engines');
    if (promote) {
      await this.promote(context, persisted, timezone);
    }

    this.logger.log('Suggestion propose complete', {
      userId: context.userId,
      rows: persisted.length,
      promoted: promote,
    });

    return persisted;
  }

  async list(context: UserServiceContext, includeDismissed = false): Promise<MetricSuggestion[]> {
    const qb = this.suggestions
      .createQueryBuilder('row')
      .where('row.user_id = :userId', { userId: context.userId })
      .orderBy('row.computed_at', 'DESC');

    if (!includeDismissed) {
      qb.andWhere('row.dismissed_at IS NULL').andWhere('row.accepted_at IS NULL');
    }

    const rows = await qb.getMany();

    return rows.map((entity) => MetricSuggestionEntity.toEgressType(entity));
  }

  async feedback(
    context: UserServiceContext,
    id: string,
    accepted: boolean,
  ): Promise<MetricSuggestion | null> {
    const entity = await this.suggestions.findOne({ where: { id, userId: context.userId } });
    if (!entity) {
      return null;
    }

    const now = new Date();
    if (accepted) {
      entity.acceptedAt = now;
    } else {
      entity.dismissedAt = now;
    }

    const saved = await this.suggestions.save(entity);

    if (entity.actionId) {
      if (accepted) {
        await this.actionService.markAsSeen(context, entity.actionId);
      } else {
        await this.actionService.markAsDismissed(context, entity.actionId);
      }
    }

    await this.bumpArm(context.userId, entity.key as SuggestionArmKey, accepted);

    if (!accepted && entity.correlationId) {
      const metric = entity.evidence?.metric;
      if (metric) {
        await this.correlationEngine.decayNoveltyForMetric(context.userId, metric);
      }
    }

    return MetricSuggestionEntity.toEgressType(saved);
  }

  private async promote(
    context: UserServiceContext,
    rows: MetricSuggestion[],
    timezone: string,
  ): Promise<void> {
    if (rows.length === 0) {
      return;
    }

    const live = await this.suggestions.find({
      where: { userId: context.userId, acceptedAt: IsNull(), dismissedAt: IsNull() },
    });
    if (live.some((row) => row.actionId)) {
      return;
    }

    const scored = await Promise.all(
      rows.map(async (row) => {
        const arm = await this.arms.findOne({ where: { userId: context.userId, key: row.key } });

        return { row, mean: armMean(arm?.alpha ?? 1, arm?.beta ?? 1) };
      }),
    );
    scored.sort(
      (left, right) => right.mean - left.mean || (left.row.priority ?? 5) - (right.row.priority ?? 5),
    );
    const chosen = scored[0]?.row;
    if (!chosen) {
      return;
    }

    const used = await this.actionService.countDerivedOnLocalDay(
      context,
      todayIsoInTimezone(timezone),
      timezone,
    );
    if (used >= MAX_DERIVED_ACTIONS_PER_DAY) {
      return;
    }

    const action = await this.actionService.create(context, {
      title: chosen.title,
      text: chosen.text,
      priority: chosen.priority ?? 3,
      source: 'suggestion',
      metadata: { suggestionId: chosen.id, key: chosen.key, evidence: chosen.evidence },
    });

    await this.suggestions.update({ id: chosen.id }, { actionId: action.id });
    chosen.actionId = action.id;
  }

  private async upsertLive(
    userId: string,
    fields: {
      key: string;
      title: string;
      text: string;
      priority: number;
      correlationId: string | null;
      anomalyId: string | null;
      evidence: MetricSuggestion['evidence'];
    },
  ): Promise<MetricSuggestion> {
    const existing = await this.suggestions.findOne({
      where: { userId, key: fields.key, acceptedAt: IsNull(), dismissedAt: IsNull() },
    });

    const entity = existing ?? this.suggestions.create({ id: uuidv7(), userId });
    entity.key = fields.key;
    entity.title = fields.title;
    entity.text = fields.text;
    entity.priority = fields.priority;
    entity.correlationId = fields.correlationId;
    entity.anomalyId = fields.anomalyId;
    entity.evidence = fields.evidence;
    entity.computedAt = new Date();

    const saved = await this.suggestions.save(entity);

    return MetricSuggestionEntity.toEgressType(saved);
  }

  private async bumpArm(userId: string, key: SuggestionArmKey, accepted: boolean): Promise<void> {
    const existing = await this.arms.findOne({ where: { userId, key } });
    const next = updateArm(existing?.alpha ?? 1, existing?.beta ?? 1, accepted);
    if (existing) {
      existing.alpha = next.alpha;
      existing.beta = next.beta;
      existing.updatedAt = new Date();
      await this.arms.save(existing);

      return;
    }

    await this.arms.save(
      this.arms.create({
        userId,
        key,
        alpha: next.alpha,
        beta: next.beta,
        updatedAt: new Date(),
      }),
    );
  }
}

function involves(metricA: string, metricB: string, metric: string): boolean {
  return metricA === metric || metricB === metric;
}

function driverCorrelation(
  key: SuggestionArmKey,
  metric: string,
  correlations: Array<{ id: string; metricA: string; metricB: string }>,
): { id: string; metricA: string; metricB: string } | undefined {
  if (key === 'rel.conversations_low') {
    return correlations.find(
      (row) =>
        involves(row.metricA, row.metricB, 'n_conversations') &&
        (involves(row.metricA, row.metricB, 'avg_sentiment') ||
          involves(row.metricA, row.metricB, 'n_unique_contacts')),
    );
  }

  if (key === 'attention.screen_spike') {
    return correlations.find(
      (row) =>
        involves(row.metricA, row.metricB, 'screen_minutes') &&
        (involves(row.metricA, row.metricB, 'avg_sentiment') ||
          involves(row.metricA, row.metricB, 'spend_total')),
    );
  }

  return correlations.find((row) => involves(row.metricA, row.metricB, metric));
}

function hasRequiredEvidence(
  key: SuggestionArmKey,
  anomaly: MetricAnomaly | undefined,
  correlation: { id: string } | undefined,
): boolean {
  if (key === 'rel.conversations_low') {
    return Boolean(correlation);
  }

  if (key === 'places.one_place' || key === 'money.spend_spike') {
    return Boolean(anomaly);
  }

  return Boolean(anomaly || correlation);
}

function withAssociation(
  text: string,
  metricA: string | undefined,
  metricB: string | undefined,
  self: string,
): string {
  const other = metricA === self ? metricB : metricA;
  if (!other) {
    return text;
  }

  return `${text} Associated with ${other.replaceAll('_', ' ')}.`;
}
