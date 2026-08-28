import { EventEmitter2 } from '@nestjs/event-emitter';

import type { LoggerService } from '@ci/common/logging';

import type { EventSendOptions } from '../../types';
import { LocalEventService } from '../LocalEventService';

/**
 * `startAfter` used to be silently ignored by LocalEventService — every job
 * ran the instant `send`/`sendMany` was called, no matter what delay the
 * caller asked for. That let a timing-dependent bug (e.g. code that races a
 * delayed job) look correct under the dev/test in-process path while the real
 * pg-boss path — where the job genuinely is not visible until `startAfter`
 * elapses — would have reproduced it. These tests pin the delay itself, not
 * just that the job eventually runs.
 */

// Sidesteps the real EventRegistry/EventPayloads typing, same as
// EventRouting.spec.ts — the delay behaviour is independent of payload shape.
type LooseSend = (
  name: string,
  event: Record<string, unknown>,
  options?: EventSendOptions,
) => Promise<string[]>;

interface StubLogger {
  setContext: jest.Mock;
  debug: jest.Mock;
  warn: jest.Mock;
  error: jest.Mock;
  log: jest.Mock;
}

function makeLogger(): StubLogger {
  return { setContext: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn(), log: jest.fn() };
}

describe('LocalEventService startAfter delay', () => {
  const baseTime = new Date('2026-08-20T00:00:00.000Z').getTime();

  let emitter: EventEmitter2;
  let service: LocalEventService;
  let firedAt: number[];

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(baseTime);
    emitter = new EventEmitter2();
    service = new LocalEventService(emitter, makeLogger() as unknown as LoggerService);
    firedAt = [];

    // Recorded relative to baseTime so assertions read as "elapsed ms", not
    // absolute epoch timestamps.
    emitter.on('thing.created:default', (_payload: unknown, ack: { done: () => void }) => {
      firedAt.push(Date.now() - baseTime);
      ack.done();
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('send() does not dispatch before a numeric startAfter (seconds) elapses', async () => {
    const sendPromise = (service.send.bind(service) as LooseSend)(
      'thing.created',
      { id: 't1' },
      { queue: 'default', startAfter: 5 },
    );

    await jest.advanceTimersByTimeAsync(4999);
    expect(firedAt).toEqual([]);

    await jest.advanceTimersByTimeAsync(1);
    await sendPromise;

    expect(firedAt).toEqual([5000]);
  });

  it('send() delays dispatch until an absolute Date startAfter is reached', async () => {
    const startAfter = new Date(Date.now() + 3000);

    const sendPromise = (service.send.bind(service) as LooseSend)(
      'thing.created',
      { id: 't1' },
      { queue: 'default', startAfter },
    );

    await jest.advanceTimersByTimeAsync(2999);
    expect(firedAt).toEqual([]);

    await jest.advanceTimersByTimeAsync(1);
    await sendPromise;

    expect(firedAt).toEqual([3000]);
  });

  it('send() dispatches immediately when no startAfter is given', async () => {
    await (service.send.bind(service) as LooseSend)('thing.created', { id: 't1' }, { queue: 'default' });

    expect(firedAt).toEqual([0]);
  });

  it('sendMany() delays every job in the batch until startAfter elapses', async () => {
    const sendManyPromise = service.sendMany(
      'default',
      [
        { name: 'thing.created', data: { id: 't1' } },
        { name: 'thing.created', data: { id: 't2' } },
      ],
      { startAfter: 5 },
    );

    await jest.advanceTimersByTimeAsync(4999);
    expect(firedAt).toEqual([]);

    await jest.advanceTimersByTimeAsync(1);
    await sendManyPromise;

    expect(firedAt).toEqual([5000, 5000]);
  });
});
