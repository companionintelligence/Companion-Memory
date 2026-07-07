import { DAILY_METRICS_QUEUE, DailyMetricsComputeRequestEvent } from '../events';

import { DailyMetricsCron } from './DailyMetricsCron';

const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };

function makeCron({
  users = [{ id: 'user-1' }, { id: 'user-2' }],
  featureEnabled = true,
}: { users?: Array<{ id: string }>; featureEnabled?: boolean } = {}) {
  const eventService = {
    send: jest.fn<Promise<string[]>, [string, Record<string, unknown>, { queue: string }]>(async () => [
      'job-1',
    ]),
  };
  const userService = { findAll: jest.fn(async () => users) };
  const featureService = { isFeatureEnabled: jest.fn(async () => featureEnabled) };

  const cron = new DailyMetricsCron(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    eventService as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    userService as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    featureService as any,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    logger as any,
  );

  return { cron, eventService, userService, featureService };
}

describe('DailyMetricsCron', () => {
  it('nightly enqueues a 2-day window per user on the daily-metrics queue', async () => {
    const { cron, eventService } = makeCron();

    await cron.nightly();

    expect(eventService.send).toHaveBeenCalledTimes(2);

    const [name, payload, options] = eventService.send.mock.calls[0];

    expect(name).toBe(DailyMetricsComputeRequestEvent);
    expect(payload).toEqual({
      userId: 'user-1',
      endDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
      days: 2,
    });
    expect(options).toEqual({ queue: DAILY_METRICS_QUEUE });
  });

  it('rolling enqueues a 1-day window per user', async () => {
    const { cron, eventService } = makeCron();

    await cron.rolling();

    expect(eventService.send).toHaveBeenCalledTimes(2);
    expect(eventService.send.mock.calls[1][1]).toMatchObject({ userId: 'user-2', days: 1 });
  });

  it('does nothing when the feature flag is off', async () => {
    const { cron, eventService, userService } = makeCron({ featureEnabled: false });

    await cron.nightly();
    await cron.rolling();

    expect(userService.findAll).not.toHaveBeenCalled();
    expect(eventService.send).not.toHaveBeenCalled();
  });

  it('a failed enqueue for one user does not block the others', async () => {
    const { cron, eventService } = makeCron();

    eventService.send.mockRejectedValueOnce(new Error('pgboss down'));

    await cron.nightly();

    expect(eventService.send).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalled();
  });
});
