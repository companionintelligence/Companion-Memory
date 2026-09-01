import type { UserServiceContext } from '@ci/common/context';
import type { FeatureService } from '@ci/common/feature';
import type { LoggerService } from '@ci/common/logging';
import type { ActionService } from '@ci/domains/intelligence';

import type { CorrelationEngine } from '../correlation/CorrelationEngine';
import { shiftIso, todayIsoInTimezone } from '../dateUtil';
import type { MetricAnomaly } from '../entities/MetricAnomalyEntity';
import type { SuggestionEvidence } from '../entities/MetricSuggestionEntity';
import type { DailyMetricsService } from '../services/DailyMetricsService';
import {
  METRIC_KEYS,
  type DailyMetrics,
  type MetricCoverage,
  type MetricKey,
  type MetricValues,
} from '../types';

import { SuggestionEngine } from './SuggestionEngine';

const USER = '00000000-0000-0000-0000-0000000000aa';
const CONTEXT: UserServiceContext = { userId: USER };

function nullMetrics(): MetricValues {
  return Object.fromEntries(METRIC_KEYS.map((key) => [key, null])) as MetricValues;
}

function day(date: string, values: Partial<Record<MetricKey, number>>): DailyMetrics {
  const metrics = nullMetrics();
  const coverage = Object.fromEntries(METRIC_KEYS.map((key) => [key, 0])) as MetricCoverage;
  for (const [key, value] of Object.entries(values) as Array<[MetricKey, number]>) {
    metrics[key] = value;
    coverage[key] = 1;
  }

  return { userId: USER, date, timezone: 'UTC', metrics, coverage, computedAt: new Date() };
}

function memoryRepo() {
  const rows: Array<Record<string, unknown>> = [];

  return {
    rows,
    findOne: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
      return (
        rows.find((row) =>
          Object.entries(where).every(([key, value]) => {
            if (value && typeof value === 'object' && '_type' in (value as object)) {
              return row[key] == null;
            }

            return row[key] === value;
          }),
        ) ?? null
      );
    }),
    create: jest.fn((value: Record<string, unknown>) => ({ ...value })),
    save: jest.fn(async (entity: Record<string, unknown>) => {
      const index = rows.findIndex((row) => row.id === entity.id);
      if (index >= 0) {
        rows[index] = entity;
      } else {
        rows.push(entity);
      }

      return entity;
    }),
    update: jest.fn(async ({ id }: { id: string }, patch: Record<string, unknown>) => {
      const row = rows.find((item) => item.id === id);
      if (row) {
        Object.assign(row, patch);
      }
    }),
    find: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
      return rows.filter((row) =>
        Object.entries(where).every(([key, value]) => {
          if (value && typeof value === 'object' && '_type' in (value as object)) {
            return row[key] == null;
          }

          return row[key] === value;
        }),
      );
    }),
    createQueryBuilder: jest.fn(),
  };
}

function logger(): LoggerService {
  return {
    setContext: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  } as unknown as LoggerService;
}

function quietConversationRows(yesterday: string, from: string, to: string): DailyMetrics[] {
  const rows: DailyMetrics[] = [];
  let date = from;
  while (date <= to) {
    rows.push(
      day(date, {
        n_conversations: date === yesterday ? 2 : 10,
        n_places: date === yesterday ? 1 : 4,
      }),
    );
    date = shiftIso(date, 1);
  }

  return rows;
}

