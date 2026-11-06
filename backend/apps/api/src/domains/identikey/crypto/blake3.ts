import { blake3 } from '@noble/hashes/blake3.js';

/**
 * BLAKE3, which Node's `crypto` does not have. `@noble/hashes` 1.8.0 is audited, dependency-free, and
 * already in the lockfile transitively; the specification test (`blake3.spec.ts`) pins it to the
 * official BLAKE3 test vectors so a bad bump shows up as a failing test rather than a silent change of
 * everyone's fingerprint.
 *
 * Only the plain hash is used by the authentication tier. Keyed hashing and `derive_key` mode (the
 * sharing tier's key-wrap KDF) are added with the phase that uses them.
 */
export function blake3Hash(data: Uint8Array): Uint8Array {
  return blake3(data);
}
