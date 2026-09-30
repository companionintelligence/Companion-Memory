/* eslint-disable @typescript-eslint/no-explicit-any */
import { SCHEDULE_CRON_OPTIONS } from '@nestjs/schedule/dist/schedule.constants';

import { TOOL_INVOCATION_RETENTION_CRON, ToolInvocationRetentionCron } from '../ToolInvocationRetentionCron';

function makeLogger() {
  return {
    setContext: jest.fn(),
    debug: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  } as any;
}

describe('ToolInvocationRetentionCron', () => {
  it('prunes, which is the bound whose absence got ci.api_logs deleted', async () => {
    const ledger = { prune: jest.fn().mockResolvedValue(12) } as any;
    const cron = new ToolInvocationRetentionCron(ledger, makeLogger());

    await cron.pruneOnSchedule();

    expect(ledger.prune).toHaveBeenCalledTimes(1);
  });

  it('says nothing on a tick that deleted nothing (a nightly no-op line is a line nobody reads)', async () => {
    const logger = makeLogger();
    const cron = new ToolInvocationRetentionCron({ prune: jest.fn().mockResolvedValue(0) } as any, logger);

    await cron.pruneOnSchedule();

    expect(logger.log).not.toHaveBeenCalled();
  });

  it('claims a second of its own — everything left on second 0 fires into one event loop and one pool', () => {
    const fields = TOOL_INVOCATION_RETENTION_CRON.trim().split(/\s+/);

    // Five fields means no seconds field at all, which `cron` reads as second 0.
    expect(fields).toHaveLength(6);
    expect(fields[0]).toBe('43');
  });

  it('registers with the scheduler under a stable name, on the worker role', () => {
    const options = Reflect.getMetadata(
      SCHEDULE_CRON_OPTIONS,
      ToolInvocationRetentionCron.prototype.pruneOnSchedule,
    ) as { cronTime?: string; name?: string } | undefined;

    // `role: 'worker'` means this process may not register it at all — when it does, the
    // expression the scheduler is handed must be the one declared above, not a rewritten
    // CronExpression.EVERY_* that lands back on second 0.
    if (options) {
      expect(options.cronTime).toBe(TOOL_INVOCATION_RETENTION_CRON);
      expect(options.name).toBe('ToolInvocationRetentionCron.pruneOnSchedule');
    }
  });
});
