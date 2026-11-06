import { IdentiKeyError } from '../errors';

import { decodeChallenge, encodeChallenge, PROTOCOL_VERSION, type Challenge } from './challenge';
import { ChallengeIssuer, InMemoryNonceStore } from './nonceStore';

const NOW = 1_000_000;

const challengeWith = (
  nonceByte: number,
  expiresAt = NOW + 120,
): { challenge: Challenge; bytes: Uint8Array } => {
  const challenge: Challenge = {
    version: PROTOCOL_VERSION,
    audience: 'papyrus',
    nonce: new Uint8Array(16).fill(nonceByte),
    issuedAt: NOW,
    expiresAt,
  };

  return { challenge, bytes: encodeChallenge(challenge) };
};

async function codeOfAsync(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (error) {
    return error instanceof IdentiKeyError ? error.code : `other: ${(error as Error).message}`;
  }

  return 'no error';
}

describe('InMemoryNonceStore', () => {
  it('lets an issued challenge be spent exactly once', async () => {
    const store = new InMemoryNonceStore();
    const { challenge, bytes } = challengeWith(1);
    await store.recordIssued(challenge.nonce, bytes, challenge.expiresAt, NOW);

    expect(await store.consume(challenge.nonce, bytes)).toBe('consumed');
    expect(await store.consume(challenge.nonce, bytes)).toBe('used');
    expect(await store.consume(challenge.nonce, bytes)).toBe('used');
  });

  it('knows nothing of a nonce it never issued', async () => {
    const store = new InMemoryNonceStore();
    const { challenge, bytes } = challengeWith(1);

    expect(await store.consume(challenge.nonce, bytes)).toBe('unknown');
  });

  it('refuses the right nonce with different challenge bytes, and leaves it spendable', async () => {
    const store = new InMemoryNonceStore();
    const issued = challengeWith(1);
    const forged = challengeWith(1, NOW + 100_000);
    await store.recordIssued(issued.challenge.nonce, issued.bytes, issued.challenge.expiresAt, NOW);

    expect(await store.consume(forged.challenge.nonce, forged.bytes)).toBe('mismatch');
    expect(await store.consume(issued.challenge.nonce, issued.bytes)).toBe('consumed');
  });

  it('lets exactly one of two simultaneous answers win', async () => {
    const store = new InMemoryNonceStore();
    const { challenge, bytes } = challengeWith(1);
    await store.recordIssued(challenge.nonce, bytes, challenge.expiresAt, NOW);

    const outcomes = await Promise.all(
      Array.from({ length: 20 }, () => store.consume(challenge.nonce, bytes)),
    );

    expect(outcomes.filter((outcome) => outcome === 'consumed')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === 'used')).toHaveLength(19);
  });

  it('copies the challenge bytes it is given, so a caller cannot rewrite what was issued', async () => {
    const store = new InMemoryNonceStore();
    const { challenge, bytes } = challengeWith(1);
    await store.recordIssued(challenge.nonce, bytes, challenge.expiresAt, NOW);
    bytes[bytes.length - 1] ^= 0xff;

    expect(await store.consume(challenge.nonce, bytes)).toBe('mismatch');
  });

  it('refuses to record the same nonce twice, because overwriting a spent entry would revive it', async () => {
    const store = new InMemoryNonceStore();
    const { challenge, bytes } = challengeWith(1);
    await store.recordIssued(challenge.nonce, bytes, challenge.expiresAt, NOW);
    await store.consume(challenge.nonce, bytes);

    expect(
      await codeOfAsync(() => store.recordIssued(challenge.nonce, bytes, challenge.expiresAt, NOW)),
    ).toMatch(/^other: .*issued twice/);
    expect(await store.consume(challenge.nonce, bytes)).toBe('used');
  });

  describe('forgetting', () => {
    it('drops entries only after they expire AND the retention window has passed', async () => {
      const store = new InMemoryNonceStore({ retainSeconds: 60 });
      const { challenge, bytes } = challengeWith(1, NOW + 120);
      await store.recordIssued(challenge.nonce, bytes, challenge.expiresAt, NOW);

      expect(await store.gc(NOW + 120 + 60)).toBe(0);
      expect(store.size).toBe(1);
      expect(await store.gc(NOW + 120 + 61)).toBe(1);
      expect(store.size).toBe(0);
    });

    it('makes a forgotten challenge unknown, which is a refusal, never an acceptance', async () => {
      const store = new InMemoryNonceStore({ retainSeconds: 0 });
      const { challenge, bytes } = challengeWith(1, NOW + 10);
      await store.recordIssued(challenge.nonce, bytes, challenge.expiresAt, NOW);
      await store.gc(NOW + 11);

      expect(await store.consume(challenge.nonce, bytes)).toBe('unknown');
    });

    it('keeps a spent entry until it can no longer be answered, so a late replay reads "used"', async () => {
      const store = new InMemoryNonceStore({ retainSeconds: 60 });
      const { challenge, bytes } = challengeWith(1, NOW + 10);
      await store.recordIssued(challenge.nonce, bytes, challenge.expiresAt, NOW);
      await store.consume(challenge.nonce, bytes);
      await store.gc(NOW + 30);

      expect(await store.consume(challenge.nonce, bytes)).toBe('used');
    });
  });

  describe('capacity', () => {
    it('stops issuing when it is full of unexpired challenges (issuing is unauthenticated)', async () => {
      const store = new InMemoryNonceStore({ maxEntries: 3 });
      for (const n of [1, 2, 3]) {
        const { challenge, bytes } = challengeWith(n);
        await store.recordIssued(challenge.nonce, bytes, challenge.expiresAt, NOW);
      }

      const fourth = challengeWith(4);
      expect(
        await codeOfAsync(() =>
          store.recordIssued(fourth.challenge.nonce, fourth.bytes, fourth.challenge.expiresAt, NOW),
        ),
      ).toBe('store-full');
      expect(store.size).toBe(3);
    });

    it('makes room by forgetting what has expired before it refuses anyone', async () => {
      const store = new InMemoryNonceStore({ maxEntries: 2, retainSeconds: 0 });
      for (const n of [1, 2]) {
        const { challenge, bytes } = challengeWith(n, NOW + 10);
        await store.recordIssued(challenge.nonce, bytes, challenge.expiresAt, NOW);
      }

      const later = challengeWith(3, NOW + 1000);
      await store.recordIssued(later.challenge.nonce, later.bytes, later.challenge.expiresAt, NOW + 500);

      expect(store.size).toBe(1);
    });
  });
});

