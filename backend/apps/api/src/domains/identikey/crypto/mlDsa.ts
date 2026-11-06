import { randomBytes } from 'node:crypto';

import { ml_dsa44, ml_dsa65, ml_dsa87 } from '@noble/post-quantum/ml-dsa.js';

/**
 * ML-DSA (FIPS 204) verification and, for software custody and tests, key generation and signing.
 *
 * ═══ WHICH IMPLEMENTATION, AND WHY NOT NODE'S ═══
 *
 * `@noble/post-quantum`, pinned to 0.4.1. Node's own ML-DSA arrived after the Node 22 this repo's
 * `.nvmrc` and CI use (22.23 throws on `generateKeyPairSync('ml-dsa-65')`), while the API image ships
 * a newer Node; relying on the native one would make behaviour depend on which Node ran the code. noble
 * is the same everywhere.
 *
 * 0.4.1 is the last release that is both CommonJS and built on `@noble/hashes` 1.x, which is what a
 * CommonJS NestJS app under jest needs. 0.5 and later are ESM-only: do not accept a bump to them
 * without moving the app or the test runner to ESM first.
 *
 * ═══ THE MODE ═══
 *
 * FIPS 204 "pure" signing with an EMPTY context string, M' = 0x00 || 0x00 || M. That is what the Rust
 * crates do (`fips204`, `try_sign(msg, &[])` and `verify(msg, sig, &[])`), and identikey's
 * `pq-and-wasm.md` records that the `*_internal` entry points, which skip the domain separator, fail
 * its golden vectors.
 *
 * ═══ A TRAP IN THE LIBRARY'S TYPES ═══
 *
 * noble 0.4.1's RUNTIME signatures are
 *
 *     sign(secretKey, message, context = EMPTY, random?)      verify(publicKey, message, signature, context = EMPTY)
 *
 * but its `.d.ts` declares `sign(secretKey, message, random?)`. Following the types, a caller who
 * passes fresh randomness as the third argument hands it over as the CONTEXT, and produces signatures
 * that only verify under that context: a Rust verifier (empty context) rejects every one. The same
 * library also signs DETERMINISTICALLY unless `random` is passed. So this file describes the runtime
 * API itself, passes an explicit empty context everywhere, and supplies the randomness explicitly;
 * `mlDsa.spec.ts` pins all three behaviours.
 *
 * Interop was checked against an independent FIPS 204 implementation (see the spec's third-party
 * vectors), NOT against Rust-made ML-DSA bytes: upstream commits no ML-DSA fixture. See docs/identikey.md.
 */

export type MlDsaAlg = 'ml-dsa-44' | 'ml-dsa-65' | 'ml-dsa-87';

/** What noble actually does at runtime, which is not what its `.d.ts` says (see above). */
interface NobleMlDsa {
  keygen(seed: Uint8Array): { publicKey: Uint8Array; secretKey: Uint8Array };
  sign(secretKey: Uint8Array, message: Uint8Array, context: Uint8Array, random?: Uint8Array): Uint8Array;
  verify(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array, context: Uint8Array): boolean;
}

interface Params {
  readonly impl: NobleMlDsa;
  readonly publicKey: number;
  readonly signature: number;
}

/** Byte lengths from FIPS 204 Table 2. They are checked BEFORE the implementation is called. */
export const ML_DSA: Readonly<Record<MlDsaAlg, Params>> = {
  'ml-dsa-44': { impl: ml_dsa44 as unknown as NobleMlDsa, publicKey: 1312, signature: 2420 },
  'ml-dsa-65': { impl: ml_dsa65 as unknown as NobleMlDsa, publicKey: 1952, signature: 3309 },
  'ml-dsa-87': { impl: ml_dsa87 as unknown as NobleMlDsa, publicKey: 2592, signature: 4627 },
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
    return params.impl.verify(publicKey, message, signature, NO_CONTEXT);
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
    // the deterministic variant, which is for reproducible tests. Without a `random` argument noble
    // would silently sign deterministically.
    sign: (message) =>
      impl.sign(secretKey, message, NO_CONTEXT, options.deterministic ? undefined : randomBytes(32)),
  };
}
