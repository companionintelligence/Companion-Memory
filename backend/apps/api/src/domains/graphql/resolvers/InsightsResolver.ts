import { UseGuards } from '@nestjs/common';
import { Args, Int, Mutation, Query, Resolver } from '@nestjs/graphql';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import {
  DailyMetricsService,
  DEFAULT_REFRESH_WINDOW_DAYS,
  DescriptiveQuestionService,
} from '@ci/domains/insights';

import { DailyMetricsType } from '../types/DailyMetricsType';
import { DescriptiveAnswerType, DescriptiveQuestionType } from '../types/DescriptiveAnswerType';

@UseGuards(JwtOrApiKeyAuthGuard)
@Resolver()
export class InsightsResolver {
  constructor(
    private readonly dailyMetricsService: DailyMetricsService,
    private readonly descriptiveQuestionService: DescriptiveQuestionService,
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
    description: 'The descriptive question catalog the compute-then-narrate engine can answer.',
  })
  descriptiveQuestions(): DescriptiveQuestionType[] {
    return this.descriptiveQuestionService.listQuestions().map(DescriptiveQuestionType.toType);
  }

  @Query(() => [DescriptiveAnswerType], {
    description:
      'Answers every catalog question for the signed-in user. Reads stored daily_metrics; run refreshDailyMetrics first if the window is empty.',
  })
  async descriptiveAnswers(
    @Context() context: RequestContext,
    @Args('date', {
      type: () => String,
      nullable: true,
      description: 'Anchor day yyyy-MM-dd (inclusive end of every timeframe). Defaults to UTC today.',
    })
    date?: string,
  ): Promise<DescriptiveAnswerType[]> {
    const answers = await this.descriptiveQuestionService.answerAll(toServiceContext(context), {
      date,
    });

    return answers.map(DescriptiveAnswerType.toType);
  }

  @Mutation(() => [DailyMetricsType], {
    description:
      'Recompute and upsert a trailing window of daily metrics for the signed-in user in the given timezone (UTC when omitted).',
  })
  async refreshDailyMetrics(
    @Context() context: RequestContext,
    @Args('days', {
      type: () => Int,
      nullable: true,
      description: `Trailing window length ending on local today (1–366). Default ${DEFAULT_REFRESH_WINDOW_DAYS}.`,
    })
    days?: number,
    @Args('timezone', {
      type: () => String,
      nullable: true,
      description: 'IANA timezone for day bucketing; defaults to UTC',
    })
    timezone?: string,
  ): Promise<DailyMetricsType[]> {
    const rows = await this.dailyMetricsService.refreshForUser(
      toServiceContext(context),
      days ?? DEFAULT_REFRESH_WINDOW_DAYS,
      timezone || 'UTC',
    );

    return rows.map(DailyMetricsType.toType);
  }
}
