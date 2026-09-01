import type { UserServiceContext } from '@ci/common/context';
import type { LoggerService } from '@ci/common/logging';

import { shiftIso, todayIsoInTimezone } from '../dateUtil';
import type { DailyMetricsService } from '../services/DailyMetricsService';
import {
  METRIC_KEYS,
  type DailyMetrics,
  type MetricCoverage,
  type MetricKey,
  type MetricValues,
} from '../types';

import { CorrelationEngine } from './CorrelationEngine';

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

function rng(seed: number): () => number {
  let state = seed >>> 0;

  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    const u1 = (state + 1) / 4294967297;
    state = (1664525 * state + 1013904223) >>> 0;
    const u2 = (state + 1) / 4294967297;

    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  };
}

function memoryRepo() {
  const rows: Array<Record<string, unknown>> = [];

  return {
    rows,
    findOne: jest.fn(async ({ where }: { where: Record<string, unknown> }) => {
      return rows.find((row) => Object.entries(where).every(([key, value]) => row[key] === value)) ?? null;
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
    find: jest.fn(async ({ where }: { where: Record<string, unknown> }) =>
      rows.filter((row) => Object.entries(where).every(([key, value]) => row[key] === value)),
    ),
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

describe('CorrelationEngine.scan', () => {
  it('persists a planted contemporaneous association as robust across windows', async () => {
    const gauss = rng(3);
    const yesterday = shiftIso(todayIsoInTimezone('UTC'), -1);
    const repo = memoryRepo();
    const metricsService = {
      // Null = "the store has nothing"; the engine then falls back to the
      // wall clock, which is the behaviour these fixtures were written against.
      analysisAnchor: jest.fn(async () => null),
      getRange: jest.fn(async (_context: UserServiceContext, from: string, to: string) => {
        const rows: DailyMetrics[] = [];
        let date = from;
        while (date <= to) {
          const conversations = Math.abs(gauss()) * 4 + 4;
          rows.push(
            day(date, {
              n_conversations: conversations,
              avg_sentiment: 0.15 * conversations + gauss() * 0.05,
            }),
          );
          date = shiftIso(date, 1);
        }

        return rows;
      }),
    };

    const engine = new CorrelationEngine(
      repo as never,
      metricsService as unknown as DailyMetricsService,
      logger(),
    );

    const persisted = await engine.scan(CONTEXT, 'UTC');
    const pair = persisted.filter(
      (row) =>
        row.lagDays === 0 &&
        ((row.metricA === 'n_conversations' && row.metricB === 'avg_sentiment') ||
          (row.metricA === 'avg_sentiment' && row.metricB === 'n_conversations')),
    );

    expect(metricsService.getRange).toHaveBeenCalled();
    expect(pair.length).toBeGreaterThan(0);
    expect(pair.some((row) => row.robust)).toBe(true);
    expect(persisted.every((row) => (row.qValue ?? 1) <= 0.1)).toBe(true);
    expect(JSON.stringify(pair).toLowerCase()).not.toContain('cause');
    expect(yesterday).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('scanAround is reserved and persists nothing', async () => {
    const engine = new CorrelationEngine(
      memoryRepo() as never,
      { getRange: jest.fn(), analysisAnchor: jest.fn(async () => null) } as never,
      logger(),
    );

    await expect(engine.scanAround(CONTEXT, { date: '2026-08-01', kind: 'trip' })).resolves.toEqual([]);
  });
});
