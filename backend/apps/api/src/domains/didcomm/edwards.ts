import { createHash } from 'node:crypto';

import { DidcommError } from './errors';

/**
 * Ed25519 → X25519 (Edwards → Montgomery) conversion.
 *
 * A `did:key` made from an Ed25519 key advertises an X25519 key-agreement key derived from it, and
 * a `did:peer`/`did:key` identity that signs with Ed25519 and decrypts with X25519 relies on the
 * same map. Node's `crypto` has no API for it, so it is done here with `BigInt`, and it is pinned in
 * `edwards.spec.ts` to two independent properties: the converted public key equals the public key
 * of the converted secret, and two parties converted this way agree on a Diffie-Hellman secret.
 *
 * The map is `u = (1 + y) / (1 − y) mod p` on the public key (RFC 7748 §4.1) and, on the secret
 * side, the clamped first half of `SHA-512(seed)` (RFC 8032 §5.1.5, which is exactly the scalar
 * Ed25519 itself uses).
 */

const P = (1n << 255n) - 19n;
/** The Edwards curve constant d = −121665 / 121666 mod p. */
const D = mod(-121665n * modInverse(121666n));

/**
 * u-coordinates of the points of order dividing 8 on Curve25519, in canonical form. A converted key
 * landing on one of them would give every peer the same Diffie-Hellman secret.
 */
const LOW_ORDER_U = new Set<bigint>([
  0n,
  1n,
  // The two order-8 values, the u of P − ORDER_8_Y and of ORDER_8_Y; libsodium's blocklist lists both.
  325606250916557431795983626356110631294008115727848805560023387167927233504n,
  39382357235489614581723060781553021112529911719440698176882885853963445705823n,
  P - 1n,
]);

/** y of the points of order 8: libsodium's blocklist entry, read little-endian. The other is P − ORDER_8_Y. */
const ORDER_8_Y = readLittleEndian(
  Buffer.from('26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05', 'hex'),
);

/** y of the eight points of order dividing 8: the identity (1), order 2 (P − 1), order 4 (0) and order 8. */
const SMALL_ORDER_Y: ReadonlySet<bigint> = new Set([0n, 1n, P - 1n, ORDER_8_Y, P - ORDER_8_Y]);

function mod(value: bigint): bigint {
  const result = value % P;
  return result >= 0n ? result : result + P;
}

function modPow(base: bigint, exponent: bigint): bigint {
  let result = 1n;
  let b = mod(base);
  let e = exponent;

  while (e > 0n) {
    if (e & 1n) {
      result = mod(result * b);
    }

    b = mod(b * b);
    e >>= 1n;
  }

  return result;
}

function modInverse(value: bigint): bigint {
  return modPow(value, P - 2n);
}

function readLittleEndian(bytes: Uint8Array): bigint {
  let value = 0n;

  for (let index = bytes.length - 1; index >= 0; index -= 1) {
    value = (value << 8n) | BigInt(bytes[index]);
  }

  return value;
}

function writeLittleEndian(value: bigint, length: number): Buffer {
  const out = Buffer.alloc(length);
  let rest = value;

  for (let index = 0; index < length; index += 1) {
    out[index] = Number(rest & 0xffn);
    rest >>= 8n;
  }

  return out;
}

/** True when `y` is the y-coordinate of a point on edwards25519 (x² = (y² − 1)/(d·y² + 1) has a root). */
function isOnCurve(y: bigint): boolean {
  const y2 = mod(y * y);
  const denominator = mod(D * y2 + 1n);

  if (denominator === 0n) {
    return false;
  }

  const x2 = mod((y2 - 1n) * modInverse(denominator));

  return x2 === 0n || modPow(x2, (P - 1n) / 2n) === 1n;
}

/**
 * Whether a raw Ed25519 public key is a point of small order or a non-canonical encoding (y ≥ p),
 * reading the 32 bytes as RFC 8032 does: little-endian, bit 255 the sign of x. Any other length is weak.
 *
 * A signature can be made for a small-order key without its private key, so such a key names no one,
 * and a non-canonical encoding is a second spelling of a key. This is the y-value test of
 * `peers/ed25519Weak.ts` (the same 48 encodings), copied because the dependency rules keep this
 * domain from importing another domain's internals. It needs no curve arithmetic, and it does not ask
 * whether the key is on the curve, since an off-curve key verifies no signature.
 */
export function isWeakEd25519PublicKey(key: Uint8Array): boolean {
  if (!(key instanceof Uint8Array) || key.length !== 32) {
    return true;
  }

  const encoded = Buffer.from(key);
  // The top bit is the sign of x; y is the other 255 bits.
  encoded[31] &= 0x7f;
  const y = readLittleEndian(encoded);

  return y >= P || SMALL_ORDER_Y.has(y);
}

/**
 * The X25519 public key (32 bytes, little-endian u) for a raw Ed25519 public key. Refuses a key
 * whose y is not canonical, is not on the curve, or maps to a small-order point.
 */
export function ed25519PublicKeyToX25519(ed25519Public: Uint8Array): Buffer {
  if (ed25519Public.length !== 32) {
    throw new DidcommError('invalid-key', 'an Ed25519 public key is 32 bytes');
  }

  const encoded = Buffer.from(ed25519Public);
  // The top bit is the sign of x, which the Montgomery u-coordinate does not use.
  encoded[31] &= 0x7f;

  const y = readLittleEndian(encoded);

  if (y >= P) {
    throw new DidcommError('invalid-key', 'Ed25519 public key is not a canonical point encoding');
  }

  if (!isOnCurve(y)) {
    throw new DidcommError('invalid-key', 'Ed25519 public key is not a point on the curve');
  }

  const denominator = mod(1n - y);

  if (denominator === 0n) {
    throw new DidcommError('invalid-key', 'Ed25519 public key has small order');
  }

  const u = mod((1n + y) * modInverse(denominator));

  if (LOW_ORDER_U.has(u)) {
    throw new DidcommError('invalid-key', 'Ed25519 public key has small order');
  }

  return writeLittleEndian(u, 32);
}

/** The X25519 secret scalar (32 bytes, clamped) for an Ed25519 private seed. */
export function ed25519SeedToX25519Secret(seed: Uint8Array): Buffer {
  if (seed.length !== 32) {
    throw new DidcommError('invalid-key', 'an Ed25519 seed is 32 bytes');
  }

  const scalar = Buffer.from(createHash('sha512').update(seed).digest().subarray(0, 32));
  scalar[0] &= 248;
  scalar[31] &= 127;
  scalar[31] |= 64;

  return scalar;
}
