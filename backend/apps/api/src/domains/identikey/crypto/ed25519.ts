import { createPrivateKey, createPublicKey, sign as nodeSign, verify as nodeVerify } from 'node:crypto';

/**
 * Ed25519 over raw 32-byte keys and 64-byte signatures, as IdentiKey puts them on the wire.
 *
 * Signing and verifying are `node:crypto`'s; what this file adds is the STRICT VERIFICATION the Rust
 * reference gets from `ed25519-dalek`'s `verify_strict`, which OpenSSL does not do on its own:
 *
 *   * a SMALL-ORDER public key is refused. With the identity as `A`, the signature (R = B, S = 1)
 *     verifies for EVERY message under the plain equation, so the "identity" that key names is one
 *     anybody can sign for. OpenSSL accepts it; `ed25519.spec.ts` builds the forgery and shows it.
 *   * a SMALL-ORDER `R` is refused, even under an honest key: the signer can pick R = identity and
 *     S = k·a, which satisfies the plain equation. That makes a second valid signature for a message
 *     that `verify_strict` signers never produce. OpenSSL accepts that too (also shown in the spec).
 *   * a signature whose `S` is not reduced (`S >= L`) is refused. OpenSSL 3.x already does this, so
 *     here it is belt and braces; it is the one check the spec cannot isolate.
 *   * a public key whose `y` is not canonical (`y >= p`), or that is not on the curve, is refused. Two
 *     byte strings for one point would be two fingerprints for one key. This is STRICTER than the
 *     reference, which reduces `y`; honest signers never produce a non-canonical key.
 */

const P = (1n << 255n) - 19n;
/** The order of the prime-order subgroup. */
const L = (1n << 252n) + 27742317777372353535851937790883648493n;
const Y_MASK = (1n << 255n) - 1n;

/** DER prefixes that wrap a raw 32-byte key as SPKI / PKCS#8 for Node. */
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

export const ED25519_KEY_LENGTH = 32;
export const ED25519_SIGNATURE_LENGTH = 64;

function leToBigInt(bytes: Uint8Array): bigint {
  let n = 0n;
  for (let i = bytes.length - 1; i >= 0; i -= 1) {
    n = (n << 8n) | BigInt(bytes[i]);
  }

  return n;
}

/**
 * The `y` coordinates of the eight points of order dividing 8. Points with the same `y` differ only
 * in the sign of `x`, so the sign bit never matters here:
 *
 *   y = 1    the identity            y = p - 1   order 2        y = 0   order 4 (two points)
 *   y = ORDER8_Y and y = p - ORDER8_Y   order 8 (two points each)
 *
 * ORDER8_Y is the first order-8 encoding from libsodium's well-known blocklist; its negation is the
 * second, which the spec checks.
 */
export const ORDER8_Y = leToBigInt(
  Buffer.from('26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05', 'hex'),
);
const SMALL_ORDER_Y: ReadonlySet<bigint> = new Set([0n, 1n, P - 1n, ORDER8_Y, P - ORDER8_Y]);

/** Whether `encoded` spells a point of small order, in ANY encoding of it (canonical or not). */
export function isSmallOrderPoint(encoded: Uint8Array): boolean {
  const y = leToBigInt(encoded) & Y_MASK;

  return SMALL_ORDER_Y.has(y % P);
}

/** Whether `encoded`'s `y` is below the field prime. */
function isCanonicalY(encoded: Uint8Array): boolean {
  return (leToBigInt(encoded) & Y_MASK) < P;
}

function modPow(base: bigint, exponent: bigint, modulus: bigint): bigint {
  let result = 1n;
  let b = base % modulus;
  let e = exponent;
  while (e > 0n) {
    if ((e & 1n) === 1n) {
      result = (result * b) % modulus;
    }

    b = (b * b) % modulus;
    e >>= 1n;
  }

  return result;
}

/** The curve constant d = -121665 / 121666 (mod p). */
const D = ((P - 121665n) * modPow(121666n, P - 2n, P)) % P;

/**
 * Whether `encoded`'s `y` is the y-coordinate of a point on the curve. A point exists iff
 * x² = (y² - 1) / (d·y² + 1) has a square root; u/v is a square exactly when u·v is, which saves the
 * inversion. (Node's `createPublicKey` does not check this at import time, only at verify time.)
 */
function isOnCurve(encoded: Uint8Array): boolean {
  const y = (leToBigInt(encoded) & Y_MASK) % P;
  const y2 = (y * y) % P;
  const u = (y2 + P - 1n) % P;
  const v = (D * y2 + 1n) % P;
  const w = (u * v) % P;

  return w === 0n || modPow(w, (P - 1n) / 2n, P) === 1n;
}

/** Strictly verify `signature` over `message` under the raw public key. Never throws. */
export function verifyEd25519(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  if (publicKey.length !== ED25519_KEY_LENGTH || signature.length !== ED25519_SIGNATURE_LENGTH) {
    return false;
  }

  if (!isCanonicalY(publicKey) || isSmallOrderPoint(publicKey)) {
    return false;
  }

  const r = signature.subarray(0, 32);
  const s = signature.subarray(32);
  if (isSmallOrderPoint(r) || leToBigInt(s) >= L) {
    return false;
  }

  try {
    const key = createPublicKey({
      key: Buffer.concat([SPKI_PREFIX, publicKey]),
      format: 'der',
      type: 'spki',
    });

    return nodeVerify(null, message, key, signature);
  } catch {
    return false;
  }
}

/**
 * Whether `publicKey` is a key this module would ever verify under: 32 bytes, a canonical `y`, on the
 * curve, and not of small order. No signature needed.
 */
export function isUsableEd25519Key(publicKey: Uint8Array): boolean {
  return (
    publicKey.length === ED25519_KEY_LENGTH &&
    isCanonicalY(publicKey) &&
    !isSmallOrderPoint(publicKey) &&
    isOnCurve(publicKey)
  );
}

/** An Ed25519 key pair rebuilt from its 32-byte seed (RFC 8032 §5.1.5). */
export function ed25519FromSeed(seed: Uint8Array): {
  publicKey: Uint8Array;
  sign: (message: Uint8Array) => Uint8Array;
} {
  if (seed.length !== 32) {
    throw new RangeError('an Ed25519 seed is 32 bytes');
  }

  const privateKey = createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, seed]),
    format: 'der',
    type: 'pkcs8',
  });
  const jwk = createPublicKey(privateKey).export({ format: 'jwk' });

  return {
    publicKey: new Uint8Array(Buffer.from(jwk.x as string, 'base64url')),
    sign: (message) => new Uint8Array(nodeSign(null, message, privateKey)),
  };
}
