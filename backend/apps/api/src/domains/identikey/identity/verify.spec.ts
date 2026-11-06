import { randomBytes } from 'node:crypto';

import { hex, must, toHex } from '../__tests__/support';
import { cbor, encode } from '../encoding/dcbor';

import {
  decodeResponse,
  encodeChallenge,
  encodeResponse,
  PROTOCOL_VERSION,
  signingPayload,
  type Challenge,
} from './challenge';
import {
  classicalSignature,
  fingerprintOf,
  pqPublicKey,
  pqSignature,
  signatureToCbor,
  type PqPublicKey,
} from './keys';
import { ChallengeIssuer, InMemoryNonceStore, type NonceStore } from './nonceStore';
import { SoftwareSigner, respond, type Signer } from './softwareSigner';
import { verifyResponse, type PqPin, type VerifyOptions, type VerifyResult } from './verify';

const AUD = 'papyrus';
const NOW = 1_000_000;
const TTL = 120;
const SKEW = 30;

const options = (nonces: NonceStore, extra: Partial<VerifyOptions> = {}): VerifyOptions => ({
  audience: AUD,
  now: NOW,
  skewSeconds: SKEW,
  policy: 'pq-optional',
  nonces,
  ...extra,
});

async function issue(at = NOW) {
  const nonces = new InMemoryNonceStore();
  const issued = await new ChallengeIssuer({ audience: AUD, ttlSeconds: TTL }).issue(nonces, at);

  return { nonces, issued };
}

/** A genuine exchange: issue, answer, verify. */
async function exchange(signer: Signer, extra: Partial<VerifyOptions> = {}, at = NOW) {
  const { nonces, issued } = await issue(at);
  const response = await respond(signer, issued.bytes, { audience: AUD });

  return { nonces, issued, response, result: await verifyResponse(response, options(nonces, extra)) };
}

const expectFailure = (result: VerifyResult, code: string): void => {
  expect(result).toEqual({ ok: false, code });
};

function expectOk(result: VerifyResult) {
  if (!result.ok) {
    throw new Error(`expected success, got ${result.code}`);
  }

  return result.verified;
}

/** A challenge that was never issued through `respond`'s checks, signed by hand and recorded in the store. */
async function answerChallenge(
  signer: Signer,
  challenge: Challenge,
  nonces: NonceStore,
  record = true,
): Promise<Uint8Array> {
  const bytes = encodeChallenge(challenge);
  if (record) {
    await nonces.recordIssued(challenge.nonce, bytes, challenge.expiresAt, NOW);
  }

  return encodeResponse({
    challengeBytes: bytes,
    publicKey: signer.classicalPublicKey(),
    signature: await signer.signClassical(signingPayload(bytes)),
  });
}

const baseChallenge = (overrides: Partial<Challenge> = {}): Challenge => ({
  version: PROTOCOL_VERSION,
  audience: AUD,
  nonce: new Uint8Array(randomBytes(16)),
  issuedAt: NOW,
  expiresAt: NOW + TTL,
  ...overrides,
});

