import { fixture, must, toHex, VECTOR } from '../__tests__/support';
import { IdentiKeyError } from '../errors';

import { decodeResponse, encodeChallenge, signingPayload, type Challenge } from './challenge';
import { fingerprintOf, type ClassicalSignature } from './keys';
import { verifyClassical, verifyPq } from './signatures';
import { SoftwareSigner, respond, type Signer } from './softwareSigner';

const CHALLENGE_BYTES = fixture('auth-v1/challenge.bin');
const OPTIONS = { audience: VECTOR.audience } as const;

async function codeOfAsync(fn: () => Promise<unknown>): Promise<string> {
  try {
    await fn();
  } catch (error) {
    return error instanceof IdentiKeyError ? error.code : `other: ${(error as Error).message}`;
  }

  return 'no error';
}

describe('SoftwareSigner and respond()', () => {
  describe('against the Rust reference', () => {
    it('reproduces response-ed25519.bin BYTE FOR BYTE from the same seed (Ed25519 is deterministic)', async () => {
      const signer = SoftwareSigner.fromEd25519Seed(VECTOR.ed25519Seed);
      const bytes = await respond(signer, CHALLENGE_BYTES, OPTIONS);

      expect(toHex(bytes)).toBe(toHex(fixture('auth-v1/response-ed25519.bin')));
    });

    it('derives the same P-256 identity as the Rust fixture, and answers with a response that matches it field for field', async () => {
      // The Rust crate signs with RFC 6979 nonces; OpenSSL's ECDSA picks a random one, so the
      // signature bytes differ. Everything else in the message is identical, and the Rust signature
      // verifies under the key derived here (see fixtures.spec.ts).
      const signer = SoftwareSigner.fromP256Secret(VECTOR.p256Secret);
      const mine = decodeResponse(await respond(signer, CHALLENGE_BYTES, OPTIONS));
      const theirs = decodeResponse(fixture('auth-v1/response-p256.bin'));

      expect(mine.publicKey).toEqual(theirs.publicKey);
      expect(toHex(mine.challengeBytes)).toBe(toHex(theirs.challengeBytes));
      expect(mine.signature.alg).toBe(theirs.signature.alg);
      expect(verifyClassical(mine.publicKey, signingPayload(CHALLENGE_BYTES), mine.signature)).toBe(true);
    });
  });

  describe('respond() will not sign what it should not', () => {
    const signer = SoftwareSigner.generateEd25519();

    it('refuses a challenge for an audience other than the one intended: the one check only the claimant can make', async () => {
      expect(await codeOfAsync(() => respond(signer, CHALLENGE_BYTES, { audience: 'someone-else' }))).toBe(
        'audience',
      );
    });

    it('refuses a protocol version it does not speak', async () => {
      const challenge: Challenge = {
        version: 2,
        audience: VECTOR.audience,
        nonce: new Uint8Array(16),
        issuedAt: 1,
        expiresAt: 2,
      };

      expect(await codeOfAsync(() => respond(signer, encodeChallenge(challenge), OPTIONS))).toBe('version');
    });

    it('refuses bytes that are not a canonical challenge', async () => {
      expect(await codeOfAsync(() => respond(signer, new Uint8Array([...CHALLENGE_BYTES, 0]), OPTIONS))).toBe(
        'malformed',
      );
      expect(await codeOfAsync(() => respond(signer, new Uint8Array(0), OPTIONS))).toBe('malformed');
    });

    it('signs the bytes it was given, not a re-encoding of them', async () => {
      const response = decodeResponse(await respond(signer, CHALLENGE_BYTES, OPTIONS));

      expect(toHex(response.challengeBytes)).toBe(toHex(CHALLENGE_BYTES));
    });
  });

  describe('keys', () => {
    it('generates distinct, working identities of both classical algorithms', async () => {
      const first = SoftwareSigner.generateEd25519();
      const second = SoftwareSigner.generateEd25519();
      const p256a = SoftwareSigner.generateP256();
      const p256b = SoftwareSigner.generateP256();

      expect(toHex(fingerprintOf(first.classicalPublicKey()))).not.toBe(
        toHex(fingerprintOf(second.classicalPublicKey())),
      );
      expect(toHex(fingerprintOf(p256a.classicalPublicKey()))).not.toBe(
        toHex(fingerprintOf(p256b.classicalPublicKey())),
      );
      expect(first.classicalPublicKey().alg).toBe('ed25519');
      expect(p256a.classicalPublicKey().alg).toBe('p256');
      for (const signer of [first, p256a]) {
        const payload = new Uint8Array([1, 2, 3]);

        expect(
          verifyClassical(signer.classicalPublicKey(), payload, await signer.signClassical(payload)),
        ).toBe(true);
      }
    });

    it('attaches a post-quantum key without changing the signer it started from', async () => {
      const plain = SoftwareSigner.generateEd25519();
      const hybrid = plain.withMlDsa('ml-dsa-65');

      expect(plain.pqPublicKey()).toBeNull();
      expect(await plain.signPq(new Uint8Array(1))).toBeNull();
      expect(must(hybrid.pqPublicKey()).alg).toBe('ml-dsa-65');
      expect(toHex(hybrid.classicalPublicKey().bytes)).toBe(toHex(plain.classicalPublicKey().bytes));

      const payload = new Uint8Array([9, 9]);
      const signature = must(await hybrid.signPq(payload));

      expect(verifyPq(must(hybrid.pqPublicKey()), payload, signature)).toBe(true);
    });

    it('rebuilds the same post-quantum key from a seed', () => {
      const seed = new Uint8Array(32).fill(5);
      const a = SoftwareSigner.generateEd25519().withMlDsa('ml-dsa-44', { seed });
      const b = SoftwareSigner.generateP256().withMlDsa('ml-dsa-44', { seed });

      expect(toHex(must(a.pqPublicKey()).bytes)).toBe(toHex(must(b.pqPublicKey()).bytes));
    });

    it('produces a response carrying the post-quantum pair', async () => {
      const signer = SoftwareSigner.generateEd25519().withMlDsa('ml-dsa-87');
      const response = decodeResponse(await respond(signer, CHALLENGE_BYTES, OPTIONS));

      expect(response.pq?.publicKey.alg).toBe('ml-dsa-87');
      expect(response.pq?.signature.alg).toBe('ml-dsa-87');
    });
  });

  describe('a backend that is not the software signer', () => {
    const base = SoftwareSigner.generateEd25519();

    it('works through the Signer interface alone (this is the seam for an enclave or wallet)', async () => {
      const calls: string[] = [];
      const backend: Signer = {
        classicalPublicKey: () => base.classicalPublicKey(),
        signClassical: async (payload) => {
          calls.push('sign');

          return base.signClassical(payload);
        },
      };
      const response = decodeResponse(await respond(backend, CHALLENGE_BYTES, OPTIONS));

      expect(calls).toEqual(['sign']);
      expect(response.pq).toBeUndefined();
    });

    it('fails loudly if it advertises a post-quantum key and then cannot sign with it', async () => {
      const hybrid = base.withMlDsa('ml-dsa-65');
      const broken: Signer = {
        classicalPublicKey: () => hybrid.classicalPublicKey(),
        signClassical: (payload) => hybrid.signClassical(payload),
        pqPublicKey: () => hybrid.pqPublicKey(),
        signPq: async () => null,
      };

      expect(await codeOfAsync(() => respond(broken, CHALLENGE_BYTES, OPTIONS))).toMatch(
        /^other: .*no post-quantum signature|^other: .*produced no post-quantum signature/,
      );
    });

    it('propagates a backend failure (a refused biometric prompt, say) rather than answering', async () => {
      const refusing: Signer = {
        classicalPublicKey: () => base.classicalPublicKey(),
        signClassical: async (): Promise<ClassicalSignature> => {
          throw new Error('user cancelled');
        },
      };

      expect(await codeOfAsync(() => respond(refusing, CHALLENGE_BYTES, OPTIONS))).toBe(
        'other: user cancelled',
      );
    });
  });
});
