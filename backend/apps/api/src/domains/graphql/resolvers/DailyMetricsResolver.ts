import { UseGuards } from '@nestjs/common';
import { Args, Int, Mutation, Query, Resolver } from '@nestjs/graphql';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import {
  AnomalyEngine,
  CorrelationEngine,
  DailyMetricsService,
  DEFAULT_REFRESH_WINDOW_DAYS,
  DescriptiveQuestionService,
  SuggestionEngine,
  type AnalyticType,
} from '@ci/domains/daily-metrics';

import { GraphqlPrivacy } from '../decorators/GraphqlPrivacy';
import { DailyMetricsType } from '../types/DailyMetricsType';
import { MetricAnomalyType, MetricCorrelationType, MetricSuggestionType } from '../types/DerivationTypes';
import { DescriptiveAnswerType, DescriptiveQuestionType } from '../types/DescriptiveAnswerType';

@UseGuards(JwtOrApiKeyAuthGuard)
@Resolver()
export class DailyMetricsResolver {
  constructor(
    private readonly dailyMetricsService: DailyMetricsService,
    private readonly descriptiveQuestionService: DescriptiveQuestionService,
    private readonly correlationEngine: CorrelationEngine,
    private readonly anomalyEngine: AnomalyEngine,
    private readonly suggestionEngine: SuggestionEngine,
  ) {}

  @Query(() => [DailyMetricsType], {
    description:
      'Precomputed daily feature-store rows for the signed-in user over an inclusive yyyy-MM-dd range.',
  })
  async dailyMetrics(
    @Context() context: RequestContext,
    @Args('from', { type: () => String, description: 'Inclusive first day, yyyy-MM-dd' }) from: string,
    @Args('to', { type: () => String, description: 'Inclusive last day, yyyy-MM-dd' }) to: string,
  ): Promise<DailyMetricsType[]> {
    const rows = await this.dailyMetricsService.getRange(toServiceContext(context), from, to);

    return rows.map(DailyMetricsType.toType);
  }

  @Query(() => [DescriptiveQuestionType], {
    description: 'The question catalog the compute-then-narrate engine can answer.',
  })
  descriptiveQuestions(
    @Args('analyticType', { type: () => String, nullable: true }) analyticType?: string,
  ): DescriptiveQuestionType[] {
    return this.descriptiveQuestionService
      .listQuestions(analyticType as AnalyticType | undefined)
      .map((spec) => ({
        key: spec.key,
        category: spec.category,
        question: spec.question,
        analyticType: spec.analyticType ?? 'descriptive',
      }));
  }

  @Query(() => [DescriptiveAnswerType], {
    description: 'Answers every catalog question from stored daily_metrics.',
  })
  async descriptiveAnswers(
    @Context() context: RequestContext,
    @Args('date', { type: () => String, nullable: true }) date?: string,
  ): Promise<DescriptiveAnswerType[]> {
    const answers = await this.descriptiveQuestionService.answerAll(toServiceContext(context), { date });

    return answers.map(DescriptiveAnswerType.toType);
  }

  @Query(() => [DescriptiveAnswerType], {
    description:
      'Answers catalog questions of one analytic type (descriptive, correlational, anomaly, optimization, predictive).',
  })
  async catalogAnswers(
    @Context() context: RequestContext,
    @Args('analyticType', { type: () => String }) analyticType: string,
    @Args('date', { type: () => String, nullable: true }) date?: string,
  ): Promise<DescriptiveAnswerType[]> {
    const answers = await this.descriptiveQuestionService.answerAll(toServiceContext(context), {
      date,
      analyticType: analyticType as AnalyticType,
    });

    return answers.map(DescriptiveAnswerType.toType);
  }

  @Query(() => [MetricCorrelationType], {
    description: 'Pairwise / lagged associations. Hypotheses ("associated with"), never causes.',
  })
  async metricCorrelations(
    @Context() context: RequestContext,
    @Args('windowDays', { type: () => Int, nullable: true }) windowDays?: number,
    @Args('robustOnly', { type: () => Boolean, nullable: true }) robustOnly?: boolean,
  ): Promise<MetricCorrelationType[]> {
    const rows = await this.correlationEngine.list(toServiceContext(context), { windowDays, robustOnly });

    return rows.map(MetricCorrelationType.toType);
  }

  @Query(() => [MetricAnomalyType], {
    description: 'Computed metric and behavioral anomalies. Not the free-text list inside summaries.',
  })
  async metricAnomalies(
    @Context() context: RequestContext,
    @Args('since', { type: () => String, nullable: true }) since?: string,
    @Args('metric', { type: () => String, nullable: true }) metric?: string,
  ): Promise<MetricAnomalyType[]> {
    const rows = await this.anomalyEngine.list(toServiceContext(context), { since, metric });

    return rows.map(MetricAnomalyType.toType);
  }

  @Query(() => [MetricSuggestionType], {
    description: 'Evidence-linked suggestions. Findings persist even when derivation.engines is off.',
  })
  async metricSuggestions(
    @Context() context: RequestContext,
    @Args('includeDismissed', { type: () => Boolean, nullable: true }) includeDismissed?: boolean,
  ): Promise<MetricSuggestionType[]> {
    const rows = await this.suggestionEngine.list(toServiceContext(context), includeDismissed ?? false);

    return rows.map(MetricSuggestionType.toType);
  }

  @Mutation(() => [DailyMetricsType], {
    description: 'Recompute and upsert a trailing window of daily metrics for the signed-in user.',
  })
  // dailyMetricsService.refreshForUser() upserts (conflict on userId+date) one derived row per
  // day in the window — a recompute of the caller's own analytics, not a deletion or a wholesale
  // replace of unrelated stored data.
  @GraphqlPrivacy({ destructive: false })
  async refreshDailyMetrics(
    @Context() context: RequestContext,
    @Args('days', { type: () => Int, nullable: true }) days?: number,
    @Args('timezone', { type: () => String, nullable: true }) timezone?: string,
  ): Promise<DailyMetricsType[]> {
    const rows = await this.dailyMetricsService.refreshForUser(
      toServiceContext(context),
      days ?? DEFAULT_REFRESH_WINDOW_DAYS,
      timezone || 'UTC',
    );

    return rows.map(DailyMetricsType.toType);
  }
}
