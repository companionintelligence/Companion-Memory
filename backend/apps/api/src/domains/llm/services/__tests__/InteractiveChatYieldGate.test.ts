import { YieldGateRegistry } from '@ci/domains/events';

import { INTERACTIVE_CHAT_YIELD_GATE } from '../../constants';
import {
  InteractiveChatYieldGate,
  PENDING_GENERATION_FRESHNESS_MS,
  YIELD_GATE_CACHE_MS,
} from '../InteractiveChatYieldGate';

/**
 * The gate the image-description queue (and the HBPE labeler, via the same
 * column) stands aside for. What matters is that it answers from the app's
 * own "someone is waiting on the model" signal, fails OPEN, and does not turn
 * one wake-up per worker loop into one query per worker loop.
 */
function makeGate(count: jest.Mock) {
  const threadService = { countPendingGenerations: count };
  const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const gate = new InteractiveChatYieldGate(threadService as never, logger as never);

  return { gate, threadService, logger };
}

describe('InteractiveChatYieldGate', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    YieldGateRegistry.clear();
  });

  afterEach(() => {
    jest.useRealTimers();
    YieldGateRegistry.clear();
  });

  it('registers itself under the name the queues declare as soon as it is constructed', async () => {
    expect(YieldGateRegistry.has(INTERACTIVE_CHAT_YIELD_GATE)).toBe(false);

    // Construction, not an init hook: the worker loops start from another
    // module's onModuleInit, and on a real boot they checked before an
    // init-hook registration had happened.
    makeGate(jest.fn(async () => 1));

    expect(YieldGateRegistry.has(INTERACTIVE_CHAT_YIELD_GATE)).toBe(true);
    await expect(YieldGateRegistry.shouldYield(INTERACTIVE_CHAT_YIELD_GATE)).resolves.toBe(true);
  });

  it('yields while any thread has a turn queued or running, bounded by the llm queue expiry', async () => {
    const count = jest.fn(async () => 1);
    const { gate } = makeGate(count);

    await expect(gate.isChatPending()).resolves.toBe(true);
    expect(count).toHaveBeenCalledWith(PENDING_GENERATION_FRESHNESS_MS);
  });

  it('opens when no turn is pending', async () => {
    const { gate } = makeGate(jest.fn(async () => 0));

    await expect(gate.isChatPending()).resolves.toBe(false);
  });

  it('fails open when the lookup throws, and says so once per tick', async () => {
    const { gate, logger } = makeGate(
      jest.fn(async () => {
        throw new Error('connection reset');
      }),
    );

    await expect(gate.isChatPending()).resolves.toBe(false);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('serves concurrent and back-to-back callers from one query per cache window', async () => {
    const count = jest.fn(async () => 1);
    const { gate } = makeGate(count);

    // Several worker loops waking in the same tick.
    await Promise.all([gate.isChatPending(), gate.isChatPending(), gate.isChatPending()]);
    // And a loop re-asking a moment later.
    await gate.isChatPending();

    expect(count).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(YIELD_GATE_CACHE_MS + 1);
    count.mockResolvedValueOnce(0);

    await expect(gate.isChatPending()).resolves.toBe(false);
    expect(count).toHaveBeenCalledTimes(2);
  });
});
