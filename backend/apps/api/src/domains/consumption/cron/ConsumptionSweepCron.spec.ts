import { SCHEDULE_CRON_OPTIONS } from '@nestjs/schedule/dist/schedule.constants';

import { CronRegistry } from '@ci/common/schedule';

import { CONSUMPTION_SWEEP_CRON, ConsumptionSweepCron } from './ConsumptionSweepCron';

function makeCron(sweep: jest.Mock) {
  const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const cron = new ConsumptionSweepCron({ sweep } as never, logger as never);

  return { cron, logger };
}

describe('ConsumptionSweepCron registration', () => {
  it('is registered on a schedule at all — the reaper is worthless unregistered', () => {
    const options = Reflect.getMetadata(
      SCHEDULE_CRON_OPTIONS,
      ConsumptionSweepCron.prototype.sweepOnSchedule,
    );

    expect(options).toBeDefined();
    expect(options.cronTime).toBe(CONSUMPTION_SWEEP_CRON);
  });

  it('carries an EXPLICIT name', () => {
    // Every cron in this codebase is named. Unnamed, `@nestjs/schedule` assigns
    // the job a random UUID in the SchedulerRegistry, so it is un-addressable
    // across restarts and cannot be deduped; named ones dedupe on the name.
    const options = Reflect.getMetadata(
      SCHEDULE_CRON_OPTIONS,
      ConsumptionSweepCron.prototype.sweepOnSchedule,
    );

    expect(options.name).toBe('ConsumptionSweepCron.sweepOnSchedule');
  });

  it("is declared in CronRegistry as a worker job — this is the finding's own repro: before this cron existed, CronRegistry had no entry naming the consumption sweep at all", () => {
    const declaration = CronRegistry.get('ConsumptionSweepCron.sweepOnSchedule');

    expect(declaration).toBeDefined();
    expect(declaration?.cron).toBe(CONSUMPTION_SWEEP_CRON);
    expect(declaration?.role).toBe('worker');
  });
});

describe('ConsumptionSweepCron.sweepOnSchedule', () => {
  it('drives PostgresConsumptionStore.sweep', async () => {
    const sweep = jest.fn().mockResolvedValue({ windows: 3, nonces: 5 });
    const { cron } = makeCron(sweep);

    await cron.sweepOnSchedule();

    expect(sweep).toHaveBeenCalledTimes(1);
  });

  it('does not stack overlapping runs', async () => {
    // Two concurrent sweeps contend on the same rows and buy nothing: whatever
    // this run leaves behind is still idle an hour from now.
    let release: (result: { windows: number; nonces: number }) => void = () => undefined;
    const sweep = jest.fn(() => new Promise((resolve) => (release = resolve)));
    const { cron, logger } = makeCron(sweep as unknown as jest.Mock);

    const first = cron.sweepOnSchedule();
    await cron.sweepOnSchedule();

    expect(sweep).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalled();

    release({ windows: 0, nonces: 0 });
    await first;

    // The guard RELEASES, so the next tick is not locked out forever — a
    // `running` flag left set by a slow or failing run would silently retire
    // the schedule.
    sweep.mockResolvedValue({ windows: 0, nonces: 0 });
    await cron.sweepOnSchedule();
    expect(sweep).toHaveBeenCalledTimes(2);
  });

  it('survives a failing sweep and stays runnable', async () => {
    const sweep = jest
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue({ windows: 0, nonces: 0 });
    const { cron, logger } = makeCron(sweep);

    await expect(cron.sweepOnSchedule()).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalled();

    await cron.sweepOnSchedule();
    expect(sweep).toHaveBeenCalledTimes(2);
  });
});
