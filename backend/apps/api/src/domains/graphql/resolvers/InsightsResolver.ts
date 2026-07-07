import { BadRequestException, UseGuards } from '@nestjs/common';
import { Args, Query, Resolver } from '@nestjs/graphql';

import { Context, type RequestContext, toServiceContext } from '@ci/common/context';
import { JwtOrApiKeyAuthGuard } from '@ci/common/guards';
import { DailyMetricsService, DescriptiveQuestionService, QUESTION_CATALOG } from '@ci/domains/insights';

import { DailyMetricsType } from '../types/DailyMetricsType';
import { InsightAnswerType } from '../types/InsightAnswerType';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Reject anything that is not a YYYY-MM-DD date before it reaches SQL. */
function assertIsoDate(value: string, argName: string): void {
  if (!ISO_DATE.test(value)) {
    throw new BadRequestException(`${argName} must be a YYYY-MM-DD date`);
  }
}

/**
 * Read-side egress for the insights domain. All queries are owner-scoped: the
 * service context is derived from the authenticated caller, so a user can only
 * ever read their own feature-store rows and answers.
 */
@UseGuards(JwtOrApiKeyAuthGuard)
@Resolver(() => DailyMetricsType)
export class InsightsResolver {
  constructor(
    private readonly dailyMetricsService: DailyMetricsService,
    private readonly descriptiveQuestionService: DescriptiveQuestionService,
  ) {}

  @Query(() => [DailyMetricsType], {
    description:
      'Stored daily feature-store rows for the signed-in user over an inclusive [from, to] date range, oldest first',
  })
  async dailyMetrics(
    @Context() context: RequestContext,
    @Args('from', { type: () => String, description: 'YYYY-MM-DD (inclusive)' }) from: string,
    @Args('to', { type: () => String, description: 'YYYY-MM-DD (inclusive)' }) to: string,
  ): Promise<DailyMetricsType[]> {
    assertIsoDate(from, 'from');
    assertIsoDate(to, 'to');

    const rows = await this.dailyMetricsService.getRange(toServiceContext(context), from, to);

    return rows.map(DailyMetricsType.toType);
  }

  @Query(() => InsightAnswerType, {
    nullable: true,
    description:
      'Answer one catalog question (by key) from the stored daily metrics; null for an unknown key',
  })
  async insightAnswer(
    @Context() context: RequestContext,
    @Args('questionKey', { type: () => String }) questionKey: string,
    @Args('date', {
      type: () => String,
      nullable: true,
      description: 'Anchor date YYYY-MM-DD (inclusive end of the timeframe); defaults to today (UTC)',
    })
    date?: string,
  ): Promise<InsightAnswerType | null> {
    if (date !== undefined) {
      assertIsoDate(date, 'date');
    }

    const spec = QUESTION_CATALOG.find((candidate) => candidate.key === questionKey);

    if (!spec) {
      return null;
    }

    const answer = await this.descriptiveQuestionService.answer(toServiceContext(context), spec, {
      date,
    });

    return InsightAnswerType.toType(answer);
  }

  @Query(() => [InsightAnswerType], {
    description: 'Answer the whole descriptive question catalog for one anchor date',
  })
  async insightAnswers(
    @Context() context: RequestContext,
    @Args('date', {
      type: () => String,
      nullable: true,
      description: 'Anchor date YYYY-MM-DD (inclusive end of every timeframe); defaults to today (UTC)',
    })
    date?: string,
  ): Promise<InsightAnswerType[]> {
    if (date !== undefined) {
      assertIsoDate(date, 'date');
    }

    const answers = await this.descriptiveQuestionService.answerAll(toServiceContext(context), { date });

    return answers.map(InsightAnswerType.toType);
  }
}
