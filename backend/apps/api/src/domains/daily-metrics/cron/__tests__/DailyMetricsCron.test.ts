import type { Repository } from 'typeorm';

import type { LoggerService } from '@ci/common/logging';
import type { EventService } from '@ci/domains/events';
import type { UserEntity } from '@ci/domains/user';
import { UserService } from '@ci/domains/user';

import type { HomeConfirmService } from '../../home/HomeConfirmService';
import type { PlaceTransitionService } from '../../places/PlaceTransitionService';
import type { DailyMetricsService } from '../../services/DailyMetricsService';
import type { DerivationScanService } from '../../services/DerivationScanService';
import { DailyMetricsCron } from '../DailyMetricsCron';

type UserRow = Partial<UserEntity> & { id: string; onboarded: boolean };

/**
 * The real UserService over a repository that actually honours `where`, so the
 * fan-out audience is exercised rather than asserted: a caller that asks for
 * every row gets every row back here, exactly as it would from Postgres.
 */
function makeUserService(rows: UserRow[]): UserService {
  const repository = {
    find: jest.fn(async (options?: { where?: Partial<UserEntity> }) => {
      const where = options?.where ?? {};

      return rows.filter((row) =>
        Object.entries(where).every(([column, value]) => row[column as keyof UserRow] === value),
      );
    }),
  } as unknown as Repository<UserEntity>;

  return new UserService(repository, { send: jest.fn(async () => []) } as unknown as EventService);
}

function placeDeps() {
  return {
    placeTransitionService: {
      rebuild: jest.fn().mockResolvedValue({ clusters: 0, transitions: 0 }),
      scoreLog: jest.fn().mockResolvedValue({}),
    } as unknown as PlaceTransitionService,
    userService: makeUserService([]),
  };
}

function makeCron() {
  const pendingResolvers: Array<() => void> = [];
  const refreshAll = jest.fn().mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        pendingResolvers.push(resolve);
      }),
  );
  const scanAll = jest.fn().mockResolvedValue(undefined);
  const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const { placeTransitionService, userService } = placeDeps();

  const cron = new DailyMetricsCron(
    { refreshAll } as unknown as DailyMetricsService,
    placeTransitionService,
    userService,
    { scanAll } as unknown as DerivationScanService,
    { ensureAction: jest.fn().mockResolvedValue(undefined) } as unknown as HomeConfirmService,
    logger as unknown as LoggerService,
  );

  return { cron, refreshAll, scanAll, logger, finishRefresh: () => pendingResolvers.shift()?.() };
}

describe('DailyMetricsCron.refreshRecent', () => {
  it('skips a tick while the previous refresh is still running', async () => {
    const { cron, refreshAll, logger, finishRefresh } = makeCron();

    const first = cron.refreshRecent();
    await cron.refreshRecent();

    expect(refreshAll).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalled();

    finishRefresh();
    await first;

    const second = cron.refreshRecent();
    finishRefresh();
    await second;

    expect(refreshAll).toHaveBeenCalledTimes(2);
  });

  it('releases the overlap guard when a refresh fails', async () => {
    const refreshAll = jest.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(undefined);
    const scanAll = jest.fn().mockResolvedValue(undefined);
    const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    const { placeTransitionService, userService } = placeDeps();
    const cron = new DailyMetricsCron(
      { refreshAll } as unknown as DailyMetricsService,
      placeTransitionService,
      userService,
      { scanAll } as unknown as DerivationScanService,
      { ensureAction: jest.fn().mockResolvedValue(undefined) } as unknown as HomeConfirmService,
      logger as unknown as LoggerService,
    );

    await cron.refreshRecent();

    expect(logger.error).toHaveBeenCalled();
    expect(scanAll).toHaveBeenCalledTimes(1);

    await cron.refreshRecent();

    expect(refreshAll).toHaveBeenCalledTimes(2);
  });

  it('runs the derivation scan after metrics refresh', async () => {
    const { cron, scanAll, finishRefresh } = makeCron();

    const run = cron.refreshRecent();
    finishRefresh();
    await run;

    expect(scanAll).toHaveBeenCalledTimes(1);
  });

  it('rebuilds and scores the place engine after metrics refresh', async () => {
    const refreshAll = jest.fn().mockResolvedValue(undefined);
    const scanAll = jest.fn().mockResolvedValue(undefined);
    const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    const rebuild = jest.fn().mockResolvedValue({ clusters: 2, transitions: 3 });
    const scoreLog = jest.fn().mockResolvedValue({});
    const cron = new DailyMetricsCron(
      { refreshAll } as unknown as DailyMetricsService,
      { rebuild, scoreLog } as unknown as PlaceTransitionService,
      makeUserService([{ id: 'user-1', onboarded: true, timezone: 'America/New_York' }]),
      { scanAll } as unknown as DerivationScanService,
      { ensureAction: jest.fn().mockResolvedValue(undefined) } as unknown as HomeConfirmService,
      logger as unknown as LoggerService,
    );

    await cron.refreshRecent();

    expect(rebuild).toHaveBeenCalledWith({ userId: 'user-1' }, { timezone: 'America/New_York' });
    expect(scoreLog).toHaveBeenCalledWith({ userId: 'user-1' });
    expect(scanAll).toHaveBeenCalledTimes(1);
  });
});

