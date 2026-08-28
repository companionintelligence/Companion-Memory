import { SCHEDULE_CRON_OPTIONS } from '@nestjs/schedule/dist/schedule.constants';

import { ASK_EXPIRY_CRON, AskExpiryCron } from './AskExpiryCron';

function makeCron(sweep: jest.Mock) {
  const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const cron = new AskExpiryCron({ sweep } as never, logger as never);

  return { cron, logger };
}

describe('AskExpiryCron registration', () => {
  it('is registered on a schedule at all — the sweep is worthless unregistered', () => {
    const options = Reflect.getMetadata(SCHEDULE_CRON_OPTIONS, AskExpiryCron.prototype.expireOverdueAsks);

    expect(options).toBeDefined();
    expect(options.cronTime).toBe(ASK_EXPIRY_CRON);
  });

  it('carries an EXPLICIT name', () => {
    // Every cron in this codebase is named. Unnamed, `@nestjs/schedule` assigns
    // the job a random UUID in the SchedulerRegistry, so it is un-addressable
    // across restarts and cannot be deduped; named ones dedupe on the name.
    const options = Reflect.getMetadata(SCHEDULE_CRON_OPTIONS, AskExpiryCron.prototype.expireOverdueAsks);

    expect(options.name).toBe('AskExpiryCron.expireOverdueAsks');
  });
});

describe('AskExpiryCron.expireOverdueAsks', () => {
  it('runs the sweep', async () => {
    const sweep = jest.fn().mockResolvedValue(3);
    const { cron } = makeCron(sweep);

    await cron.expireOverdueAsks();

    expect(sweep).toHaveBeenCalledTimes(1);
  });

  it('does not stack overlapping runs', async () => {
    // Two concurrent sweeps contend on the same rows through the pessimistic
    // lock and buy nothing: whatever this run leaves behind is still overdue on
    // the next tick.
    let release: (count: number) => void = () => undefined;
    const sweep = jest.fn(() => new Promise<number>((resolve) => (release = resolve)));
    const { cron, logger } = makeCron(sweep as unknown as jest.Mock);

    const first = cron.expireOverdueAsks();
    await cron.expireOverdueAsks();

    expect(sweep).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalled();

    release(0);
    await first;

    // The guard RELEASES, so the next tick is not locked out forever — a
    // `running` flag left set by a slow or failing run would silently retire
    // the schedule.
    sweep.mockResolvedValue(0);
    await cron.expireOverdueAsks();
    expect(sweep).toHaveBeenCalledTimes(2);
  });

  it('survives a failing sweep and stays runnable', async () => {
    const sweep = jest.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue(0);
    const { cron, logger } = makeCron(sweep);

    await expect(cron.expireOverdueAsks()).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalled();

    await cron.expireOverdueAsks();
    expect(sweep).toHaveBeenCalledTimes(2);
  });
});
