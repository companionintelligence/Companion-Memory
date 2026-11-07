/* eslint-disable @typescript-eslint/no-explicit-any */
import { SCHEDULE_CRON_OPTIONS } from '@ci/common/schedule/metadataKeys';

import { PendingActionExpiryCron, PENDING_ACTION_EXPIRY_CRON } from '../PendingActionExpiryCron';

function makeLogger() {
  return {
    setContext: jest.fn(),
    debug: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  } as any;
}

describe('PendingActionExpiryCron', () => {
  it('names its schedule, which `ci.cron_runs` dedupe depends on', () => {
    // An unnamed @Cron gets a random UUID from @nestjs/schedule's registry, so
    // it is un-addressable across restarts and cannot be deduped. Asserting the
    // decorator metadata rather than the source text means a rename that drops
    // the option fails here.
    const options = Reflect.getMetadata(
      SCHEDULE_CRON_OPTIONS,
      PendingActionExpiryCron.prototype.sweepPendingActions,
    );

    expect(options?.name).toBe('PendingActionExpiryCron.sweepPendingActions');
    expect(PENDING_ACTION_EXPIRY_CRON).toBe('0 */5 * * * *');
  });

  it('drives the sweep', async () => {
    const sweep = jest.fn(async () => ({ expired: 2, pruned: 0 }));
    const cron = new PendingActionExpiryCron({ sweep } as any, makeLogger());

    await cron.sweepPendingActions();

    expect(sweep).toHaveBeenCalledTimes(1);
  });

  it('does not stack overlapping runs', async () => {
    let release: () => void = () => undefined;
    const sweep = jest.fn(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ expired: 0, pruned: 0 });
        }),
    );
    const cron = new PendingActionExpiryCron({ sweep } as any, makeLogger());

    const first = cron.sweepPendingActions();
    await cron.sweepPendingActions();

    expect(sweep).toHaveBeenCalledTimes(1);

    release();
    await first;

    // The guard RELEASES: a `running` flag left set by a slow run would
    // silently retire the schedule forever.
    sweep.mockResolvedValue({ expired: 0, pruned: 0 } as never);
    await cron.sweepPendingActions();
    expect(sweep).toHaveBeenCalledTimes(2);
  });

  it('swallows a failing sweep so the schedule keeps running', async () => {
    const sweep = jest.fn(async () => {
      throw new Error('boom');
    });
    const cron = new PendingActionExpiryCron({ sweep } as any, makeLogger());

    // Caught and logged by the `exclusive` decorator, through the scheduler's
    // own logger (see common/schedule/decorators/Cron.ts), not this cron's.
    await expect(cron.sweepPendingActions()).resolves.toBeUndefined();

    // And the guard is released, so the next tick still runs.
    await cron.sweepPendingActions();
    expect(sweep).toHaveBeenCalledTimes(2);
  });
});