const ONBOARDED = '00000000-0000-0000-0000-0000000000aa';
const SIGNED_UP_ONLY = '00000000-0000-0000-0000-0000000000bb';

function makeCronFor(rows: UserRow[]) {
  const dailyMetricsService = { refreshAll: jest.fn(async () => undefined) };
  const placeTransitionService = {
    rebuild: jest.fn(async () => undefined),
    scoreLog: jest.fn(async () => undefined),
  };
  const homeConfirmService = { ensureAction: jest.fn(async () => undefined) };
  const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };

  const cron = new DailyMetricsCron(
    dailyMetricsService as unknown as DailyMetricsService,
    placeTransitionService as unknown as PlaceTransitionService,
    makeUserService(rows),
    { scanAll: jest.fn(async () => undefined) } as unknown as DerivationScanService,
    homeConfirmService as unknown as HomeConfirmService,
    logger as unknown as LoggerService,
  );

  return { cron, dailyMetricsService, placeTransitionService, homeConfirmService, logger };
}

function population(count: number): UserRow[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `user-${String(index).padStart(3, '0')}`,
    onboarded: true,
    timezone: 'UTC',
  }));
}

function userIdsPassedTo(mock: jest.Mock): string[] {
  return mock.mock.calls.map((call) => (call[0] as { userId: string }).userId);
}

describe('DailyMetricsCron fan-out audience', () => {
  const rows: UserRow[] = [
    { id: ONBOARDED, onboarded: true, timezone: 'America/New_York' },
    { id: SIGNED_UP_ONLY, onboarded: false, timezone: 'UTC' },
  ];

  it('rebuilds the place engine only for onboarded users', async () => {
    const { cron, placeTransitionService } = makeCronFor(rows);

    await cron.refreshRecent();

    expect(userIdsPassedTo(placeTransitionService.rebuild as jest.Mock)).toEqual([ONBOARDED]);
    expect(userIdsPassedTo(placeTransitionService.scoreLog as jest.Mock)).toEqual([ONBOARDED]);
  });

  it('enqueues the home-confirm ask only for onboarded users', async () => {
    const { cron, homeConfirmService } = makeCronFor(rows);

    await cron.refreshRecent();

    expect(userIdsPassedTo(homeConfirmService.ensureAction as jest.Mock)).toEqual([ONBOARDED]);
  });
});

describe('DailyMetricsCron place-engine rotation', () => {
  it('caps one tick at 25 users and resumes where the previous tick stopped', async () => {
    const { cron, placeTransitionService } = makeCronFor(population(30));
    const rebuild = placeTransitionService.rebuild as jest.Mock;

    await cron.refreshRecent();

    expect(userIdsPassedTo(rebuild)).toEqual(population(25).map((user) => user.id));

    rebuild.mockClear();
    await cron.refreshRecent();

    // Wraps: the five that missed the first tick, then back to the head.
    const second = userIdsPassedTo(rebuild);
    expect(second).toHaveLength(25);
    expect(second.slice(0, 5)).toEqual(['user-025', 'user-026', 'user-027', 'user-028', 'user-029']);
    expect(second[5]).toBe('user-000');
  });

  it('refreshes every user each tick when the population fits under the cap', async () => {
    const { cron, placeTransitionService } = makeCronFor(population(3));
    const rebuild = placeTransitionService.rebuild as jest.Mock;

    await cron.refreshRecent();
    rebuild.mockClear();
    await cron.refreshRecent();

    expect(userIdsPassedTo(rebuild)).toEqual(['user-000', 'user-001', 'user-002']);
  });
});

describe('DailyMetricsCron overrun reporting', () => {
  it('reports how long the in-flight run has been going and how many ticks it has eaten', async () => {
    const { cron, dailyMetricsService, logger } = makeCronFor(population(1));

    let release: () => void = () => {};

    (dailyMetricsService.refreshAll as jest.Mock).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );

    const inFlight = cron.refreshRecent();
    await Promise.resolve();

    await cron.refreshRecent();
    await cron.refreshRecent();

    const skips = logger.warn.mock.calls.filter(([message]) =>
      String(message).includes('Skipping daily metrics refresh'),
    );

    expect(skips).toHaveLength(2);
    expect(skips[0][1]).toEqual({ runningForMs: expect.any(Number), consecutiveSkips: 1 });
    expect(skips[1][1]).toEqual({ runningForMs: expect.any(Number), consecutiveSkips: 2 });

    release();
    await inFlight;
  });
});