describe('SuggestionEngine.propose', () => {
  it('does not emit without a correlation or anomaly evidence FK', async () => {
    const yesterday = shiftIso(todayIsoInTimezone('UTC'), -1);
    const suggestions = memoryRepo();
    const engine = new SuggestionEngine(
      suggestions as never,
      memoryRepo() as never,
      {
        // Null = "the store has nothing"; the engine then falls back to the
        // wall clock, which is the behaviour these fixtures were written against.
        analysisAnchor: jest.fn(async () => null),
        getRange: jest.fn(async (_context: UserServiceContext, from: string, to: string) =>
          quietConversationRows(yesterday, from, to),
        ),
      } as unknown as DailyMetricsService,
      { list: jest.fn().mockResolvedValue([]) } as unknown as CorrelationEngine,
      {
        create: jest.fn(),
        countDerivedOnLocalDay: jest.fn().mockResolvedValue(0),
      } as unknown as ActionService,
      { isFeatureEnabled: jest.fn().mockResolvedValue(true) } as unknown as FeatureService,
      logger(),
    );

    const persisted = await engine.propose(CONTEXT, [], 'UTC');

    expect(persisted).toHaveLength(0);
  });

  it('persists with evidence when the flag is off and does not create a Brief action', async () => {
    const yesterday = shiftIso(todayIsoInTimezone('UTC'), -1);
    const suggestions = memoryRepo();
    const create = jest.fn();
    const engine = new SuggestionEngine(
      suggestions as never,
      memoryRepo() as never,
      {
        // Null = "the store has nothing"; the engine then falls back to the
        // wall clock, which is the behaviour these fixtures were written against.
        analysisAnchor: jest.fn(async () => null),
        getRange: jest.fn(async (_context: UserServiceContext, from: string, to: string) =>
          quietConversationRows(yesterday, from, to),
        ),
      } as unknown as DailyMetricsService,
      {
        list: jest
          .fn()
          .mockResolvedValue([
            { id: 'corr-1', metricA: 'n_conversations', metricB: 'avg_sentiment', robust: true },
          ]),
      } as unknown as CorrelationEngine,
      { create, countDerivedOnLocalDay: jest.fn().mockResolvedValue(0) } as unknown as ActionService,
      { isFeatureEnabled: jest.fn().mockResolvedValue(false) } as unknown as FeatureService,
      logger(),
    );

    const persisted = await engine.propose(CONTEXT, [], 'UTC');

    expect(persisted.length).toBeGreaterThan(0);
    expect(persisted.every((row) => row.correlationId === 'corr-1' || row.anomalyId)).toBe(true);
    expect(create).not.toHaveBeenCalled();
  });

  it('promotes at most one live suggestion action when the flag is on', async () => {
    const yesterday = shiftIso(todayIsoInTimezone('UTC'), -1);
    const suggestions = memoryRepo();
    const create = jest.fn().mockResolvedValue({ id: 'action-1' });
    const anomalies: MetricAnomaly[] = [
      {
        id: 'anom-1',
        userId: USER,
        metric: 'n_places',
        date: yesterday,
        detector: 'robust_z',
        value: 1,
        baseline: 4,
        score: 3.6,
        direction: 'low',
        coverage: 1,
        metadata: {},
        actionId: null,
        computedAt: new Date(),
      },
    ];
    const engine = new SuggestionEngine(
      suggestions as never,
      memoryRepo() as never,
      {
        // Null = "the store has nothing"; the engine then falls back to the
        // wall clock, which is the behaviour these fixtures were written against.
        analysisAnchor: jest.fn(async () => null),
        getRange: jest.fn(async (_context: UserServiceContext, from: string, to: string) =>
          quietConversationRows(yesterday, from, to),
        ),
      } as unknown as DailyMetricsService,
      {
        list: jest
          .fn()
          .mockResolvedValue([
            { id: 'corr-1', metricA: 'n_conversations', metricB: 'avg_sentiment', robust: true },
          ]),
      } as unknown as CorrelationEngine,
      { create, countDerivedOnLocalDay: jest.fn().mockResolvedValue(0) } as unknown as ActionService,
      { isFeatureEnabled: jest.fn().mockResolvedValue(true) } as unknown as FeatureService,
      logger(),
    );

    const persisted = await engine.propose(CONTEXT, anomalies, 'UTC');

    expect(persisted.length).toBeGreaterThan(1);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create.mock.calls[0][1].source).toBe('suggestion');
  });
});

const EVIDENCE: SuggestionEvidence = {
  metric: 'n_conversations',
  windowDays: 14,
  baseline: 10,
  current: 2,
  gap: 8,
  sources: ['communication'],
};

function makeFeedbackEngine(seedRow?: Record<string, unknown>) {
  const suggestions = memoryRepo();
  const arms = memoryRepo();
  if (seedRow) {
    suggestions.rows.push(seedRow);
  }

  const markAsSeen = jest.fn();
  const markAsDismissed = jest.fn();
  const decayNoveltyForMetric = jest.fn();

  const engine = new SuggestionEngine(
    suggestions as never,
    arms as never,
    {} as unknown as DailyMetricsService,
    { decayNoveltyForMetric } as unknown as CorrelationEngine,
    { markAsSeen, markAsDismissed } as unknown as ActionService,
    {} as unknown as FeatureService,
    logger(),
  );

  return { engine, suggestions, arms, markAsSeen, markAsDismissed, decayNoveltyForMetric };
}

