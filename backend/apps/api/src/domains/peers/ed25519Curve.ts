/**
 * Whether 32 bytes are the encoding of a point on the Ed25519 curve.
 *
 * ═══ WHY A `did:key` CHECKS THIS ═══
 *
 * About half of all 32-byte strings are NOT points on the curve. A key that is not can never verify a
 * signature, so accepting one is harmless to security. It matters to the person typing: a `did:key`
 * with a wrong character decodes to nothing about half the time, and stored it would be a peer link
 * that looks bound and can never match an ask; refusing it turns that into an error message.
 *
 * It catches SOME slips, not all. The other half decode to a different valid key that nobody holds
 * (46% of single-character substitutions, measured), so the owner still compares the whole key with
 * the person, or checks that the first signed ask arrives.
 *
 * ═══ HOW ═══
 *
 * RFC 8032 section 5.1.3, read the way the RFC reads it: the bytes are little-endian, bit 255 is the
 * sign of x and the other 255 bits are y. With p = 2^255 - 19 and d = -121665/121666 the curve is
 * -x^2 + y^2 = 1 + d x^2 y^2, so a point with this y exists iff
 *
 *   x^2 = (y^2 - 1) / (d y^2 + 1)  (mod p)
 *
 * is a square, which Euler's criterion decides: x^2 is a nonzero square iff x^2^((p-1)/2) = 1 (mod p).
 * Zero is a square too, but then x = 0 and the sign bit must be 0 (the RFC refuses "negative zero").
 * A y >= p is refused: the RFC does not decode a non-canonical y.
 *
 * Checked against the RFC's own decoding (the (p+3)/8 square-root method, a different algorithm) in
 * Python on 131 encodings: the edge cases around every small-order y, the 19 non-canonical y's and
 * 80 random strings (the spec carries 63 of them), and on 1,000 keys Node generated, all on the curve
 * (the spec generates 300).
 *
 * This is NOT a weak-key check (see `ed25519Weak.ts`, which a small-order point passes here, as it is
 * on the curve) and NOT a subgroup check (a point with a small-order component is a point).
 *
 * Pure: no I/O, no clock, no config. A few hundred microseconds of BigInt arithmetic.
 */

/** p = 2^255 - 19, the field prime of Curve25519. */
const FIELD_PRIME = (1n << 255n) - 19n;

const Y_MASK = (1n << 255n) - 1n;

/** d = -121665 / 121666 (mod p). */
const CURVE_D = ((FIELD_PRIME - 121665n) * modPow(121666n, FIELD_PRIME - 2n)) % FIELD_PRIME;

/** Whether `key` is 32 bytes that decode to a point on the Ed25519 curve. Any other input is not. */
export function isEd25519CurvePoint(key: Uint8Array): boolean {
  if (!(key instanceof Uint8Array) || key.length !== 32) {
    return false;
  }

  let value = 0n;
  for (let i = 31; i >= 0; i -= 1) {
    value = (value << 8n) | BigInt(key[i]);
  }

  const negative = value >> 255n === 1n;
  const y = value & Y_MASK;
  if (y >= FIELD_PRIME) {
    return false;
  }

  const ySquared = (y * y) % FIELD_PRIME;
  const numerator = (ySquared + FIELD_PRIME - 1n) % FIELD_PRIME;
  const denominator = (CURVE_D * ySquared + 1n) % FIELD_PRIME;
  if (denominator === 0n) {
    return false;
  }

  const xSquared = (numerator * modPow(denominator, FIELD_PRIME - 2n)) % FIELD_PRIME;
  if (xSquared === 0n) {
    return !negative;
  }

  return modPow(xSquared, (FIELD_PRIME - 1n) / 2n) === 1n;
}

/** `base ** exponent mod p`, by square and multiply. */
function modPow(base: bigint, exponent: bigint): bigint {
  let result = 1n;
  let square = base % FIELD_PRIME;
  for (let rest = exponent; rest > 0n; rest >>= 1n) {
    if ((rest & 1n) === 1n) {
      result = (result * square) % FIELD_PRIME;
    }

    square = (square * square) % FIELD_PRIME;
  }

  return result;
}
