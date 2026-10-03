import { SCHEDULE_CRON_OPTIONS } from '@nestjs/schedule/dist/schedule.constants';

import type { LoggerService } from '@ci/common/logging';
import { BACKFILL_JOB_PRIORITY, EventListenerRegistry } from '@ci/domains/events';

import { probeQueuePolicyGuard } from '../../../__tests__/support/queuePolicyGuardProbe';
import { DERIVATION_RUN_QUEUE, DerivationRunRequestEvent } from '../../events';
// Side-effect import: `@OnEvent` registers the queue's options when the class
// is DECLARED, so importing the real listener is what puts `derivation-run` in
// the registry the queue is later created from.
import '../../listeners/DerivationRunListener';
import { DERIVATION_CRON, DerivationCron } from '../DerivationCron';

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE FAN-OUT, AND THE THREE PROPERTIES THAT KEEP IT FROM BEING A LIABILITY.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  1. **One job per user, keyed per day.** A pass that outruns its own cadence
 *     must not stack a second copy, and one user's send failing must not cost
 *     the other users their night.
 *  2. **The key is ENFORCED.** pg-boss 10 makes de-duplication a QUEUE
 *     property: under the default `standard` policy a singletonKey is stored
 *     and never checked. `policy: 'short'` on the listener's queue is what
 *     turns the key into a guarantee, and the probe drives the real
 *     `PGBossEventService` to prove the enqueue side defends it.
 *  3. **It does not fire on second 0.** Twelve schedules already do, into one
 *     event loop and one 25-connection pool.
 */

const noopLogger = {
  setContext: () => undefined,
  log: () => undefined,
  warn: () => undefined,
  debug: () => undefined,
  error: () => undefined,
} as unknown as LoggerService;

/** One recorded `EventService.send` call: (event, payload, options). */
type SendCall = [string, Record<string, unknown>, { queue: string; singletonKey: string; priority: number }];

function makeCron(userIds: string[], send = jest.fn(async () => ['job-1'])) {
  const dataSource = { query: jest.fn(async () => userIds.map((id) => ({ id }))) };
  const cron = new DerivationCron(dataSource as never, { send } as never, noopLogger);

  // `jest.fn`'s inferred zero-arity signature types `mock.calls` as `[]`; the
  // service is called with three arguments, so read them through the shape the
  // production call site actually passes.
  const calls = send.mock.calls as unknown as SendCall[];

  return { cron, send, calls, dataSource };
}

describe('DerivationCron fan-out', () => {
  it('enqueues one job per onboarded user, keyed by user and UTC day', async () => {
    const { cron, send, calls } = makeCron(['user-a', 'user-b']);

    const enqueued = await cron.fanOut(new Date('2026-08-21T04:40:25.000Z'));

    expect(enqueued).toBe(2);
    expect(send).toHaveBeenCalledTimes(2);
    expect(calls[0]).toEqual([
      DerivationRunRequestEvent,
      { userId: 'user-a', dayKey: '2026-08-21', requestedBy: 'DerivationCron' },
      {
        queue: DERIVATION_RUN_QUEUE,
        singletonKey: 'derive:user-a:2026-08-21',
        priority: BACKFILL_JOB_PRIORITY,
      },
    ]);
    expect(calls[1][2].singletonKey).toBe('derive:user-b:2026-08-21');
  });

  it('keeps going when one user’s send throws', async () => {
    const send = jest
      .fn(async () => ['job-1'])
      .mockRejectedValueOnce(new Error('pg-boss unavailable')) as jest.Mock;
    const { cron } = makeCron(['user-a', 'user-b'], send as never);

    await expect(cron.fanOut(new Date('2026-08-21T04:40:25.000Z'))).resolves.toBe(1);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('sends nothing when no user is onboarded', async () => {
    const { cron, send } = makeCron([]);

    await expect(cron.fanOut()).resolves.toBe(0);
    expect(send).not.toHaveBeenCalled();
  });
});

describe('derivation-run queue', () => {
  it('is a worker queue that serialises and enforces the singleton key', () => {
    expect(EventListenerRegistry.getQueueOptions(DERIVATION_RUN_QUEUE)).toEqual({
      policy: 'short',
      role: 'worker',
      localConcurrency: 1,
    });
  });

  it('makes a keyless send an error and a keyed send clean', async () => {
    const probe = await probeQueuePolicyGuard(DERIVATION_RUN_QUEUE);

    expect(probe.keyless).toHaveLength(1);
    expect(probe.keyless[0]).toContain('no singletonKey');
    expect(probe.keyed).toEqual([]);
  });
});

describe('DerivationCron schedule', () => {
  it('fires off second 0, at 04:40 UTC nightly', () => {
    const options = Reflect.getMetadata(SCHEDULE_CRON_OPTIONS, DerivationCron.prototype.deriveNightly) as
      { cronTime?: string } | undefined;

    // Registered metadata, not the source constant: a rewrite to
    // `CronExpression.EVERY_DAY_AT_...` (five fields, second 0) fails here.
    expect(options?.cronTime).toBe(DERIVATION_CRON);

    const fields = String(options?.cronTime).trim().split(/\s+/);

    expect(fields).toHaveLength(6);
    expect(fields[0]).not.toBe('0');
    expect(fields.slice(1).join(' ')).toBe('40 4 * * *');
  });
});
