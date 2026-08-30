import { InMemoryConsumptionStore } from '@ci/domains/consumption';

import { PeerRateLimitService } from './PeerRateLimitService';

/**
 * `consume` / `consumePoll` are ASYNC now the window is durable (#2365). Every
 * call awaits: an unawaited rejected 429 is an unhandled rejection that crashes
 * the jest worker rather than failing a test.
 */

function makeService() {
  return new PeerRateLimitService(new InMemoryConsumptionStore(), {
    setContext: jest.fn(),
    warn: jest.fn(),
  } as never);
}

const PEER = { issuer: 'https://portal.example', subject: 'peer-1' };

describe('PeerRateLimitService', () => {
  it('allows a peer up to the window limit', async () => {
    const service = makeService();
    for (let i = 0; i < 10; i++) {
      await expect(service.consume(PEER, 1_000)).resolves.toBeUndefined();
    }
  });

  it('throws 429 once the peer exceeds its window', async () => {
    const service = makeService();
    for (let i = 0; i < 10; i++) {
      await service.consume(PEER, 1_000);
    }

    await expect(service.consume(PEER, 1_000)).rejects.toBeDefined();
  });

  it('keys on (issuer, subject) so one peer cannot exhaust another peer budget', async () => {
    const service = makeService();
    for (let i = 0; i < 10; i++) {
      await service.consume(PEER, 1_000);
    }

    // A different subject at the same issuer is unaffected.
    await expect(service.consume({ ...PEER, subject: 'peer-2' }, 1_000)).resolves.toBeUndefined();
    // As is the same subject at a different issuer.
    await expect(service.consume({ ...PEER, issuer: 'https://other' }, 1_000)).resolves.toBeUndefined();
  });

  it('recovers once the window slides past', async () => {
    const service = makeService();
    for (let i = 0; i < 10; i++) {
      await service.consume(PEER, 1_000);
    }

    await expect(service.consume(PEER, 1_000)).rejects.toBeDefined();
    // 61s later the earlier attempts have aged out.
    await expect(service.consume(PEER, 62_000)).resolves.toBeUndefined();
  });
});

/**
 * Collecting an answer and asking for one are different budgets, because they
 * protect different things: the ask limit exists to stop a peer filling a
 * HUMAN's review inbox, and a poll cannot fill anything — it evaluates no
 * grant, runs no executor and creates no ask.
 */
describe('PeerRateLimitService — the collect budget is separate', () => {
  it('a peer that has spent its whole ask budget can still collect its answers', async () => {
    const service = makeService();
    for (let i = 0; i < 10; i++) {
      await service.consume(PEER, 1_000);
    }

    await expect(service.consume(PEER, 1_000)).rejects.toBeDefined();

    // Otherwise the return path is unusable for exactly the peer that used it
    // most — and an asker cannot know when to stop polling, because a pending
    // reply deliberately cannot be told from a refusal.
    await expect(service.consumePoll(PEER, 1_000)).resolves.toBeUndefined();
  });

  it('polling does not spend the ask budget either', async () => {
    const service = makeService();
    for (let i = 0; i < 30; i++) {
      await service.consumePoll(PEER, 1_000);
    }

    await expect(service.consume(PEER, 1_000)).resolves.toBeUndefined();
  });

  it('separate is not unlimited', async () => {
    const service = makeService();
    for (let i = 0; i < 30; i++) {
      await expect(service.consumePoll(PEER, 1_000)).resolves.toBeUndefined();
    }

    await expect(service.consumePoll(PEER, 1_000)).rejects.toBeDefined();
  });

  it('is still keyed on (issuer, subject)', async () => {
    const service = makeService();
    for (let i = 0; i < 30; i++) {
      await service.consumePoll(PEER, 1_000);
    }

    await expect(service.consumePoll({ ...PEER, subject: 'peer-2' }, 1_000)).resolves.toBeUndefined();
  });
});
