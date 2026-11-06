import { generateKeyPairSync, randomBytes } from 'node:crypto';

import { ed25519FromSeed } from '../crypto/ed25519';
import { mlDsaFromSeed, type MlDsaAlg } from '../crypto/mlDsa';
import { p256FromSecret } from '../crypto/p256';
import { IdentiKeyError } from '../errors';

import type { ClassicalAlg } from './algorithms';
import { decodeChallenge, encodeResponse, PROTOCOL_VERSION, signingPayload } from './challenge';
import {
  classicalPublicKey,
  classicalSignature,
  pqPublicKey,
  pqSignature,
  type ClassicalPublicKey,
  type ClassicalSignature,
  type PqPublicKey,
  type PqSignature,
} from './keys';

/**
 * The claimant side: something that can answer a challenge by signing.
 *
 * `Signer` is the seam a hardware- or wallet-backed key plugs into later (an Apple Secure Enclave key
 * is P-256; an IKEYW wallet unwraps an Ed25519 seed). It is async because those backends are: a
 * biometric prompt or a TPM call is not a synchronous function. `respond` below assembles the wire
 * message so no backend ever touches the format or the domain separation.
 */
export interface Signer {
  classicalPublicKey(): ClassicalPublicKey;
  signClassical(payload: Uint8Array): Promise<ClassicalSignature>;
  /** The post-quantum key, if this identity has one. */
  pqPublicKey?(): PqPublicKey | null;
  signPq?(payload: Uint8Array): Promise<PqSignature | null>;
}

export interface RespondOptions {
  /**
   * The audience you MEANT to authenticate to. REQUIRED, and checked before anything is signed.
   *
   * This is the one check only the claimant can make. A malicious site can fetch a real challenge from
   * a service and show it to you as its own; your signature is then valid at the service. The
   * audience in the challenge names where the signature will be accepted, so refuse to sign one that
   * names somewhere else.
   */
  audience: string;
}

/**
 * Answer a challenge. Returns the response's wire bytes.
 *
 * The challenge must be canonical and well-formed, and is signed over the bytes you were given.
 */
export async function respond(
  signer: Signer,
  challengeBytes: Uint8Array,
  options: RespondOptions,
): Promise<Uint8Array> {
  const challenge = decodeChallenge(challengeBytes);
  if (challenge.version !== PROTOCOL_VERSION) {
    throw new IdentiKeyError('version', `cannot answer a version ${challenge.version} challenge`);
  }

  if (challenge.audience !== options.audience) {
    throw new IdentiKeyError('audience', 'the challenge is for a different audience than the one intended');
  }

  const payload = signingPayload(challengeBytes);
  const signature = await signer.signClassical(payload);

  const pqKey = signer.pqPublicKey?.() ?? null;
  if (pqKey === null) {
    return encodeResponse({
      challengeBytes,
      publicKey: signer.classicalPublicKey(),
      signature,
    });
  }

  // A signer that advertises a PQ key and then cannot sign with it must fail loudly. Quietly sending
  // a classical-only response would look like a successful login right up to the verifier that
  // requires PQ, and would hide a broken key.
  const pqSig = (await signer.signPq?.(payload)) ?? null;
  if (pqSig === null) {
    throw new Error('identikey: the signer has a post-quantum key but produced no post-quantum signature');
  }

  return encodeResponse({
    challengeBytes,
    publicKey: signer.classicalPublicKey(),
    signature,
    pq: { publicKey: pqKey, signature: pqSig },
  });
}

// ─── software keys ───────────────────────────────────────────────────────────

interface ClassicalKit {
  readonly alg: ClassicalAlg;
  readonly publicKey: Uint8Array;
  readonly sign: (message: Uint8Array) => Uint8Array;
}

interface PqKit {
  readonly alg: MlDsaAlg;
  readonly publicKey: Uint8Array;
  readonly sign: (message: Uint8Array) => Uint8Array;
}

/**
 * An in-process key. NOT hardware-backed and no biometric check: for development, tests, and as the
 * building block of a wallet-unwrapped identity. It holds the secret in memory for its whole life.
 */
export class SoftwareSigner implements Signer {
  private constructor(
    private readonly classical: ClassicalKit,
    private readonly pq: PqKit | null,
  ) {}

  static generateEd25519(): SoftwareSigner {
    return SoftwareSigner.fromEd25519Seed(randomBytes(32));
  }

  static fromEd25519Seed(seed: Uint8Array): SoftwareSigner {
    const { publicKey, sign } = ed25519FromSeed(seed);

    return new SoftwareSigner({ alg: 'ed25519', publicKey, sign }, null);
  }

  static generateP256(): SoftwareSigner {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    // A JWK pads `d` to the curve size, so this is always 32 bytes.
    const d = privateKey.export({ format: 'jwk' }).d as string;

    return SoftwareSigner.fromP256Secret(Buffer.from(d, 'base64url'));
  }

  static fromP256Secret(secret: Uint8Array): SoftwareSigner {
    const { publicKey, sign } = p256FromSecret(secret);

    return new SoftwareSigner({ alg: 'p256', publicKey, sign }, null);
  }

  /**
   * The same identity with a post-quantum key attached. `seed` makes it reproducible; without one a
   * fresh key is generated. `deterministic` turns off ML-DSA's hedged randomness (tests only).
   */
  withMlDsa(
    alg: MlDsaAlg = 'ml-dsa-65',
    options: { seed?: Uint8Array; deterministic?: boolean } = {},
  ): SoftwareSigner {
    const { publicKey, sign } = mlDsaFromSeed(alg, options.seed ?? randomBytes(32), {
      deterministic: options.deterministic,
    });

    return new SoftwareSigner(this.classical, { alg, publicKey, sign });
  }

  classicalPublicKey(): ClassicalPublicKey {
    return classicalPublicKey(this.classical.alg, this.classical.publicKey);
  }

  async signClassical(payload: Uint8Array): Promise<ClassicalSignature> {
    return classicalSignature(this.classical.alg, this.classical.sign(payload));
  }

  pqPublicKey(): PqPublicKey | null {
    return this.pq === null ? null : pqPublicKey(this.pq.alg, this.pq.publicKey);
  }

  async signPq(payload: Uint8Array): Promise<PqSignature | null> {
    return this.pq === null ? null : pqSignature(this.pq.alg, this.pq.sign(payload));
  }
}
