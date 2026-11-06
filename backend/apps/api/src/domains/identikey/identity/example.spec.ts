import { randomBytes } from 'node:crypto';

import {
  ChallengeIssuer,
  InMemoryNonceStore,
  SoftwareSigner,
  fingerprintOf,
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
  const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

  it('authenticates an enrolled hybrid identity, then refuses a swapped key and a stranger', async () => {
    const nonces = new InMemoryNonceStore();
    const issuer = new ChallengeIssuer({ audience, ttlSeconds: 120 });
    const enrolled = new Map<string, PqPin>(); // in production: a table keyed by fingerprint

    const verify = (response: Uint8Array) =>
      verifyResponse(response, {
        audience,
        now,
        skewSeconds: 30,
        policy: 'pq-required',
        nonces,
        // Only an identity that was enrolled here gets as far as the post-quantum check.
        resolvePqPin: (fingerprint) => enrolled.get(hex(fingerprint)) ?? { kind: 'unknown-identity' },
      });

    // The claimant holds an Ed25519 key and an ML-DSA-65 key.
    const classicalSeed = randomBytes(32);
    const claimant = SoftwareSigner.fromEd25519Seed(classicalSeed).withMlDsa('ml-dsa-65');

    // ENROLLMENT. Phase 2 builds the real thing; this is its stand-in. Both public keys are recorded
    // together, in one step, over a channel the verifier already trusts. It is never done with
    // whatever post-quantum key a login happens to present: a login does not vouch for that key.
    const pqKey = claimant.pqPublicKey();
    if (pqKey === null) {
      throw new Error('a hybrid claimant always has a post-quantum key');
    }

    enrolled.set(hex(fingerprintOf(claimant.classicalPublicKey())), { kind: 'key', publicKey: pqKey });

    // Verifier: issue a challenge. Claimant: answer it. Verifier: check the answer.
    const first = await issuer.issue(nonces, now);
    const response = await respond(claimant, first.bytes, { audience });
    const result = await verify(response);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(`unexpected refusal: ${result.code}`);
    }

    // `pqPinned` is how a caller knows the post-quantum signature is about THIS identity.
    expect(result.verified.pqPinned).toBe(true);
    expect(fingerprintToBase58(result.verified.fingerprint)).toMatch(/^[1-9A-HJ-NP-Za-km-z]{43,44}$/);

    // The same response cannot be used twice.
    expect(await verify(response)).toEqual({ ok: false, code: 'replay' });

    // Someone who can forge the Ed25519 signature but not ML-DSA brings a post-quantum key of their own.
    const impostor = SoftwareSigner.fromEd25519Seed(classicalSeed).withMlDsa('ml-dsa-65');
    const second = await issuer.issue(nonces, now);
    const forged = await respond(impostor, second.bytes, { audience });

    expect(await verify(forged)).toEqual({ ok: false, code: 'pq-key-changed' });

    // A stranger was never enrolled. They are refused before any post-quantum work is done for them.
    const stranger = SoftwareSigner.generateEd25519().withMlDsa('ml-dsa-65');
    const third = await issuer.issue(nonces, now);

    expect(await verify(await respond(stranger, third.bytes, { audience }))).toEqual({
      ok: false,
      code: 'unknown-identity',
    });

    // The genuine claimant is unaffected by the failed attempts.
    const fourth = await issuer.issue(nonces, now);

    expect((await verify(await respond(claimant, fourth.bytes, { audience }))).ok).toBe(true);
  });
});
