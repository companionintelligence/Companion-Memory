import type { UserServiceContext } from '@ci/common/context';

import type { DailyMetrics, MetricCoverage, MetricKey, MetricValues } from '../types'; // MetricCoverage used in day()
import { METRIC_KEYS } from '../types';

import { DescriptiveQuestionService } from './DescriptiveQuestionService';
import { TemplateNarrator, type Narrator } from './Narrator';
import { QUESTION_CATALOG, type QuestionSpec } from './questionCatalog';

const USER = '00000000-0000-0000-0000-0000000000aa';
const CONTEXT: UserServiceContext = { userId: USER };

function nullMetrics(): MetricValues {
  return Object.fromEntries(METRIC_KEYS.map((k) => [k, null])) as MetricValues;
}

function day(date: string, metric: MetricKey, value: number, coverage = 1): DailyMetrics {
  const metrics = nullMetrics();
  metrics[metric] = value;
  const cov = Object.fromEntries(METRIC_KEYS.map((k) => [k, 0])) as MetricCoverage;
  cov[metric] = coverage;

  return { userId: USER, date, timezone: 'UTC', metrics, coverage: cov, computedAt: new Date() };
}

function makeMetricsService(rows: DailyMetrics[]) {
  return {
    getRange: jest.fn(async () => rows),
  };
}

function makeService(rows: DailyMetrics[], narrator: Narrator = new TemplateNarrator()) {
  const metricsService = makeMetricsService(rows);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const service = new DescriptiveQuestionService(metricsService as any, narrator);

  return { service, metricsService };
}

const SUM_SPEC: QuestionSpec = {
  key: 't.sum',
  category: 'Relationships',
  question: 'How many messages this window?',
  metric: 'n_messages',
  aggregate: 'sum',
  timeframe: { days: 3, label: 'the last 3 days' },
  format: 'int',
  template: '{value} messages over {timeframe}.',
};

describe('DescriptiveQuestionService.answer', () => {
  it('computes the value deterministically and narrates it with provenance', async () => {
    const rows = [
      day('2026-07-05', 'n_messages', 2),
      day('2026-07-06', 'n_messages', 3),
      day('2026-07-07', 'n_messages', 5),
    ];
    const { service, metricsService } = makeService(rows);

    const answer = await service.answer(CONTEXT, SUM_SPEC, { date: '2026-07-07' });

    expect(answer.value).toBe(10);
    expect(answer.answer).toBe('10 messages over the last 3 days.');
    expect(answer.provenance.sources).toEqual(['ci.communications']);
    expect(answer.provenance.daysWithData).toBe(3);
    expect(answer.provenance.daysInRange).toBe(3);
    // window is [anchor-2, anchor]
    expect(metricsService.getRange).toHaveBeenCalledWith(CONTEXT, '2026-07-05', '2026-07-07');
  });

  it('returns a null value and a "no data" sentence when nothing is available', async () => {
    const { service } = makeService([]);

    const answer = await service.answer(CONTEXT, SUM_SPEC, { date: '2026-07-07' });

    expect(answer.value).toBeNull();
    expect(answer.answer).toContain("don't have enough data");
    expect(answer.provenance.daysWithData).toBe(0);
    expect(answer.provenance.meanCoverage).toBe(0);
  });

  it('honors "latest" by picking the most recent day in the window', async () => {
    const rows = [
      day('2026-07-05', 'n_places', 1),
      day('2026-07-07', 'n_places', 4),
      day('2026-07-06', 'n_places', 9),
    ];
    const latestSpec: QuestionSpec = {
      ...SUM_SPEC,
      metric: 'n_places',
      aggregate: 'latest',
      template: '{value} places {timeframe}.',
    };
    const { service } = makeService(rows);

    const answer = await service.answer(CONTEXT, latestSpec, { date: '2026-07-07' });

    expect(answer.value).toBe(4); // the 07-07 row, not the larger 07-06
  });

  it('applies a scale (ratio -> percent) before formatting', async () => {
    const rows = [day('2026-07-06', 'outbound_ratio', 0.4), day('2026-07-07', 'outbound_ratio', 0.6)];
    const pctSpec: QuestionSpec = {
      key: 't.pct',
      category: 'Identity',
      question: 'How often do I initiate?',
      metric: 'outbound_ratio',
      aggregate: 'avg',
      timeframe: { days: 2, label: 'the last 2 days' },
      format: 'float1',
      scale: 100,
      unit: '%',
      template: 'You initiate about {value}% of conversations.',
    };
    const { service } = makeService(rows);

    const answer = await service.answer(CONTEXT, pctSpec, { date: '2026-07-07' });

    expect(answer.value).toBeCloseTo(50, 5); // avg(0.4,0.6)=0.5 -> *100
    expect(answer.answer).toBe('You initiate about 50.0% of conversations.');
  });

  it('never lets the narrator change the computed number', async () => {
    const liarNarrator: Narrator = {
      async narrate() {
        return 'the answer is 999999';
      },
    };
    const rows = [day('2026-07-07', 'n_messages', 7)];
    const { service } = makeService(rows, liarNarrator);

    const answer = await service.answer(
      CONTEXT,
      { ...SUM_SPEC, timeframe: { days: 1, label: 'today' } },
      {
        date: '2026-07-07',
      },
    );

    expect(answer.answer).toBe('the answer is 999999'); // narration is free-form
    expect(answer.value).toBe(7); // but the fact is unchanged
  });
});

describe('DescriptiveQuestionService.answerAll', () => {
  it('produces exactly one answer per catalog question', async () => {
    const { service } = makeService([]);
    const answers = await service.answerAll(CONTEXT, { date: '2026-07-07' });
    expect(answers).toHaveLength(QUESTION_CATALOG.length);
  });
});

describe('question catalog integrity', () => {
  it('every question references a real metric and a non-empty template', () => {
    for (const spec of QUESTION_CATALOG) {
      expect(METRIC_KEYS).toContain(spec.metric);
      expect(spec.template.length).toBeGreaterThan(0);
      expect(spec.timeframe.days).toBeGreaterThan(0);
    }
  });
});
