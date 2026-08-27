import { SCHEDULE_CRON_OPTIONS } from '@nestjs/schedule/dist/schedule.constants';

import { AgentMemoryRetentionCron, AGENT_MEMORY_RETENTION_CRON } from '../AgentMemoryRetentionCron';

const EMPTY = {
  enabled: true,
  deleted: 0,
  backlog: 0,
  stuckUsers: 0,
  stuckFragments: 0,
  alertsRaised: 0,
};

function build() {
  const retention = { sweep: jest.fn(async () => EMPTY) };
  const logger = {
    setContext: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
  };
  const cron = new AgentMemoryRetentionCron(retention as never, logger as never);

  return { cron, retention, logger };
}

describe('AgentMemoryRetentionCron schedule', () => {
  it('runs nightly at 02:20, half an hour ahead of the orphan sweep that backs it up', () => {
    const fields = AGENT_MEMORY_RETENTION_CRON.trim().split(/\s+/);

    // Six fields: five would be read as second 0, which is the pile-up.
    expect(fields).toHaveLength(6);

    const [second, minute, hour] = fields;

    expect(second).not.toBe('0');
    expect(`${hour}:${minute}`).toBe('2:20');
    // OrphanCleanupCron is '35 50 2 * * *' — 02:50:35. This must precede it so
    // an embedding whose reap event was lost is swept the same night.
    expect(Number(minute)).toBeLessThan(50);
  });

  it('takes a second no frequent schedule holds', () => {
    // See common/schedule/__tests__/cronSecondOffsets.test.ts for the registry.
    const claimed = ['10', '13', '20', '23', '25', '30', '35', '40', '45', '50'];
    const [second] = AGENT_MEMORY_RETENTION_CRON.trim().split(/\s+/);

    expect(claimed).not.toContain(second);
  });

  it('carries an explicit registry name so the durable cron_runs stamp matches', () => {
    // Without it @nestjs/schedule assigns a random UUID and the ci.cron_runs
    // key stops being addressable across restarts.
    const options = Reflect.getMetadata(
      SCHEDULE_CRON_OPTIONS,
      AgentMemoryRetentionCron.prototype.runOnSchedule,
    ) as { cronTime?: string; name?: string } | undefined;

    expect(options?.name).toBe('AgentMemoryRetentionCron.runOnSchedule');
  });

  it('registers only where the worker role is served', () => {
    const registersUnder = (served: 'web' | 'worker'): boolean => {
      let registered = false;

      jest.isolateModules(() => {
        jest.doMock('@ci/common/roles', () => ({
          processRole: () => served,
          serves: (target: string) => target === served,
        }));
        // Registration is the subject; the service pulls in the intelligence
        // and search barrels, which this test has no use for.
        jest.doMock('../../services/AgentMemoryRetentionService', () => ({
          AgentMemoryRetentionService: class {},
        }));

        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const module = require('../AgentMemoryRetentionCron') as typeof import('../AgentMemoryRetentionCron');

        registered =
          Reflect.getMetadata(
            SCHEDULE_CRON_OPTIONS,
            module.AgentMemoryRetentionCron.prototype.runOnSchedule,
          ) != null;
      });

      jest.dontMock('@ci/common/roles');
      jest.dontMock('../../services/AgentMemoryRetentionService');

      return registered;
    };

    // Running in both processes of a split deployment would double the deletes
    // and double the cards.
    expect(registersUnder('worker')).toBe(true);
    expect(registersUnder('web')).toBe(false);
  });
});

describe('AgentMemoryRetentionCron behaviour', () => {
  it('sweeps and reports what it reclaimed', async () => {
    const { cron, retention } = build();

    retention.sweep.mockResolvedValueOnce({
      enabled: true,
      deleted: 500,
      backlog: 1_200,
      stuckUsers: 1,
      stuckFragments: 42,
      alertsRaised: 1,
    });

    await expect(cron.sweepOnce()).resolves.toStrictEqual({
      enabled: true,
      deleted: 500,
      backlog: 1_200,
      stuckUsers: 1,
      stuckFragments: 42,
      alertsRaised: 1,
    });
    expect(retention.sweep).toHaveBeenCalled();
  });

  it('swallows a failing sweep — a crashed cron exits the process, a missed sweep costs a day', async () => {
    const { cron, retention, logger } = build();
    const failure = new Error('pool exhausted');

    retention.sweep.mockRejectedValueOnce(failure);

    await expect(cron.runOnSchedule()).resolves.toBeUndefined();

    // Sentence first, Error second — LoggerService.resolveArgs takes arg1 as
    // the pino msg and serialises arg2 under `err`.
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('retention sweep failed'), failure);
  });
});
