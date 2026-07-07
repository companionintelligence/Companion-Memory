import { BadRequestException } from '@nestjs/common';

import { type RequestContext } from '@ci/common/context';
import { QUESTION_CATALOG, type DailyMetrics, type DescriptiveAnswer } from '@ci/domains/insights';

import { InsightsResolver } from '../InsightsResolver';

/**
 * Resolver-layer tests for the insights egress:
 *  - dailyMetrics(from, to): owner-scoped range read + camelCase mapping, with
 *    strict YYYY-MM-DD validation before anything reaches SQL.
 *  - insightAnswer(questionKey): catalog lookup (null on unknown key) and the
 *    computed-value/narration/provenance passthrough.
 *  - insightAnswers: whole-catalog fan-out.
 */

const ownerCtx = { userId: 'owner-1' } as unknown as RequestContext;

const sampleDay: DailyMetrics = {
  userId: 'owner-1',
  date: '2026-07-06',
  timezone: 'UTC',
  metrics: {
    n_messages: 12,
    n_conversations: 4,
    n_unique_contacts: 3,
    outbound_ratio: 0.25,
    avg_sentiment: 0.1,
    n_places: null,
    km_traveled: null,
    screen_minutes: 42.5,
    n_domains: 7,
    spend_total: 19.99,
  },
  coverage: {
    n_messages: 1,
    n_conversations: 1,
    n_unique_contacts: 1,
    outbound_ratio: 1,
    avg_sentiment: 0.5,
    n_places: 0,
    km_traveled: 0,
    screen_minutes: 0.8,
    n_domains: 1,
    spend_total: 1,
  },
  computedAt: new Date('2026-07-07T00:20:00Z'),
};

const sampleAnswer: DescriptiveAnswer = {
  key: 'rel.messages_week',
  category: 'Relationships',
  question: 'How many messages did I exchange this week?',
  value: 84,
  unit: undefined,
  timeframe: 'the last 7 days',
  answer: 'You exchanged 84 messages over the last 7 days.',
  provenance: {
    metric: 'n_messages',
    aggregate: 'sum',
    timeframe: 'the last 7 days',
    dateRange: { from: '2026-06-30', to: '2026-07-06' },
    daysWithData: 6,
    daysInRange: 7,
    meanCoverage: 0.9,
    sources: ['ci.communications'],
  },
};

function makeResolver() {
  const dailyMetricsService = { getRange: jest.fn(async () => [sampleDay]) };
  const descriptiveQuestionService = {
    answer: jest.fn(async () => sampleAnswer),
    answerAll: jest.fn(async () => [sampleAnswer, sampleAnswer]),
  };

  const resolver = new InsightsResolver(dailyMetricsService as never, descriptiveQuestionService as never);

  return { resolver, dailyMetricsService, descriptiveQuestionService };
}

describe('InsightsResolver.dailyMetrics', () => {
  it('reads the range as the signed-in user and maps rows to the GraphQL shape', async () => {
    const { resolver, dailyMetricsService } = makeResolver();

    const rows = await resolver.dailyMetrics(ownerCtx, '2026-07-01', '2026-07-06');

    expect(dailyMetricsService.getRange).toHaveBeenCalledWith(
      { userId: 'owner-1' },
      '2026-07-01',
      '2026-07-06',
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      date: '2026-07-06',
      nMessages: 12,
      nPlaces: null,
      screenMinutes: 42.5,
      spendTotal: 19.99,
      computedAt: '2026-07-07T00:20:00.000Z',
    });
    expect(rows[0].coverage.avg_sentiment).toBeCloseTo(0.5, 5);
  });

  it('rejects a non-ISO date argument before touching the service', async () => {
    const { resolver, dailyMetricsService } = makeResolver();

    await expect(resolver.dailyMetrics(ownerCtx, 'not-a-date', '2026-07-06')).rejects.toThrow(
      BadRequestException,
    );
    expect(dailyMetricsService.getRange).not.toHaveBeenCalled();
  });
});

describe('InsightsResolver.insightAnswer', () => {
  it('answers a known catalog question with value + narration + provenance', async () => {
    const { resolver, descriptiveQuestionService } = makeResolver();

    const answer = await resolver.insightAnswer(ownerCtx, 'rel.messages_week', '2026-07-06');

    const spec = QUESTION_CATALOG.find((candidate) => candidate.key === 'rel.messages_week');

    expect(descriptiveQuestionService.answer).toHaveBeenCalledWith({ userId: 'owner-1' }, spec, {
      date: '2026-07-06',
    });

    expect(answer).toMatchObject({
      key: 'rel.messages_week',
      value: 84,
      answer: 'You exchanged 84 messages over the last 7 days.',
    });
    expect(answer?.provenance).toMatchObject({
      fromDate: '2026-06-30',
      toDate: '2026-07-06',
      daysWithData: 6,
      sources: ['ci.communications'],
    });
  });

  it('returns null (not an error) for an unknown question key', async () => {
    const { resolver, descriptiveQuestionService } = makeResolver();

    const answer = await resolver.insightAnswer(ownerCtx, 'nope.unknown');

    expect(answer).toBeNull();
    expect(descriptiveQuestionService.answer).not.toHaveBeenCalled();
  });

  it('rejects a malformed anchor date', async () => {
    const { resolver } = makeResolver();

    await expect(resolver.insightAnswer(ownerCtx, 'rel.messages_week', '07/06/2026')).rejects.toThrow(
      BadRequestException,
    );
  });
});

describe('InsightsResolver.insightAnswers', () => {
  it('answers the whole catalog for the signed-in user', async () => {
    const { resolver, descriptiveQuestionService } = makeResolver();

    const answers = await resolver.insightAnswers(ownerCtx, '2026-07-06');

    expect(descriptiveQuestionService.answerAll).toHaveBeenCalledWith(
      { userId: 'owner-1' },
      { date: '2026-07-06' },
    );
    expect(answers).toHaveLength(2);
    expect(answers[0].key).toBe('rel.messages_week');
  });
});
