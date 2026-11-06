/**
 * Which 32-byte strings may stand for an Ed25519 public key.
 *
 * A self-certifying identifier IS its key, so it is only as meaningful as the key is. Three kinds of
 * 32-byte string decode "fine" and are not keys anyone can be held to:
 *
 * - a NON-CANONICAL encoding (the y coordinate is not reduced modulo p), which gives one key two
 *   spellings, and so one peer two identifiers;
 * - a string that is NOT A POINT ON THE CURVE;
 * - a key of SMALL ORDER (the eight points whose order divides 8, including the all-zero string and
 *   the identity). Under such a key a signature can be produced WITHOUT any private key, so an
 *   identifier built from one would let anyone sign as it. `libsodium` refuses them for the same
 *   reason, and `peers/sovereignKeyId.ts` does not check, so this module is the stricter of the two:
 *   assurance may only tighten.
 *
 * The check is plain affine arithmetic on BigInt (decode, multiply by 8, compare with the identity).
 * It costs on the order of a millisecond, so callers run the cheap shape test first and this only for
 * identifiers that look like keys and are already linked.
 *
 * Mixed-order keys (a prime-order point plus a torsion component) are NOT refused: they cannot be used
 * to sign without the private key, and testing for them needs a full-width scalar multiplication.
 */

const P = (1n << 255n) - 19n;

function mod(value: bigint): bigint {
  const reduced = value % P;

  return reduced >= 0n ? reduced : reduced + P;
}

function modPow(base: bigint, exponent: bigint): bigint {
  let result = 1n;
  let factor = mod(base);
  let remaining = exponent;

  while (remaining > 0n) {
    if (remaining & 1n) {
      result = mod(result * factor);
    }

    factor = mod(factor * factor);
    remaining >>= 1n;
  }

  return result;
}

function modInverse(value: bigint): bigint {
  return modPow(value, P - 2n);
}

/** The curve constant d = -121665 / 121666 and a square root of -1, both mod p. */
const D = mod(-121665n * modInverse(121666n));
const SQRT_MINUS_ONE = modPow(2n, (P - 1n) / 4n);

type Point = readonly [bigint, bigint];

/** Addition on the twisted Edwards curve with a = -1. The formulas are complete for Ed25519. */
function add(left: Point, right: Point): Point {
  const [x1, y1] = left;
  const [x2, y2] = right;
  const dxy = mod(D * x1 * x2 * y1 * y2);

  return [mod((x1 * y2 + x2 * y1) * modInverse(1n + dxy)), mod((y1 * y2 + x1 * x2) * modInverse(1n - dxy))];
}

/** The affine point a canonical encoding names, or null when it is non-canonical or off the curve. */
function decode(encoded: Uint8Array): Point | null {
  if (encoded.length !== 32) {
    return null;
  }

  let y = 0n;
  for (let index = 31; index >= 0; index -= 1) {
    y = (y << 8n) | BigInt(encoded[index] ?? 0);
  }

  const sign = (y >> 255n) & 1n;
  y &= (1n << 255n) - 1n;

  if (y >= P) {
    return null;
  }

  const ySquared = mod(y * y);
  const numerator = mod(ySquared - 1n);
  const denominator = mod(D * ySquared + 1n);
  const xSquared = mod(numerator * modInverse(denominator));

  let x = modPow(xSquared, (P + 3n) / 8n);
  if (mod(x * x) !== xSquared) {
    x = mod(x * SQRT_MINUS_ONE);
  }

  if (mod(x * x) !== xSquared) {
    return null;
  }

  // x = 0 has one encoding; the "negative zero" with the sign bit set is not canonical.
  if (x === 0n && sign === 1n) {
    return null;
  }

  return [(x & 1n) === sign ? x : mod(P - x), y];
}

function hasSmallOrder(point: Point): boolean {
  let multiple = point;
  for (let doubling = 0; doubling < 3; doubling += 1) {
    multiple = add(multiple, multiple);
  }

  return multiple[0] === 0n && multiple[1] === 1n;
}

/** Whether `raw` is a canonical encoding of an Ed25519 point of order greater than 8. */
export function isUsableEd25519PublicKey(raw: Uint8Array): boolean {
  const point = decode(raw);

  return point !== null && !hasSmallOrder(point);
}
