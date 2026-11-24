import type { LoggerService } from '@ci/common/logging';

import type { ActivityRollupService } from '../../services/ActivityRollupService';
import {
  ACTIVITY_CHANGE_MARGIN_MS,
  ACTIVITY_FULL_REFRESH_INTERVAL_MS,
  ActivityRollupCron,
} from '../ActivityRollupCron';

function makeCron() {
  const pendingResolvers: Array<() => void> = [];
  const refreshAll = jest.fn().mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        pendingResolvers.push(resolve);
      }),
  );
  const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };

  const cron = new ActivityRollupCron(
    { refreshAll } as unknown as ActivityRollupService,
    logger as unknown as LoggerService,
  );

  return { cron, refreshAll, logger, finishRefresh: () => pendingResolvers.shift()?.() };
}

describe('ActivityRollupCron.refreshRollup', () => {
  it('skips a tick while the previous refresh is still running', async () => {
    const { cron, refreshAll, finishRefresh } = makeCron();

    const first = cron.refreshRollup();
    await cron.refreshRollup();

    // The skip is the `exclusive` decorator's, logged through the scheduler's
    // own logger (see common/schedule/decorators/Cron.ts), not this cron's.
    expect(refreshAll).toHaveBeenCalledTimes(1);

    finishRefresh();
    await first;

    const second = cron.refreshRollup();
    finishRefresh();
    await second;

    expect(refreshAll).toHaveBeenCalledTimes(2);
  });

  it('releases the overlap guard when a refresh fails', async () => {
    const refreshAll = jest.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(undefined);
    const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    const cron = new ActivityRollupCron(
      { refreshAll } as unknown as ActivityRollupService,
      logger as unknown as LoggerService,
    );

    // The failure is caught and logged by the decorator; the guard releases.
    await expect(cron.refreshRollup()).resolves.toBeUndefined();

    await cron.refreshRollup();

    expect(refreshAll).toHaveBeenCalledTimes(2);
  });
});

describe('ActivityRollupCron full and incremental passes', () => {
  /** A cron on a clock the test moves. */
  function makeClockedCron(refreshAll: jest.Mock) {
    const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };
    let current = new Date('2026-07-01T00:00:25Z');

    class ClockedCron extends ActivityRollupCron {
      protected override now(): Date {
        return current;
      }
    }

    const cron = new ClockedCron(
      { refreshAll } as unknown as ActivityRollupService,
      logger as unknown as LoggerService,
    );

    return { cron, advance: (ms: number) => (current = new Date(current.getTime() + ms)), at: () => current };
  }

  it('runs the first pass in full, then incremental passes from the previous start less the margin', async () => {
    const refreshAll = jest.fn().mockResolvedValue(undefined);
    const { cron, advance, at } = makeClockedCron(refreshAll);

    await cron.refreshRollup();
    expect(refreshAll).toHaveBeenLastCalledWith({});

    const firstStart = at();
    advance(15 * 60_000);
    await cron.refreshRollup();
    expect(refreshAll).toHaveBeenLastCalledWith({
      changedSince: new Date(firstStart.getTime() - ACTIVITY_CHANGE_MARGIN_MS),
    });

    const secondStart = at();
    advance(15 * 60_000);
    await cron.refreshRollup();
    expect(refreshAll).toHaveBeenLastCalledWith({
      changedSince: new Date(secondStart.getTime() - ACTIVITY_CHANGE_MARGIN_MS),
    });
  });

  it('keeps the window where it was after a failed pass, so nothing is skipped', async () => {
    const refreshAll = jest
      .fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(undefined);
    const { cron, advance, at } = makeClockedCron(refreshAll);

    await cron.refreshRollup();
    const firstStart = at();

    advance(15 * 60_000);
    await cron.refreshRollup(); // fails

    advance(15 * 60_000);
    await cron.refreshRollup();
    expect(refreshAll).toHaveBeenLastCalledWith({
      changedSince: new Date(firstStart.getTime() - ACTIVITY_CHANGE_MARGIN_MS),
    });
  });

  it('runs a full pass again once a day', async () => {
    const refreshAll = jest.fn().mockResolvedValue(undefined);
    const { cron, advance } = makeClockedCron(refreshAll);

    await cron.refreshRollup();
    advance(ACTIVITY_FULL_REFRESH_INTERVAL_MS - 15 * 60_000);
    await cron.refreshRollup();
    expect(refreshAll).toHaveBeenLastCalledWith(expect.objectContaining({ changedSince: expect.any(Date) }));

    advance(15 * 60_000);
    await cron.refreshRollup();
    expect(refreshAll).toHaveBeenLastCalledWith({});
  });
});