describe('SuggestionEngine.feedback', () => {
  it('returns null without writing anything when the suggestion does not exist or is not owned by the user', async () => {
    const { engine, arms, markAsSeen, markAsDismissed } = makeFeedbackEngine();

    const result = await engine.feedback(CONTEXT, 'missing-id', true);

    expect(result).toBeNull();
    expect(arms.rows).toHaveLength(0);
    expect(markAsSeen).not.toHaveBeenCalled();
    expect(markAsDismissed).not.toHaveBeenCalled();
  });

  it('on accept: sets acceptedAt (not dismissedAt), marks the linked action seen, and bumps the arm toward acceptance', async () => {
    const { engine, arms, markAsSeen, markAsDismissed } = makeFeedbackEngine({
      id: 'sugg-1',
      userId: USER,
      key: 'rel.conversations_low',
      actionId: 'action-1',
      correlationId: null,
      acceptedAt: null,
      dismissedAt: null,
      evidence: EVIDENCE,
    });

    const result = await engine.feedback(CONTEXT, 'sugg-1', true);

    expect(result?.acceptedAt).toBeInstanceOf(Date);
    expect(result?.dismissedAt).toBeNull();
    expect(markAsSeen).toHaveBeenCalledWith(CONTEXT, 'action-1');
    expect(markAsDismissed).not.toHaveBeenCalled();
    // bumpArm creates a fresh arm since none existed, biased toward accept (alpha+1, beta unchanged).
    expect(arms.rows).toEqual([
      expect.objectContaining({ userId: USER, key: 'rel.conversations_low', alpha: 2, beta: 1 }),
    ]);
  });

  it('on dismiss: sets dismissedAt, marks the linked action dismissed, bumps the arm toward rejection, and decays correlation novelty', async () => {
    const { engine, arms, markAsSeen, markAsDismissed, decayNoveltyForMetric } = makeFeedbackEngine({
      id: 'sugg-1',
      userId: USER,
      key: 'money.spend_spike',
      actionId: 'action-1',
      correlationId: 'corr-1',
      acceptedAt: null,
      dismissedAt: null,
      evidence: EVIDENCE,
    });

    const result = await engine.feedback(CONTEXT, 'sugg-1', false);

    expect(result?.dismissedAt).toBeInstanceOf(Date);
    expect(result?.acceptedAt).toBeNull();
    expect(markAsDismissed).toHaveBeenCalledWith(CONTEXT, 'action-1');
    expect(markAsSeen).not.toHaveBeenCalled();
    expect(arms.rows).toEqual([
      expect.objectContaining({ userId: USER, key: 'money.spend_spike', alpha: 1, beta: 2 }),
    ]);
    expect(decayNoveltyForMetric).toHaveBeenCalledWith(USER, EVIDENCE.metric);
  });

  it('does not decay correlation novelty on accept, even when the suggestion has a correlationId', async () => {
    const { engine, decayNoveltyForMetric } = makeFeedbackEngine({
      id: 'sugg-1',
      userId: USER,
      key: 'money.spend_spike',
      actionId: null,
      correlationId: 'corr-1',
      acceptedAt: null,
      dismissedAt: null,
      evidence: EVIDENCE,
    });

    await engine.feedback(CONTEXT, 'sugg-1', true);

    expect(decayNoveltyForMetric).not.toHaveBeenCalled();
  });

  it('skips action-service calls entirely when the suggestion has no linked actionId, but still bumps the arm', async () => {
    const { engine, arms, markAsSeen, markAsDismissed } = makeFeedbackEngine({
      id: 'sugg-1',
      userId: USER,
      key: 'attention.screen_spike',
      actionId: null,
      correlationId: null,
      acceptedAt: null,
      dismissedAt: null,
      evidence: EVIDENCE,
    });

    await engine.feedback(CONTEXT, 'sugg-1', true);

    expect(markAsSeen).not.toHaveBeenCalled();
    expect(markAsDismissed).not.toHaveBeenCalled();
    expect(arms.rows).toHaveLength(1);
  });

  it('bumps an existing arm in place rather than creating a duplicate row', async () => {
    const { engine, arms } = makeFeedbackEngine({
      id: 'sugg-1',
      userId: USER,
      key: 'places.one_place',
      actionId: null,
      correlationId: null,
      acceptedAt: null,
      dismissedAt: null,
      evidence: EVIDENCE,
    });
    arms.rows.push({ userId: USER, key: 'places.one_place', alpha: 3, beta: 5 });

    await engine.feedback(CONTEXT, 'sugg-1', true);

    expect(arms.rows).toEqual([
      expect.objectContaining({ userId: USER, key: 'places.one_place', alpha: 4, beta: 5 }),
    ]);
  });
});