describe('verifyResponse', () => {
  describe('genuine answers', () => {
    it('accepts an Ed25519 identity and names it by fingerprint', async () => {
      const signer = SoftwareSigner.generateEd25519();
      const verified = expectOk((await exchange(signer)).result);

      expect(verified.publicKey.alg).toBe('ed25519');
      expect(toHex(verified.fingerprint)).toBe(toHex(fingerprintOf(signer.classicalPublicKey())));
      expect(verified.pqPublicKey).toBeNull();
    });

    it('accepts a P-256 identity', async () => {
      const verified = expectOk((await exchange(SoftwareSigner.generateP256())).result);

      expect(verified.publicKey.alg).toBe('p256');
    });

    it('accepts a hybrid identity under pq-required and reports its post-quantum key', async () => {
      const signer = SoftwareSigner.generateEd25519().withMlDsa('ml-dsa-65');
      const verified = expectOk((await exchange(signer, { policy: 'pq-required' })).result);

      expect(verified.pqPublicKey?.alg).toBe('ml-dsa-65');
      expect(toHex(must(verified.pqPublicKey).bytes)).toBe(toHex(must(signer.pqPublicKey()).bytes));
    });

    it.each(['ml-dsa-44', 'ml-dsa-65', 'ml-dsa-87'] as const)(
      'accepts %s as the post-quantum half',
      async (alg) => {
        const signer = SoftwareSigner.generateP256().withMlDsa(alg);

        expectOk((await exchange(signer, { policy: 'pq-required' })).result);
      },
    );
  });

  describe('policy', () => {
    it('refuses a classical-only identity when a post-quantum signature is required', async () => {
      expectFailure(
        (await exchange(SoftwareSigner.generateP256(), { policy: 'pq-required' })).result,
        'pq-required',
      );
    });

    it('refuses a hybrid answer with its post-quantum half stripped, when one is required', async () => {
      const signer = SoftwareSigner.generateEd25519().withMlDsa('ml-dsa-65');
      const { nonces, issued } = await issue();
      const full = decodeResponse(await respond(signer, issued.bytes, { audience: AUD }));
      const stripped = encodeResponse({
        challengeBytes: full.challengeBytes,
        publicKey: full.publicKey,
        signature: full.signature,
      });

      expectFailure(
        await verifyResponse(stripped, options(nonces, { policy: 'pq-required' })),
        'pq-required',
      );
    });

    it('still checks a post-quantum signature that is present when none is required', async () => {
      const signer = SoftwareSigner.generateEd25519().withMlDsa('ml-dsa-65');
      const { nonces, issued } = await issue();
      const full = decodeResponse(await respond(signer, issued.bytes, { audience: AUD }));
      const damaged = Uint8Array.from(must(full.pq).signature.bytes);
      damaged[0] ^= 0x01;
      const response = encodeResponse({
        ...full,
        pq: { publicKey: must(full.pq).publicKey, signature: pqSignature('ml-dsa-65', damaged) },
      });

      expectFailure(await verifyResponse(response, options(nonces)), 'bad-signature');
    });

    it('refuses a post-quantum signature made by a different parameter set than the key names', async () => {
      const signer = SoftwareSigner.generateEd25519().withMlDsa('ml-dsa-65');
      const other = SoftwareSigner.generateEd25519().withMlDsa('ml-dsa-44');
      const { nonces, issued } = await issue();
      const payload = signingPayload(issued.bytes);
      const response = encodeResponse({
        challengeBytes: issued.bytes,
        publicKey: signer.classicalPublicKey(),
        signature: await signer.signClassical(payload),
        pq: { publicKey: must(signer.pqPublicKey()), signature: must(await other.signPq(payload)) },
      });

      expectFailure(await verifyResponse(response, options(nonces)), 'bad-signature');
    });
  });

  describe('the challenge', () => {
    it('refuses another audience', async () => {
      const { nonces, issued } = await issue();
      const response = await respond(SoftwareSigner.generateEd25519(), issued.bytes, { audience: AUD });

      expectFailure(await verifyResponse(response, options(nonces, { audience: 'not-papyrus' })), 'audience');
    });

    it('refuses a protocol version it does not speak', async () => {
      const nonces = new InMemoryNonceStore();
      const response = await answerChallenge(
        SoftwareSigner.generateEd25519(),
        baseChallenge({ version: 2 }),
        nonces,
      );

      expectFailure(await verifyResponse(response, options(nonces)), 'version');
    });

    it('refuses a nonce under the minimum length, even one the store holds', async () => {
      const nonces = new InMemoryNonceStore();
      const response = await answerChallenge(
        SoftwareSigner.generateEd25519(),
        baseChallenge({ nonce: new Uint8Array(15) }),
        nonces,
      );

      expectFailure(await verifyResponse(response, options(nonces)), 'nonce-too-short');
    });

    it('answers a challenge exactly once', async () => {
      const { nonces, response } = await exchange(SoftwareSigner.generateEd25519());

      expectFailure(await verifyResponse(response, options(nonces)), 'replay');
      expectFailure(await verifyResponse(response, options(nonces)), 'replay');
    });

    it('refuses a challenge this verifier never issued', async () => {
      const foreign = new InMemoryNonceStore();
      const response = await answerChallenge(
        SoftwareSigner.generateEd25519(),
        baseChallenge(),
        foreign,
        false,
      );

      expectFailure(await verifyResponse(response, options(foreign)), 'unknown-challenge');
    });

    it('refuses a challenge whose bytes differ from the ones issued under that nonce', async () => {
      // An attacker who asked for a challenge knows an issued nonce. The window verifyResponse applies
      // comes from the challenge IN the response, so without the store vouching for those bytes the
      // attacker could pick a far-future `exp`.
      const nonces = new InMemoryNonceStore();
      const issued = baseChallenge();
      await nonces.recordIssued(issued.nonce, encodeChallenge(issued), issued.expiresAt, NOW);
      const forged = baseChallenge({ nonce: issued.nonce, expiresAt: NOW + 1_000_000 });
      const response = await answerChallenge(SoftwareSigner.generateEd25519(), forged, nonces, false);

      expectFailure(await verifyResponse(response, options(nonces)), 'challenge-mismatch');
      // And the genuine challenge is still answerable afterwards.
      const genuine = await answerChallenge(SoftwareSigner.generateEd25519(), issued, nonces, false);

      expectOk(await verifyResponse(genuine, options(nonces)));
    });

    it('would have accepted that forged lifetime if the store only matched nonces (why the binding exists)', async () => {
      const issued = baseChallenge();
      const issuedNonces = new Set([toHex(issued.nonce)]);
      const spent = new Set<string>();
      const naive: NonceStore = {
        recordIssued: async () => undefined,
        consume: async (nonce) => {
          const key = toHex(nonce);
          if (!issuedNonces.has(key)) {
            return 'unknown';
          }

          if (spent.has(key)) {
            return 'used';
          }

          spent.add(key);

          return 'consumed';
        },
        gc: async () => 0,
      };
      const forged = baseChallenge({ nonce: issued.nonce, expiresAt: NOW + 1_000_000 });
      const response = await answerChallenge(SoftwareSigner.generateEd25519(), forged, naive, false);

      // A day after the issued challenge expired, the claimant-chosen lifetime still carries it.
      expectOk(await verifyResponse(response, options(naive, { now: NOW + 86_400 })));
    });
  });

  describe('the validity window', () => {
    // Issued at NOW with a 120 s lifetime and 30 s of skew: valid from NOW - 30 to NOW + 150, inclusive.
    it.each([
      [-30, true],
      [-31, false],
      [0, true],
      [TTL, true],
      [TTL + SKEW, true],
      [TTL + SKEW + 1, false],
    ])('at %p seconds from issue: accepted = %p', async (offset, accepted) => {
      const { result } = await exchange(SoftwareSigner.generateEd25519(), { now: NOW + offset });

      if (accepted) {
        expectOk(result);
      } else {
        expectFailure(result, 'time-window');
      }
    });

    it('with no skew, accepts the first and last second only', async () => {
      const edge = (offset: number) =>
        exchange(SoftwareSigner.generateEd25519(), { now: NOW + offset, skewSeconds: 0 });

      expectOk((await edge(0)).result);
      expectOk((await edge(TTL)).result);
      expectFailure((await edge(-1)).result, 'time-window');
      expectFailure((await edge(TTL + 1)).result, 'time-window');
    });

    it('does not spend the nonce on an answer that arrives too late or too early', async () => {
      const { nonces, response } = await exchange(SoftwareSigner.generateEd25519(), { now: NOW + 10_000 });

      expectOk(await verifyResponse(response, options(nonces)));
    });
  });

  describe('tampering', () => {
    it('refuses a changed challenge, because the signature covered the original bytes', async () => {
      const { nonces, issued } = await issue();
      const response = decodeResponse(
        await respond(SoftwareSigner.generateEd25519(), issued.bytes, { audience: AUD }),
      );
      const changed = Uint8Array.from(response.challengeBytes);
      changed[changed.length - 1] ^= 0xff;

      expectFailure(
        await verifyResponse(encodeResponse({ ...response, challengeBytes: changed }), options(nonces)),
        'bad-signature',
      );
    });

    it.each([0, 31, 32, 63])('refuses a classical signature with byte %p flipped', async (index) => {
      const { nonces, issued } = await issue();
      const response = decodeResponse(
        await respond(SoftwareSigner.generateEd25519(), issued.bytes, { audience: AUD }),
      );
      const damaged = Uint8Array.from(response.signature.bytes);
      damaged[index] ^= 0x01;
      const bytes = encodeResponse({ ...response, signature: classicalSignature('ed25519', damaged) });

      expectFailure(await verifyResponse(bytes, options(nonces)), 'bad-signature');
    });

    it('refuses someone else’s key presented with a genuine signature', async () => {
      const { nonces, issued } = await issue();
      const response = decodeResponse(
        await respond(SoftwareSigner.generateEd25519(), issued.bytes, { audience: AUD }),
      );
      const stranger = SoftwareSigner.generateEd25519().classicalPublicKey();

      expectFailure(
        await verifyResponse(encodeResponse({ ...response, publicKey: stranger }), options(nonces)),
        'bad-signature',
      );
    });

    it('refuses a key and a signature that name different algorithms', async () => {
      const { nonces, issued } = await issue();
      const response = decodeResponse(
        await respond(SoftwareSigner.generateEd25519(), issued.bytes, { audience: AUD }),
      );
      const confused = encodeResponse({
        ...response,
        signature: classicalSignature('p256', response.signature.bytes),
      });

      expectFailure(await verifyResponse(confused, options(nonces)), 'bad-signature');
    });

    it('does not let a failed attempt spend the challenge a genuine claimant still holds', async () => {
      const signer = SoftwareSigner.generateEd25519();
      const { nonces, issued } = await issue();
      const genuine = await respond(signer, issued.bytes, { audience: AUD });
      const bad = decodeResponse(genuine);
      const damaged = Uint8Array.from(bad.signature.bytes);
      damaged[5] ^= 0x01;

      expectFailure(
        await verifyResponse(
          encodeResponse({ ...bad, signature: classicalSignature('ed25519', damaged) }),
          options(nonces),
        ),
        'bad-signature',
      );
      expectOk(await verifyResponse(genuine, options(nonces)));
    });

    it('lets exactly one of several simultaneous copies of a valid answer through', async () => {
      const { nonces, issued } = await issue();
      const response = await respond(SoftwareSigner.generateP256(), issued.bytes, { audience: AUD });

      const results = await Promise.all(
        Array.from({ length: 10 }, () => verifyResponse(response, options(nonces))),
      );

      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.filter((r) => !r.ok && r.code === 'replay')).toHaveLength(9);
    });
  });

  describe('hostile input never throws and never succeeds', () => {
    const assertMalformed = async (bytes: Uint8Array) => {
      const nonces = new InMemoryNonceStore();

      expect((await verifyResponse(bytes, options(nonces))).ok).toBe(false);
    };

    it('refuses the empty input, random bytes, and a truncated genuine response', async () => {
      const { issued } = await issue();
      const genuine = await respond(SoftwareSigner.generateEd25519(), issued.bytes, { audience: AUD });

      await assertMalformed(new Uint8Array(0));
      await assertMalformed(new Uint8Array(randomBytes(300)));
      await assertMalformed(genuine.subarray(0, genuine.length - 1));
      await assertMalformed(new Uint8Array([...genuine, 0]));
    });

    it('answers malformed with the code "malformed"', async () => {
      const nonces = new InMemoryNonceStore();

      expectFailure(await verifyResponse(new Uint8Array(0), options(nonces)), 'malformed');
      expectFailure(await verifyResponse(new Uint8Array(20_000), options(nonces)), 'malformed');
    });

    it('refuses an algorithm outside the registry', async () => {
      const { nonces, issued } = await issue();
      const genuine = decodeResponse(
        await respond(SoftwareSigner.generateEd25519(), issued.bytes, { audience: AUD }),
      );
      const response = encode(
        cbor.map([
          ['chal', cbor.bytes(genuine.challengeBytes)],
          [
            'pub',
            cbor.map([
              ['alg', cbor.text('rsa')],
              ['key', cbor.bytes(genuine.publicKey.bytes)],
            ]),
          ],
          ['sig', signatureToCbor(genuine.signature)],
        ]),
      );

      expectFailure(await verifyResponse(response, options(nonces)), 'unknown-algorithm');
    });

    it('refuses the universal Ed25519 forgery: a small-order key with signature (R = identity, S = 0)', async () => {
      // Under the plain verification equation this "signs" every message. It must die at the key.
      const { nonces, issued } = await issue();
      const identity = hex(`01${'00'.repeat(31)}`);
      const universal = new Uint8Array(64);
      universal.set(identity, 0);
      const response = encode(
        cbor.map([
          ['chal', cbor.bytes(issued.bytes)],
          [
            'pub',
            cbor.map([
              ['alg', cbor.text('ed25519')],
              ['key', cbor.bytes(identity)],
            ]),
          ],
          [
            'sig',
            cbor.map([
              ['alg', cbor.text('ed25519')],
              ['sig', cbor.bytes(universal)],
            ]),
          ],
        ]),
      );

      expectFailure(await verifyResponse(response, options(nonces)), 'bad-key');
    });

    it('refuses a valid key with a signature whose R has small order', async () => {
      const { nonces, issued } = await issue();
      const genuine = decodeResponse(
        await respond(SoftwareSigner.generateEd25519(), issued.bytes, { audience: AUD }),
      );
      const weak = Uint8Array.from(genuine.signature.bytes);
      weak.set(hex(`01${'00'.repeat(31)}`), 0);

      expectFailure(
        await verifyResponse(
          encodeResponse({ ...genuine, signature: classicalSignature('ed25519', weak) }),
          options(nonces),
        ),
        'bad-signature',
      );
    });
  });

  describe('the caller’s options', () => {
    it.each([
      ['a fractional now', { now: 1.5 }],
      ['a negative now', { now: -1 }],
      ['a negative skew', { skewSeconds: -1 }],
      ['a fractional skew', { skewSeconds: 0.5 }],
    ])('rejects %s as a programming error', async (_label, extra) => {
      const { nonces, response } = await exchange(SoftwareSigner.generateEd25519());

      await expect(verifyResponse(response, options(nonces, extra))).rejects.toThrow(RangeError);
    });
  });

  describe('when OUR side fails, that is not an answer about the claimant', () => {
    it('rejects, rather than returning ok or a failure code, when the nonce store is down', async () => {
      const { issued } = await issue();
      const response = await respond(SoftwareSigner.generateEd25519(), issued.bytes, { audience: AUD });
      const down: NonceStore = {
        recordIssued: async () => undefined,
        consume: async () => {
          throw new Error('connection refused');
        },
        gc: async () => 0,
      };

      await expect(verifyResponse(response, options(down))).rejects.toThrow('connection refused');
    });
  });

  describe('post-quantum pinning', () => {
    // The reference carries the ML-DSA key inside the response, and the fingerprint hashes only the
    // classical key. So a PQ key is not bound to an identity unless the verifier remembers it.

    it('reports an unpinned identity’s post-quantum key so that the caller can pin it', async () => {
      const signer = SoftwareSigner.generateEd25519().withMlDsa('ml-dsa-65');
      const verified = expectOk((await exchange(signer)).result);

      expect(toHex(must(verified.pqPublicKey).bytes)).toBe(toHex(must(signer.pqPublicKey()).bytes));
    });

    it('accepts an identity that presents exactly the key it is pinned to', async () => {
      const signer = SoftwareSigner.generateEd25519().withMlDsa('ml-dsa-65');
      const pin: PqPin = { kind: 'key', publicKey: must(signer.pqPublicKey()) };

      expectOk((await exchange(signer, { policy: 'pq-required', resolvePqPin: () => pin })).result);
    });

    describe('the swap a quantum forger would try', () => {
      // The forger can produce the victim's CLASSICAL signature (that is what a quantum computer
      // gives them) but not the victim's ML-DSA one. They attach a key pair of their own.
      const build = async (victim: SoftwareSigner, attacker: SoftwareSigner) => {
        const { nonces, issued } = await issue();
        const payload = signingPayload(issued.bytes);
        const response = encodeResponse({
          challengeBytes: issued.bytes,
          publicKey: victim.classicalPublicKey(),
          signature: await victim.signClassical(payload),
          pq: { publicKey: must(attacker.pqPublicKey()), signature: must(await attacker.signPq(payload)) },
        });

        return { nonces, response };
      };

      it('succeeds against a verifier with no memory of the victim: the gap, demonstrated', async () => {
        const victim = SoftwareSigner.generateEd25519().withMlDsa('ml-dsa-65');
        const attacker = SoftwareSigner.generateEd25519().withMlDsa('ml-dsa-65');
        const { nonces, response } = await build(victim, attacker);
        const verified = expectOk(await verifyResponse(response, options(nonces, { policy: 'pq-required' })));

        // "Post-quantum verified", and the post-quantum key is the attacker's.
        expect(toHex(must(verified.pqPublicKey).bytes)).toBe(toHex(must(attacker.pqPublicKey()).bytes));
        expect(toHex(must(verified.pqPublicKey).bytes)).not.toBe(toHex(must(victim.pqPublicKey()).bytes));
      });

      it('is refused once the verifier has pinned the victim’s real key', async () => {
        const victim = SoftwareSigner.generateEd25519().withMlDsa('ml-dsa-65');
        const attacker = SoftwareSigner.generateEd25519().withMlDsa('ml-dsa-65');
        const { nonces, response } = await build(victim, attacker);
        const resolvePqPin = jest.fn((): PqPin => ({ kind: 'key', publicKey: must(victim.pqPublicKey()) }));

        expectFailure(
          await verifyResponse(response, options(nonces, { policy: 'pq-required', resolvePqPin })),
          'pq-key-changed',
        );
        expect(resolvePqPin).toHaveBeenCalledTimes(1);
      });
    });

    it('refuses an identity pinned to a key that now answers without one (a downgrade)', async () => {
      const signer = SoftwareSigner.generateEd25519().withMlDsa('ml-dsa-65');
      const stripped = SoftwareSigner.fromEd25519Seed(new Uint8Array(32).fill(7));
      const pin: PqPin = { kind: 'key', publicKey: must(signer.pqPublicKey()) };

      expectFailure((await exchange(stripped, { resolvePqPin: () => pin })).result, 'pq-key-changed');
    });

    it('refuses an identity enrolled without a post-quantum key that suddenly presents one', async () => {
      const hybrid = SoftwareSigner.generateEd25519().withMlDsa('ml-dsa-44');

      expectFailure(
        (await exchange(hybrid, { resolvePqPin: () => ({ kind: 'none' }) })).result,
        'pq-key-changed',
      );
    });

    it('accepts an enrolled classical-only identity that stays classical-only', async () => {
      expectOk(
        (await exchange(SoftwareSigner.generateP256(), { resolvePqPin: () => ({ kind: 'none' }) })).result,
      );
    });

    it('treats a different parameter set as a different key', async () => {
      const signer = SoftwareSigner.generateEd25519().withMlDsa('ml-dsa-65');
      const pinnedElsewhere: PqPublicKey = pqPublicKey('ml-dsa-44', new Uint8Array(1312));

      expectFailure(
        (await exchange(signer, { resolvePqPin: () => ({ kind: 'key', publicKey: pinnedElsewhere }) }))
          .result,
        'pq-key-changed',
      );
    });

    it('asks for the pin by the identity’s fingerprint, and only after the classical signature has held', async () => {
      const signer = SoftwareSigner.generateEd25519();
      const resolvePqPin = jest.fn((): PqPin => ({ kind: 'unpinned' }));
      const { nonces, issued } = await issue();
      const genuine = decodeResponse(await respond(signer, issued.bytes, { audience: AUD }));

      // A forged signature must not cost us a lookup.
      const damaged = Uint8Array.from(genuine.signature.bytes);
      damaged[0] ^= 1;
      await verifyResponse(
        encodeResponse({ ...genuine, signature: classicalSignature('ed25519', damaged) }),
        options(nonces, { resolvePqPin }),
      );
      expect(resolvePqPin).not.toHaveBeenCalled();

      // A wrong audience must not either.
      await verifyResponse(encodeResponse(genuine), options(nonces, { resolvePqPin, audience: 'other' }));
      expect(resolvePqPin).not.toHaveBeenCalled();

      expectOk(await verifyResponse(encodeResponse(genuine), options(nonces, { resolvePqPin })));
      expect(resolvePqPin).toHaveBeenCalledTimes(1);
      expect(toHex((resolvePqPin.mock.calls[0] as unknown as [Uint8Array])[0])).toBe(
        toHex(fingerprintOf(signer.classicalPublicKey())),
      );
    });

    it('supports an asynchronous pin lookup', async () => {
      const signer = SoftwareSigner.generateEd25519().withMlDsa('ml-dsa-65');
      const pin: PqPin = { kind: 'key', publicKey: must(signer.pqPublicKey()) };

      expectOk((await exchange(signer, { resolvePqPin: async () => pin })).result);
    });

    it('rejects, and does not spend the challenge, when the pin lookup itself fails', async () => {
      const signer = SoftwareSigner.generateEd25519();
      const { nonces, issued } = await issue();
      const response = await respond(signer, issued.bytes, { audience: AUD });

      await expect(
        verifyResponse(
          response,
          options(nonces, { resolvePqPin: () => Promise.reject(new Error('db down')) }),
        ),
      ).rejects.toThrow('db down');
      expectOk(await verifyResponse(response, options(nonces)));
    });
  });
});
