import { generateKeyPairSync } from 'node:crypto';

import { didKeyIdFor } from './didKeyId';
import { newIdentityChallenge, signIdentityProof, verifyIdentityProof } from './identityProof';

function person() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const didKey = didKeyIdFor(publicKey.export({ format: 'jwk' }) as Record<string, unknown>) as string;

  return { key: privateKey, didKey };
}

const ENDPOINT = 'https://alice.example.com/api/agent/v1';

describe('identity proofs', () => {
  const alice = person();

  function proof(overrides: Partial<{ endpoint: string; challenge: string }> = {}) {
    const challenge = overrides.challenge ?? newIdentityChallenge();

    return {
      challenge,
      doc: signIdentityProof(alice.key, {
        didKey: alice.didKey,
        endpoint: overrides.endpoint ?? ENDPOINT,
        challenge,
      }),
    };
  }

  it('verifies a proof signed by the key, over the endpoint, for the challenge', () => {
    const { challenge, doc } = proof();

    expect(verifyIdentityProof(doc, { didKey: alice.didKey, endpoint: ENDPOINT, challenge })).toBe(true);
  });

  it('reads a trailing slash on either side as the same endpoint', () => {
    const { challenge, doc } = proof({ endpoint: `${ENDPOINT}/` });

    expect(verifyIdentityProof(doc, { didKey: alice.didKey, endpoint: ENDPOINT, challenge })).toBe(true);
  });

  it('refuses a proof for another challenge: a replayed answer', () => {
    const { doc } = proof();

    expect(
      verifyIdentityProof(doc, {
        didKey: alice.didKey,
        endpoint: ENDPOINT,
        challenge: newIdentityChallenge(),
      }),
    ).toBe(false);
  });

  it('refuses a proof naming another endpoint: someone else’s address paired with this key', () => {
    const { challenge, doc } = proof({ endpoint: 'https://mallory.example.com/api/agent/v1' });

    expect(verifyIdentityProof(doc, { didKey: alice.didKey, endpoint: ENDPOINT, challenge })).toBe(false);
  });

  it('refuses a proof signed by a different key than the did:key the caller asked about', () => {
    const mallory = person();
    const challenge = newIdentityChallenge();
    const forged = signIdentityProof(mallory.key, { didKey: alice.didKey, endpoint: ENDPOINT, challenge });

    expect(verifyIdentityProof(forged, { didKey: alice.didKey, endpoint: ENDPOINT, challenge })).toBe(false);
  });

  it('refuses a document whose endpoint was edited after signing', () => {
    const { challenge, doc } = proof();
    const edited = { ...doc, endpoint: 'https://alice.example.com/other/agent/v1' };

    expect(
      verifyIdentityProof(edited, {
        didKey: alice.didKey,
        endpoint: 'https://alice.example.com/other/agent/v1',
        challenge,
      }),
    ).toBe(false);
  });

  it.each([null, 'x', {}, { v: 2 }])('refuses %j', (raw) => {
    expect(
      verifyIdentityProof(raw, {
        didKey: alice.didKey,
        endpoint: ENDPOINT,
        challenge: newIdentityChallenge(),
      }),
    ).toBe(false);
  });
});
