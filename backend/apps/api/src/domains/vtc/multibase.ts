/**
 * The two Multibase encodings this module reads and writes, and nothing else.
 *
 *   - `z` + base58btc: Ed25519 public keys (`z6Mk…`) and Data Integrity `proofValue`s.
 *   - `u` + base64url without padding: the GZIP-compressed `encodedList` of a status list.
 *
 * Every decoder takes ONE prefix and refuses the rest. A general Multibase decoder would let a
 * peer choose the encoding of a field whose encoding the profile fixes; two spellings of one
 * value is how a signature over one thing gets accepted for another.
 */

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Longest base58btc text accepted: the longest thing decoded here is a 64-byte signature. */
const MAX_BASE58_CHARS = 512;

const DIGIT_OF = new Map<string, number>([...ALPHABET].map((char, index) => [char, index]));

const BASE64URL = /^[A-Za-z0-9_-]*$/;

export class MultibaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MultibaseError';
  }
}

export function base58btcEncode(bytes: Uint8Array): string {
  let leadingZeros = 0;
  while (leadingZeros < bytes.length && bytes[leadingZeros] === 0) {
    leadingZeros += 1;
  }

  let value = 0n;
  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte);
  }

  let digits = '';
  while (value > 0n) {
    digits = ALPHABET[Number(value % 58n)] + digits;
    value /= 58n;
  }

  return '1'.repeat(leadingZeros) + digits;
}

export function base58btcDecode(text: string): Uint8Array {
  if (text.length > MAX_BASE58_CHARS) {
    throw new MultibaseError('base58btc text is too long');
  }

  let leadingZeros = 0;
  while (leadingZeros < text.length && text[leadingZeros] === '1') {
    leadingZeros += 1;
  }

  let value = 0n;
  for (const char of text) {
    const digit = DIGIT_OF.get(char);
    if (digit === undefined) {
      throw new MultibaseError('not base58btc');
    }

    value = value * 58n + BigInt(digit);
  }

  const hex = value === 0n ? '' : value.toString(16);
  const body = Buffer.from(hex.length % 2 === 1 ? `0${hex}` : hex, 'hex');

  return Buffer.concat([Buffer.alloc(leadingZeros), body]);
}

export function encodeMultibaseBase58btc(bytes: Uint8Array): string {
  return `z${base58btcEncode(bytes)}`;
}

export function decodeMultibaseBase58btc(text: string): Uint8Array {
  if (!text.startsWith('z')) {
    throw new MultibaseError('expected a multibase base58btc value (prefix z)');
  }

  return base58btcDecode(text.slice(1));
}

export function encodeMultibaseBase64url(bytes: Uint8Array): string {
  return `u${Buffer.from(bytes).toString('base64url')}`;
}

export function decodeMultibaseBase64url(text: string): Uint8Array {
  if (!text.startsWith('u')) {
    throw new MultibaseError('expected a multibase base64url value (prefix u)');
  }

  const body = text.slice(1);
  if (!BASE64URL.test(body)) {
    throw new MultibaseError('not base64url');
  }

  const bytes = Buffer.from(body, 'base64url');
  // Rejects a length of 1 mod 4 and trailing bits that are not zero: two spellings of one value.
  if (bytes.toString('base64url') !== body) {
    throw new MultibaseError('base64url is not in its canonical form');
  }

  return bytes;
}
