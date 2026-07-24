import type { LoggerService } from '@ci/common/logging';

import type { ActivityRollupService } from '../../services/ActivityRollupService';
import { ActivityRollupCron } from '../ActivityRollupCron';

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
    const { cron, refreshAll, logger, finishRefresh } = makeCron();

    const first = cron.refreshRollup();
    await cron.refreshRollup();

    expect(refreshAll).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalled();

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

    await cron.refreshRollup();

    expect(logger.error).toHaveBeenCalled();

    await cron.refreshRollup();

    expect(refreshAll).toHaveBeenCalledTimes(2);
  });
});
