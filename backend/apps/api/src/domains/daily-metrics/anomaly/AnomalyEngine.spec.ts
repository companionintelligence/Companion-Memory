import type { UserServiceContext } from '@ci/common/context';
import type { FeatureService } from '@ci/common/feature';
import type { LoggerService } from '@ci/common/logging';
import type { ActionService } from '@ci/domains/intelligence';

import { shiftIso, todayIsoInTimezone } from '../dateUtil';
import type { DailyMetricsService } from '../services/DailyMetricsService';
import {
  METRIC_KEYS,
  type DailyMetrics,
  type MetricCoverage,
  type MetricKey,
  type MetricValues,
} from '../types';

import { AnomalyEngine } from './AnomalyEngine';

const USER = '00000000-0000-0000-0000-0000000000aa';
const CONTEXT: UserServiceContext = { userId: USER };

function nullMetrics(): MetricValues {
  return Object.fromEntries(METRIC_KEYS.map((key) => [key, null])) as MetricValues;
}

function day(date: string, values: Partial<Record<MetricKey, number>>, coverage = 1): DailyMetrics {
  const metrics = nullMetrics();
  const cov = Object.fromEntries(METRIC_KEYS.map((key) => [key, 0])) as MetricCoverage;
  for (const [key, value] of Object.entries(values) as Array<[MetricKey, number]>) {
    metrics[key] = value;
    cov[key] = coverage;
  }

  return { userId: USER, date, timezone: 'UTC', metrics, coverage: cov, computedAt: new Date() };
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
    update: jest.fn(async ({ id }: { id: string }, patch: Record<string, unknown>) => {
      const row = rows.find((item) => item.id === id);
      if (row) {
        Object.assign(row, patch);
      }
    }),
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

describe('AnomalyEngine.scan', () => {
  it('persists a robust-z outlier and does not enqueue actions when the flag is off', async () => {
    const yesterday = shiftIso(todayIsoInTimezone('UTC'), -1);
    const repo = memoryRepo();
    const create = jest.fn();
    const metricsService = {
      // Null = "the store has nothing"; the engine then falls back to the
      // wall clock, which is the behaviour these fixtures were written against.
      analysisAnchor: jest.fn(async () => null),
      getRange: jest.fn(async (_context: UserServiceContext, from: string, to: string) => {
        const rows: DailyMetrics[] = [];
        let date = from;
        let index = 0;
        while (date <= to) {
          const value = date === yesterday ? 40 : 10 + (index % 3) * 0.2;
          rows.push(day(date, { n_conversations: value }));
          date = shiftIso(date, 1);
          index += 1;
        }

        return rows;
      }),
    };
    const dataSource = {
      query: jest.fn().mockRejectedValue(Object.assign(new Error('undefined_table'), { code: '42P01' })),
    };

    const engine = new AnomalyEngine(
      repo as never,
      dataSource as never,
      metricsService as unknown as DailyMetricsService,
      { create, countDerivedOnLocalDay: jest.fn().mockResolvedValue(0) } as unknown as ActionService,
      { isFeatureEnabled: jest.fn().mockResolvedValue(false) } as unknown as FeatureService,
      logger(),
    );

    const persisted = await engine.scan(CONTEXT, 'UTC');
    const zHits = persisted.filter((row) => row.detector === 'robust_z' && row.metric === 'n_conversations');

    expect(zHits.length).toBeGreaterThan(0);
    expect(zHits.some((row) => row.date === yesterday)).toBe(true);
    expect(create).not.toHaveBeenCalled();
  });

  it('promotes at most 3 anomaly actions when the flag is on', async () => {
    const yesterday = shiftIso(todayIsoInTimezone('UTC'), -1);
    const repo = memoryRepo();
    const create = jest.fn().mockImplementation(async (_context: unknown, data: { title: string }) => ({
      id: `action-${data.title}`,
    }));
    const metricsService = {
      // Null = "the store has nothing"; the engine then falls back to the
      // wall clock, which is the behaviour these fixtures were written against.
      analysisAnchor: jest.fn(async () => null),
      getRange: jest.fn(async (_context: UserServiceContext, from: string, to: string) => {
        const rows: DailyMetrics[] = [];
        let date = from;
        let index = 0;
        while (date <= to) {
          const spike = date === yesterday;
          rows.push(
            day(date, {
              n_conversations: spike ? 40 : 10 + (index % 3) * 0.2,
              n_places: spike ? 12 : 3 + (index % 2) * 0.1,
              screen_minutes: spike ? 400 : 80 + (index % 4),
              spend_total: spike ? 90 : 12 + (index % 3),
            }),
          );
          date = shiftIso(date, 1);
          index += 1;
        }

        return rows;
      }),
    };

    const engine = new AnomalyEngine(
      repo as never,
      { query: jest.fn().mockRejectedValue(Object.assign(new Error('missing'), { code: '42P01' })) } as never,
      metricsService as unknown as DailyMetricsService,
      { create, countDerivedOnLocalDay: jest.fn().mockResolvedValue(0) } as unknown as ActionService,
      { isFeatureEnabled: jest.fn().mockResolvedValue(true) } as unknown as FeatureService,
      logger(),
    );

    await engine.scan(CONTEXT, 'UTC');

    expect(create.mock.calls.length).toBeGreaterThan(0);
    expect(create.mock.calls.length).toBeLessThanOrEqual(3);
    expect(create.mock.calls.every((call) => call[1].source === 'anomaly')).toBe(true);
  });

  it('does not enqueue when the shared derived-action budget is already full', async () => {
    const yesterday = shiftIso(todayIsoInTimezone('UTC'), -1);
    const repo = memoryRepo();
    const create = jest.fn().mockResolvedValue({ id: 'action-1' });
    const metricsService = {
      // Null = "the store has nothing"; the engine then falls back to the
      // wall clock, which is the behaviour these fixtures were written against.
      analysisAnchor: jest.fn(async () => null),
      getRange: jest.fn(async (_context: UserServiceContext, from: string, to: string) => {
        const rows: DailyMetrics[] = [];
        let date = from;
        let index = 0;
        while (date <= to) {
          rows.push(day(date, { n_conversations: date === yesterday ? 40 : 10 + (index % 3) * 0.2 }));
          date = shiftIso(date, 1);
          index += 1;
        }

        return rows;
      }),
    };

    const engine = new AnomalyEngine(
      repo as never,
      { query: jest.fn().mockRejectedValue(Object.assign(new Error('missing'), { code: '42P01' })) } as never,
      metricsService as unknown as DailyMetricsService,
      {
        create,
        countDerivedOnLocalDay: jest.fn().mockResolvedValue(3),
      } as unknown as ActionService,
      { isFeatureEnabled: jest.fn().mockResolvedValue(true) } as unknown as FeatureService,
      logger(),
    );

    await engine.scan(CONTEXT, 'UTC');

    expect(create).not.toHaveBeenCalled();
  });
});
