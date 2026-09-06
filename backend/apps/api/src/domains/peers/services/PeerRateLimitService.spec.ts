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

/**
 * Captures the key each call writes, which is the only way to test the property
 * that actually broke: the store these tests use is in-memory, and a JS Map key
 * holds a NUL perfectly happily.
 */
function makeKeyCapturingService() {
  const keys: string[] = [];
  const store = {
    takeWindow: (params: { key: string }) => {
      keys.push(params.key);

      return Promise.resolve({ allowed: true, retryAfterMs: 0 });
    },
    claimOnce: () => Promise.resolve(true),
  };

  return {
    keys,
    service: new PeerRateLimitService(
      store as never,
      {
        setContext: jest.fn(),
        warn: jest.fn(),
      } as never,
    ),
  };
}

describe('PeerRateLimitService — the key has to survive a text column', () => {
  /**
   * REGRESSION (#2365 -> live two-box run). The key joined its parts with NUL,
   * which is unambiguous and free in a `Map` but cannot be stored in Postgres:
   * `PostgresConsumptionStore` writes it into `ci.consumption_windows.key`, and
   * the driver raises `invalid byte sequence for encoding "UTF8": 0x00` from
   * inside the transaction.
   *
   * `consume` runs BEFORE the peer-link lookup, so that error became a 500 on
   * EVERY inbound peer ask and every collect for any box on the default store —
   * observed against two real boxes, on a request whose token had already
   * verified against a real remote JWKS.
   */
  it('never puts a NUL in the consumption key', async () => {
    const { service, keys } = makeKeyCapturingService();

    await service.consume(PEER);
    await service.consumePoll(PEER);

    expect(keys).toHaveLength(2);
    for (const key of keys) {
      expect(key).not.toContain('\u0000');
    }
  });

  /**
   * The separator must still be unambiguous, which is why the parts are
   * percent-encoded rather than just joined with a different character: an
   * issuer that ends in the separator must not be able to impersonate a
   * different (issuer, subject) pair and spend its budget.
   */
  it('keeps (issuer, subject) unambiguous when a part contains the separator', async () => {
    const { service, keys } = makeKeyCapturingService();

    await service.consume({ issuer: 'https://a|b', subject: 'c' });
    await service.consume({ issuer: 'https://a', subject: 'b|c' });

    expect(keys[0]).not.toEqual(keys[1]);
  });
});

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
