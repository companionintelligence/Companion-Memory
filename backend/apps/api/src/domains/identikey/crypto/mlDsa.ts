import { randomBytes } from 'node:crypto';

import { ml_dsa44, ml_dsa65, ml_dsa87 } from '@noble/post-quantum/ml-dsa.js';

/**
 * ML-DSA (FIPS 204) verification and, for software custody and tests, key generation and signing.
 *
 * ═══ WHICH IMPLEMENTATION, AND WHY NOT NODE'S ═══
 *
 * `@noble/post-quantum` 0.7. Node's own ML-DSA arrived after the Node 22 this repo's `.nvmrc` and CI
 * use (22.23 throws on `generateKeyPairSync('ml-dsa-65')`), while the API image ships a newer Node;
 * relying on the native one would make behavior depend on which Node ran the code. noble is the same
 * everywhere.
 *
 * noble 0.5 and later, and the `@noble/hashes` 2 and `@noble/curves` 2 it builds on, are ESM-only. The
 * compiled CommonJS app loads them through Node's `require(esm)` (on by default since Node 22.12), and
 * jest transforms them: they are listed in `transformIgnorePatterns` in `jest.config.mjs`.
 *
 * ═══ THE MODE ═══
 *
 * FIPS 204 "pure" signing with an EMPTY context string, M' = 0x00 || 0x00 || M. That is what the Rust
 * crates do (`fips204`, `try_sign(msg, &[])` and `verify(msg, sig, &[])`), and identikey's
 * `pq-and-wasm.md` records that the `*_internal` entry points, which skip the domain separator, fail
 * its golden vectors.
 *
 * ═══ THE CALLS ═══
 *
 *     sign(message, secretKey, { context, extraEntropy })      verify(signature, message, publicKey, { context })
 *
 * The order changed in 0.5: 0.4 took `sign(secretKey, message, context, random)` and
 * `verify(publicKey, message, signature, context)`. Both calls here pass the empty context explicitly.
 * Signing is hedged (32 fresh random bytes) unless the caller asks for the deterministic variant, which
 * is `extraEntropy: false`. `mlDsa.spec.ts` pins the mode, the determinism and the third-party vectors.
 *
 * Interop was checked against an independent FIPS 204 implementation (see the spec's third-party
 * vectors), NOT against Rust-made ML-DSA bytes: upstream commits no ML-DSA fixture. See docs/identikey.md.
 */

export type MlDsaAlg = 'ml-dsa-44' | 'ml-dsa-65' | 'ml-dsa-87';

/** The part of noble's ML-DSA API this file uses (see THE CALLS above). */
interface NobleMlDsa {
  keygen(seed: Uint8Array): { publicKey: Uint8Array; secretKey: Uint8Array };
  sign(
    message: Uint8Array,
    secretKey: Uint8Array,
    opts: { context: Uint8Array; extraEntropy: Uint8Array | false },
  ): Uint8Array;
  verify(
    signature: Uint8Array,
    message: Uint8Array,
    publicKey: Uint8Array,
    opts: { context: Uint8Array },
  ): boolean;
}

interface Params {
  readonly impl: NobleMlDsa;
  readonly publicKey: number;
  readonly signature: number;
}

/** Byte lengths from FIPS 204 Table 2. They are checked BEFORE the implementation is called. */
export const ML_DSA: Readonly<Record<MlDsaAlg, Params>> = {
  'ml-dsa-44': { impl: ml_dsa44, publicKey: 1312, signature: 2420 },
  'ml-dsa-65': { impl: ml_dsa65, publicKey: 1952, signature: 3309 },
  'ml-dsa-87': { impl: ml_dsa87, publicKey: 2592, signature: 4627 },
};

/** The one context IdentiKey uses: none. */
const NO_CONTEXT = new Uint8Array(0);

/** Verify under the pure, empty-context mode. Wrong lengths and malformed input are `false`, never a throw. */
export function verifyMlDsa(
  alg: MlDsaAlg,
  publicKey: Uint8Array,
  message: Uint8Array,
  signature: Uint8Array,
): boolean {
  const params = ML_DSA[alg];
  if (publicKey.length !== params.publicKey || signature.length !== params.signature) {
    return false;
  }

  try {
    return params.impl.verify(signature, message, publicKey, { context: NO_CONTEXT });
  } catch {
    return false;
  }
}

/** A key pair from a 32-byte seed (FIPS 204 `ML-DSA.KeyGen_internal`'s ξ). */
export function mlDsaFromSeed(
  alg: MlDsaAlg,
  seed: Uint8Array,
  options: { deterministic?: boolean } = {},
): { publicKey: Uint8Array; sign: (message: Uint8Array) => Uint8Array } {
  if (seed.length !== 32) {
    throw new RangeError('an ML-DSA seed is 32 bytes');
  }

  const { impl } = ML_DSA[alg];
  const { publicKey, secretKey } = impl.keygen(seed);

  return {
    publicKey,
    // HEDGED signing (32 fresh random bytes mixed in, FIPS 204's default) unless the caller asks for
    // the deterministic variant, which is for reproducible tests.
    sign: (message) =>
      impl.sign(message, secretKey, {
        context: NO_CONTEXT,
        extraEntropy: options.deterministic ? false : randomBytes(32),
      }),
  };
}
