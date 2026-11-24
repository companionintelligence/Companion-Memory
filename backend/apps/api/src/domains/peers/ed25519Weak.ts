/**
 * Ed25519 public keys that must never name a peer: the points of small order, and the non-canonical
 * spellings of points.
 *
 * ═══ WHY AN IDENTIFIER THAT IS THE KEY NEEDS THIS ═══
 *
 * A self-certifying identifier (`did:key`, `did:keri:D<x>`) is trusted because only the holder of the
 * private key can sign under it. That is false for the points of small order: RFC 8032 verification of
 * the identity point accepts the signature `R = identity, S = 0` for EVERY message, and the points of
 * order 2, 4 and 8 accept signatures after at most a few tries. OpenSSL (and so Node) accepts all of
 * them, and the 32-byte encodings of these points, and their non-canonical spellings, are valid
 * `did:key` strings. An identifier of that kind names no one: anyone can sign as it.
 *
 * ═══ WHAT IS REFUSED: 48 ENCODINGS, FOR TWO DIFFERENT REASONS ═══
 *
 * Reading the 32 bytes as RFC 8032 does (little-endian, bit 255 is the sign of x, the other 255 bits
 * are y):
 *
 *   1. The points of small order, which a signature can be made for WITHOUT a private key:
 *      y in {0, 1, p - 1} (the points of order 4, 1 and 2) and y in {y8, p - y8} (order 8), at either
 *      sign. That is 10 encodings. `y8` is the value on libsodium's small-order blocklist
 *      (`26e8958f...fc05`, little-endian).
 *   2. A non-canonical y: y >= p, where p = 2^255 - 19, so y = p to p + 18 at either sign. That is 38
 *      encodings, each a second spelling of y = 0 to 18, and one key must have one spelling. Only 12
 *      of those 19 y values are a point at all (the other 7 spell nothing). Four of the 38 are also
 *      forgeable: y = p and y = p + 1 (spellings of y = 0 and y = 1), at either sign.
 *
 * That needs no curve arithmetic. The spec enumerates all 48 and refuses every one, and none of the
 * genuine keys tried (RFC 8032 test 1, the did:key specification example, the KERI reference key, a
 * Local.Pub service key, 3,000 random keys). The small-order set was derived from Edwards25519
 * arithmetic written independently of this file.
 *
 * ═══ WHAT IS NOT CHECKED ═══
 *
 * That the point lies in the prime-order subgroup (a key chosen with a small-order component gains only
 * the ability to be signed for by its own chooser; it does not let anyone sign as a key they do not
 * hold), and, here, that it is a point at all: `ed25519Curve.ts` answers that. The `did:key` codec asks
 * both questions. `sovereignKeyId.ts` asks only the weak-key one (added with `did:key`; before this
 * change it checked only the length and the canonical base64url spelling): a `did:keri:D<x>` that is
 * not a point is accepted, as it always was, and can never verify a signature.
 *
 * Pure: no I/O, no clock, no config.
 */

/** p = 2^255 - 19, the field prime of Curve25519. */
const FIELD_PRIME = (1n << 255n) - 19n;

/** y of the two points of order 8: libsodium's blocklist entry, and its negation modulo p. */
const ORDER_8_Y = littleEndian(
  Buffer.from('26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05', 'hex'),
);

const SMALL_ORDER_Y: ReadonlySet<bigint> = new Set([
  0n,
  1n,
  FIELD_PRIME - 1n,
  ORDER_8_Y,
  FIELD_PRIME - ORDER_8_Y,
]);

/** Whether a 32-byte Ed25519 public key is a small-order point or a non-canonical encoding. Any other length is weak. */
export function isWeakEd25519PublicKey(key: Uint8Array): boolean {
  if (!(key instanceof Uint8Array) || key.length !== 32) {
    return true;
  }

  // Bit 255 is the sign of x; y is the other 255 bits.
  const bytes = Uint8Array.from(key);
  bytes[31] &= 0x7f;
  const y = littleEndian(bytes);

  return y >= FIELD_PRIME || SMALL_ORDER_Y.has(y);
}

function littleEndian(bytes: Uint8Array): bigint {
  let value = 0n;
  for (let i = bytes.length - 1; i >= 0; i -= 1) {
    value = (value << 8n) | BigInt(bytes[i]);
  }

  return value;
}
