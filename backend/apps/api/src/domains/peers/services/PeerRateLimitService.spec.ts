import { PeerRateLimitService } from './PeerRateLimitService';

function makeService() {
  return new PeerRateLimitService({ setContext: jest.fn(), warn: jest.fn() } as never);
}

const PEER = { issuer: 'https://portal.example', subject: 'peer-1' };

describe('PeerRateLimitService', () => {
  it('allows a peer up to the window limit', () => {
    const service = makeService();
    for (let i = 0; i < 10; i++) {
      expect(() => service.consume(PEER, 1_000)).not.toThrow();
    }
  });

  it('throws 429 once the peer exceeds its window', () => {
    const service = makeService();
    for (let i = 0; i < 10; i++) {
      service.consume(PEER, 1_000);
    }

    expect(() => service.consume(PEER, 1_000)).toThrow();
  });

  it('keys on (issuer, subject) so one peer cannot exhaust another peer budget', () => {
    const service = makeService();
    for (let i = 0; i < 10; i++) {
      service.consume(PEER, 1_000);
    }

    // A different subject at the same issuer is unaffected.
    expect(() => service.consume({ ...PEER, subject: 'peer-2' }, 1_000)).not.toThrow();
    // As is the same subject at a different issuer.
    expect(() => service.consume({ ...PEER, issuer: 'https://other' }, 1_000)).not.toThrow();
  });

  it('recovers once the window slides past', () => {
    const service = makeService();
    for (let i = 0; i < 10; i++) {
      service.consume(PEER, 1_000);
    }

    expect(() => service.consume(PEER, 1_000)).toThrow();
    // 61s later the earlier attempts have aged out.
    expect(() => service.consume(PEER, 62_000)).not.toThrow();
  });
});

/**
 * Collecting an answer and asking for one are different budgets, because they
 * protect different things: the ask limit exists to stop a peer filling a
 * HUMAN's review inbox, and a poll cannot fill anything — it evaluates no
 * grant, runs no executor and creates no ask.
 */
describe('PeerRateLimitService — the collect budget is separate', () => {
  it('a peer that has spent its whole ask budget can still collect its answers', () => {
    const service = makeService();
    for (let i = 0; i < 10; i++) {
      service.consume(PEER, 1_000);
    }

    expect(() => service.consume(PEER, 1_000)).toThrow();

    // Otherwise the return path is unusable for exactly the peer that used it
    // most — and an asker cannot know when to stop polling, because a pending
    // reply deliberately cannot be told from a refusal.
    expect(() => service.consumePoll(PEER, 1_000)).not.toThrow();
  });

  it('polling does not spend the ask budget either', () => {
    const service = makeService();
    for (let i = 0; i < 30; i++) {
      service.consumePoll(PEER, 1_000);
    }

    expect(() => service.consume(PEER, 1_000)).not.toThrow();
  });

  it('separate is not unlimited', () => {
    const service = makeService();
    for (let i = 0; i < 30; i++) {
      expect(() => service.consumePoll(PEER, 1_000)).not.toThrow();
    }

    expect(() => service.consumePoll(PEER, 1_000)).toThrow();
  });

  it('is still keyed on (issuer, subject)', () => {
    const service = makeService();
    for (let i = 0; i < 30; i++) {
      service.consumePoll(PEER, 1_000);
    }

    expect(() => service.consumePoll({ ...PEER, subject: 'peer-2' }, 1_000)).not.toThrow();
  });
});