describe('ChallengeIssuer', () => {
  it('issues a version-1 challenge for its audience, valid for the ttl, with a 16-byte nonce', async () => {
    const store = new InMemoryNonceStore();
    const { challenge, bytes } = await new ChallengeIssuer({ audience: 'papyrus', ttlSeconds: 120 }).issue(
      store,
      NOW,
    );

    expect(challenge).toMatchObject({
      version: 1,
      audience: 'papyrus',
      issuedAt: NOW,
      expiresAt: NOW + 120,
    });
    expect(challenge.nonce).toHaveLength(16);
    expect(decodeChallenge(bytes)).toEqual(challenge);
  });

  it('records what it issues, so that the same bytes can be spent once', async () => {
    const store = new InMemoryNonceStore();
    const { challenge, bytes } = await new ChallengeIssuer({ audience: 'a', ttlSeconds: 10 }).issue(
      store,
      NOW,
    );

    expect(store.size).toBe(1);
    expect(await store.consume(challenge.nonce, bytes)).toBe('consumed');
  });

  it('never issues the same nonce twice (a sample of 2000)', async () => {
    const store = new InMemoryNonceStore({ maxEntries: 5000 });
    const issuer = new ChallengeIssuer({ audience: 'a', ttlSeconds: 10 });
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i += 1) {
      seen.add(Buffer.from((await issuer.issue(store, NOW)).challenge.nonce).toString('hex'));
    }

    expect(seen.size).toBe(2000);
  });

  it('surfaces a broken random source instead of overwriting a spent entry', async () => {
    const store = new InMemoryNonceStore();
    const stuck = new ChallengeIssuer({
      audience: 'a',
      ttlSeconds: 10,
      randomBytes: (length) => new Uint8Array(length),
    });
    await stuck.issue(store, NOW);

    expect(await codeOfAsync(() => stuck.issue(store, NOW))).toMatch(/^other: .*random source is broken/);
  });

  it('propagates a full store as store-full', async () => {
    const store = new InMemoryNonceStore({ maxEntries: 1 });
    const issuer = new ChallengeIssuer({ audience: 'a', ttlSeconds: 10 });
    await issuer.issue(store, NOW);

    expect(await codeOfAsync(() => issuer.issue(store, NOW))).toBe('store-full');
  });

  it.each([
    ['an empty audience', { audience: '', ttlSeconds: 10 }],
    ['a zero ttl', { audience: 'a', ttlSeconds: 0 }],
    ['a negative ttl', { audience: 'a', ttlSeconds: -5 }],
    ['a fractional ttl', { audience: 'a', ttlSeconds: 1.5 }],
    ['a ttl over an hour', { audience: 'a', ttlSeconds: 3601 }],
  ])('refuses to be built with %s', (_label, options) => {
    expect(() => new ChallengeIssuer(options)).toThrow(RangeError);
  });
});
