import { randomBytes } from 'node:crypto';

import {
  ChallengeIssuer,
  InMemoryNonceStore,
  SoftwareSigner,
  fingerprintToBase58,
  respond,
  verifyResponse,
  type PqPin,
} from '../index';

/**
 * The worked example in docs/identikey.md, run for real. If you change this file, change the document
 * to match, and the other way round: the document promises that its example works.
 */
describe('the worked example in docs/identikey.md', () => {
  const audience = 'papyrus';
  const now = Math.floor(Date.now() / 1000);

  it('authenticates a hybrid identity, pins its post-quantum key, then refuses a swapped one', async () => {
    const nonces = new InMemoryNonceStore();
    const issuer = new ChallengeIssuer({ audience, ttlSeconds: 120 });
    const pins = new Map<string, PqPin>(); // in production: a table keyed by fingerprint

    const verify = (response: Uint8Array) =>
      verifyResponse(response, {
        audience,
        now,
        skewSeconds: 30,
        policy: 'pq-required',
        nonces,
        resolvePqPin: (fingerprint) =>
          pins.get(Buffer.from(fingerprint).toString('hex')) ?? { kind: 'unpinned' },
      });

    // The claimant holds an Ed25519 key and an ML-DSA-65 key.
    const classicalSeed = randomBytes(32);
    const claimant = SoftwareSigner.fromEd25519Seed(classicalSeed).withMlDsa('ml-dsa-65');

    // Verifier: issue a challenge. Claimant: answer it. Verifier: check the answer.
    const first = await issuer.issue(nonces, now);
    const response = await respond(claimant, first.bytes, { audience });
    const result = await verify(response);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(`unexpected refusal: ${result.code}`);
    }

    // First contact: remember which post-quantum key belongs to this fingerprint.
    const fingerprint = Buffer.from(result.verified.fingerprint).toString('hex');
    if (result.verified.pqPublicKey === null) {
      throw new Error('a pq-required verification always reports the key that signed');
    }

    pins.set(fingerprint, { kind: 'key', publicKey: result.verified.pqPublicKey });
    expect(fingerprintToBase58(result.verified.fingerprint)).toMatch(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/);

    // The same response cannot be used twice.
    expect(await verify(response)).toEqual({ ok: false, code: 'replay' });

    // Someone who can forge the Ed25519 signature but not ML-DSA brings a post-quantum key of their own.
    const impostor = SoftwareSigner.fromEd25519Seed(classicalSeed).withMlDsa('ml-dsa-65');
    const second = await issuer.issue(nonces, now);
    const forged = await respond(impostor, second.bytes, { audience });

    expect(await verify(forged)).toEqual({ ok: false, code: 'pq-key-changed' });

    // The genuine claimant is unaffected by the failed attempt.
    const third = await issuer.issue(nonces, now);

    expect((await verify(await respond(claimant, third.bytes, { audience }))).ok).toBe(true);
  });
});
