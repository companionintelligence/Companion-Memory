import { DailyMetricsComputeListener } from './DailyMetricsComputeListener';

const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };

function makeListener() {
  const dailyMetricsService = { computeWindow: jest.fn(async () => []) };

  const listener = new DailyMetricsComputeListener(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    dailyMetricsService as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    logger as any,
  );

  return { listener, dailyMetricsService };
}

describe('DailyMetricsComputeListener', () => {
  it('computes the requested (user, window) via DailyMetricsService', async () => {
    const { listener, dailyMetricsService } = makeListener();

    await listener.computeWindow({
      userId: 'user-1',
      endDate: '2026-07-06',
      days: 30,
      timezone: 'America/New_York',
    });

    expect(dailyMetricsService.computeWindow).toHaveBeenCalledWith(
      { userId: 'user-1' },
      '2026-07-06',
      30,
      'America/New_York',
    );
  });

  it('defaults the timezone to UTC when the payload omits it', async () => {
    const { listener, dailyMetricsService } = makeListener();

    await listener.computeWindow({ userId: 'user-1', endDate: '2026-07-06', days: 2 });

    expect(dailyMetricsService.computeWindow).toHaveBeenCalledWith(
      { userId: 'user-1' },
      '2026-07-06',
      2,
      'UTC',
    );
  });
});
