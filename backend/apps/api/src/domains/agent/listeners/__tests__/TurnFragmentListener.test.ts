import type { LoggerService } from '@ci/common/logging';

import type { TurnFragmentService, TurnFragmentWindow } from '../../services/TurnFragmentService';
import { TurnFragmentListener } from '../TurnFragmentListener';

const logger = {
  setContext: () => undefined,
  log: () => undefined,
  debug: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as unknown as LoggerService;

function makeListener(behaviour: { throws?: Error } = {}) {
  const calls: Array<{ userId: string; window: TurnFragmentWindow }> = [];

  const service = {
    distillForUser: async (userId: string, window: TurnFragmentWindow) => {
      calls.push({ userId, window });

      if (behaviour.throws) {
        throw behaviour.throws;
      }

      return { turns: 1, written: 1, skipped: 0 };
    },
  } as unknown as TurnFragmentService;

  return { calls, listener: new TurnFragmentListener(service, logger) };
}

describe('TurnFragmentListener', () => {
  it('distils the window the job was enqueued for, not the current one', async () => {
    const { listener, calls } = makeListener();

    await listener.handleTurnFragments({
      userId: 'user-a',
      since: '2026-08-26T10:00:00.000Z',
      until: '2026-08-26T11:00:00.000Z',
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].userId).toBe('user-a');
    expect(calls[0].window.since.toISOString()).toBe('2026-08-26T10:00:00.000Z');
    expect(calls[0].window.until.toISOString()).toBe('2026-08-26T11:00:00.000Z');
  });

  it('discards a job whose window will not parse instead of scanning all of time', async () => {
    const { listener, calls } = makeListener();

    await listener.handleTurnFragments({ userId: 'user-a', since: 'not-a-date', until: 'nor-this' });

    expect(calls).toHaveLength(0);
  });

  /**
   * Failure has to reach pg-boss: the queue's retryLimit is the only thing
   * that gets a user's window distilled after a transient database error, and
   * a swallowed throw would mark the job complete having written nothing.
   */
  it('lets a failure propagate so the queue retries that user alone', async () => {
    const { listener } = makeListener({ throws: new Error('connection terminated') });

    await expect(
      listener.handleTurnFragments({
        userId: 'user-a',
        since: '2026-08-26T10:00:00.000Z',
        until: '2026-08-26T11:00:00.000Z',
      }),
    ).rejects.toThrow('connection terminated');
  });
});
