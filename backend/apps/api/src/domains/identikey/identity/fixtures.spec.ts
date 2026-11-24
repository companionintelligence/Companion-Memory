import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { fixture, hex, must, toHex, VECTOR } from '../__tests__/support';

import { decodeResponse, encodeChallenge, encodeResponse, type Challenge } from './challenge';
import { pqPublicKey, pqSignature } from './keys';
import { InMemoryNonceStore, type NonceStore } from './nonceStore';
import { SoftwareSigner, respond } from './softwareSigner';
import { verifyResponse, type VerifyOptions } from './verify';

/**
 * The Rust crate's `tests/vectors.rs`, replayed against the TypeScript verifier, over the very bytes
 * that crate committed (`__tests__/fixtures/auth-v1`, provenance in its README).
 *
 * "Verify against committed bytes, not merely round-trip" is the point: these are what stop the two
 * implementations from drifting apart on the wire.
 */

const CHALLENGE: Challenge = {
  version: 1,
  audience: VECTOR.audience,
  nonce: new Uint8Array(16).fill(0x42),
  issuedAt: VECTOR.now,
  expiresAt: VECTOR.now + VECTOR.ttlSeconds,
};

/** A store that has issued the fixture challenge, as `store_with` does in vectors.rs. */
async function storeWithFixtureChallenge(): Promise<InMemoryNonceStore> {
  const store = new InMemoryNonceStore();
  await store.recordIssued(CHALLENGE.nonce, encodeChallenge(CHALLENGE), CHALLENGE.expiresAt, VECTOR.now);

  return store;
}

const options = (nonces: NonceStore, extra: Partial<VerifyOptions> = {}): VerifyOptions => ({
  audience: VECTOR.audience,
  now: VECTOR.now,
  skewSeconds: VECTOR.skewSeconds,
  policy: 'pq-optional',
  nonces,
  ...extra,
});

describe('the Rust identikey-auth fixtures', () => {
  it('ed25519_fixture_verifies, and a replay is refused', async () => {
    const response = fixture('auth-v1/response-ed25519.bin');
    const store = await storeWithFixtureChallenge();

    const result = await verifyResponse(response, options(store));

    expect(result.ok).toBe(true);
    expect(await verifyResponse(response, options(store))).toEqual({ ok: false, code: 'replay' });
  });

  it('p256_fixture_verifies: a signature made by the Rust crate (RFC 6979) passes OpenSSL’s ECDSA', async () => {
    const store = await storeWithFixtureChallenge();
    const result = await verifyResponse(fixture('auth-v1/response-p256.bin'), options(store));

    expect(result.ok).toBe(true);
  });

  it('names the same identity the Rust key derivation does', async () => {
    const store = await storeWithFixtureChallenge();
    const result = await verifyResponse(fixture('auth-v1/response-ed25519.bin'), options(store));

    expect(toHex(must(result.ok ? result.verified.publicKey.bytes : null))).toBe(
      toHex(SoftwareSigner.fromEd25519Seed(VECTOR.ed25519Seed).classicalPublicKey().bytes),
    );
  });

  it('fixture_audience_mismatch', async () => {
    const store = await storeWithFixtureChallenge();

    expect(
      await verifyResponse(
        fixture('auth-v1/response-ed25519.bin'),
        options(store, { audience: 'other-aud' }),
      ),
    ).toEqual({ ok: false, code: 'audience' });
  });

  it('fixture_expiry', async () => {
    const store = await storeWithFixtureChallenge();

    expect(
      await verifyResponse(
        fixture('auth-v1/response-ed25519.bin'),
        options(store, { now: VECTOR.now + 10_000 }),
      ),
    ).toEqual({ ok: false, code: 'time-window' });
  });

  it('fixture_pq_required_rejects_classical', async () => {
    const store = await storeWithFixtureChallenge();

    expect(
      await verifyResponse(
        fixture('auth-v1/response-ed25519.bin'),
        options(store, { policy: 'pq-required' }),
      ),
    ).toEqual({ ok: false, code: 'pq-required' });
  });

  it('refuses the fixture against a store that did not issue it', async () => {
    expect(
      await verifyResponse(fixture('auth-v1/response-ed25519.bin'), options(new InMemoryNonceStore())),
    ).toEqual({ ok: false, code: 'unknown-challenge' });
  });

  it('live_ed25519_p256_hybrid_policies: both classical signers, then a hybrid, then the downgrade', async () => {
    const ed = SoftwareSigner.fromEd25519Seed(VECTOR.ed25519Seed);
    const p256 = SoftwareSigner.fromP256Secret(VECTOR.p256Secret);
    const hybrid = SoftwareSigner.fromEd25519Seed(VECTOR.ed25519Seed).withMlDsa('ml-dsa-65');
    const challengeBytes = fixture('auth-v1/challenge.bin');
    const answer = (signer: SoftwareSigner) => respond(signer, challengeBytes, { audience: VECTOR.audience });

    for (const signer of [ed, p256]) {
      expect(
        (await verifyResponse(await answer(signer), options(await storeWithFixtureChallenge()))).ok,
      ).toBe(true);
    }

    const full = await answer(hybrid);

    expect(
      (await verifyResponse(full, options(await storeWithFixtureChallenge(), { policy: 'pq-required' }))).ok,
    ).toBe(true);

    // Downgrade: strip the post-quantum half.
    const stripped = encodeResponse({ ...decodeResponse(full), pq: undefined });

    expect(
      await verifyResponse(stripped, options(await storeWithFixtureChallenge(), { policy: 'pq-required' })),
    ).toEqual({ ok: false, code: 'pq-required' });
  });

  it('challenge_bytes_stable: the TypeScript encoder reproduces the committed challenge', () => {
    expect(toHex(encodeChallenge(CHALLENGE))).toBe(toHex(fixture('auth-v1/challenge.bin')));
  });
});

describe('a hybrid response built from two independent implementations', () => {
  interface VectorFile {
    message: string;
    vectors: Record<string, { publicKey: string; signature: string }>;
  }
  const vectors: VectorFile = JSON.parse(
    readFileSync(join(__dirname, '..', '__tests__', 'fixtures', 'ml-dsa', 'vectors.json'), 'utf8'),
  );

  it.each(['ml-dsa-44', 'ml-dsa-65', 'ml-dsa-87'] as const)(
    'accepts the Rust Ed25519 signature joined to a Python %s signature, under pq-required',
    async (alg) => {
      // The ML-DSA vectors sign the payload derived from the same challenge.bin, so the two halves
      // belong to one challenge even though three different implementations produced them.
      const rust = decodeResponse(fixture('auth-v1/response-ed25519.bin'));
      const vector = vectors.vectors[alg];
      const response = encodeResponse({
        ...rust,
        pq: {
          publicKey: pqPublicKey(alg, hex(vector.publicKey)),
          signature: pqSignature(alg, hex(vector.signature)),
        },
      });

      const result = await verifyResponse(
        response,
        options(await storeWithFixtureChallenge(), { policy: 'pq-required' }),
      );

      expect(result.ok).toBe(true);
    },
  );

  it('is the very payload the vectors signed', () => {
    // If this ever drifts, the test above would be verifying signatures over a different message.
    expect(vectors.message.startsWith('83')).toBe(true);
    expect(vectors.message.endsWith(toHex(fixture('auth-v1/challenge.bin')))).toBe(true);
  });
});
