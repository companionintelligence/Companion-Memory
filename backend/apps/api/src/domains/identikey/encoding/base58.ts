import { IdentiKeyError } from '../errors';

/**
 * Bitcoin-alphabet base58, the text form IdentiKey uses for short stable identifiers (fingerprints,
 * public keys) that a person might read aloud or compare by eye.
 *
 * ═══ BOUNDED ON PURPOSE ═══
 *
 * Base58 is quadratic in the input length. IdentiKey's encoding conventions (`encoding-conventions.md`
 * §5.1.1) therefore say it must be exposed only through a function that REFUSES large input, with no
 * unchecked escape hatch: an unbounded decode on a path an anonymous caller can reach is a
 * denial-of-service, and prose did not stop the reference implementation from hitting that three times.
 * Anything over {@link BASE58_MAX_BYTES} is base64 (see `tagged.ts`).
 *
 * The alphabet has no `0`, `O`, `I` or `l`; a leading zero byte is a leading `1`; there is no version
 * byte and no checksum. Every byte string has exactly one encoding and every string over the alphabet
 * exactly one decoding, so unlike base64 there is no non-canonical form to police.
 */
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

const INDEX = new Map<string, number>([...ALPHABET].map((char, i) => [char, i]));

/** The largest input, in bytes, this module will encode or decode. */
export const BASE58_MAX_BYTES = 256;

/**
 * The longest text this module will decode. The longest legitimate one is 350 characters (256 bytes
 * of 0xff); the extra character is slack, and the spec pins the 350.
 */
export const BASE58_MAX_CHARS = 351;

export function base58Encode(bytes: Uint8Array): string {
  if (bytes.length > BASE58_MAX_BYTES) {
    throw new IdentiKeyError(
      'malformed',
      `base58 refuses input over ${BASE58_MAX_BYTES} bytes (${bytes.length} given); use base64`,
    );
  }

  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) {
    zeros += 1;
  }

  // Little-endian base-58 digits of the big-endian integer the bytes spell.
  const digits: number[] = [];
  for (let i = zeros; i < bytes.length; i += 1) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j += 1) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = Math.floor(carry / 58);
    }

    while (carry > 0) {
      digits.push(carry % 58);
      carry = Math.floor(carry / 58);
    }
  }

  let out = '1'.repeat(zeros);
  for (let k = digits.length - 1; k >= 0; k -= 1) {
    out += ALPHABET[digits[k]];
  }

  return out;
}

export function base58Decode(text: string): Uint8Array {
  if (text.length > BASE58_MAX_CHARS) {
    throw new IdentiKeyError('malformed', `base58 refuses input over ${BASE58_MAX_CHARS} characters`);
  }

  let zeros = 0;
  while (zeros < text.length && text[zeros] === '1') {
    zeros += 1;
  }

  // Little-endian base-256 digits.
  const bytes: number[] = [];
  for (let i = zeros; i < text.length; i += 1) {
    const value = INDEX.get(text[i]);
    if (value === undefined) {
      throw new IdentiKeyError('malformed', 'not a base58 string');
    }

    let carry = value;
    for (let j = 0; j < bytes.length; j += 1) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }

    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }

  const out = new Uint8Array(zeros + bytes.length);
  out.set(bytes.reverse(), zeros);

  if (out.length > BASE58_MAX_BYTES) {
    throw new IdentiKeyError('malformed', `base58 decodes to more than ${BASE58_MAX_BYTES} bytes`);
  }

  return out;
}
