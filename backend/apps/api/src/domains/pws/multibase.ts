import { createHash } from 'node:crypto';

/**
 * The byte-to-text encodings Portable Web Spaces uses, each strict.
 *
 *   - base58btc, for `did:key` fingerprints and `proofValue`. `multibase.spec.ts` pins it to the Bitcoin Core
 *     `base58_encode_decode.json` vectors;
 *   - base64url without padding, for the `Digest: mh=u...` header and the embedded `capability` of a
 *     `Capability-Invocation` header (RFC 4648 §5);
 *   - base64 with padding, for the `signature` parameter of an HTTP signature (RFC 4648 §4). The RFC 4648
 *     §10 vectors pin both base64 forms;
 *   - the multibase prefixes `z` (base58btc) and `u` (base64url no pad), and the sha2-256 multihash.
 *
 * "Strict" matters because the same bytes must have one spelling: a verifier that accepts `+` where the
 * URL alphabet has `-`, or trailing bits that are not zero, lets two different strings stand for one signed
 * value. Node's own `Buffer.from(text, 'base64url')` is lenient on all of that, so it is only used to
 * convert, never to decide what is acceptable.
 */

export class MultibaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MultibaseError';
  }
}

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE58_INDEX: ReadonlyMap<string, number> = new Map([...BASE58_ALPHABET].map((char, i) => [char, i]));

/** BigInt arithmetic is quadratic, so decoding attacker-supplied text is bounded. */
const MAX_BASE58_CHARS = 2048;
const MAX_BASE58_BYTES = 1536;

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

export function base58btcEncode(bytes: Uint8Array): string {
  if (bytes.length > MAX_BASE58_BYTES) {
    throw new MultibaseError(`base58btc input is longer than ${MAX_BASE58_BYTES} bytes`);
  }

  let leadingZeros = 0;
  while (leadingZeros < bytes.length && bytes[leadingZeros] === 0) {
    leadingZeros++;
  }

  let value = 0n;
  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte);
  }

  let digits = '';
  while (value > 0n) {
    digits = BASE58_ALPHABET.charAt(Number(value % 58n)) + digits;
    value /= 58n;
  }

  return '1'.repeat(leadingZeros) + digits;
}

export function base58btcDecode(text: string): Uint8Array {
  if (text.length > MAX_BASE58_CHARS) {
    throw new MultibaseError(`base58btc text is longer than ${MAX_BASE58_CHARS} characters`);
  }

  let leadingZeros = 0;
  while (leadingZeros < text.length && text.charAt(leadingZeros) === '1') {
    leadingZeros++;
  }

  let value = 0n;
  for (const char of text.slice(leadingZeros)) {
    const digit = BASE58_INDEX.get(char);
    if (digit === undefined) {
      throw new MultibaseError('not a base58btc character');
    }
    value = value * 58n + BigInt(digit);
  }

  const significant: number[] = [];
  while (value > 0n) {
    significant.push(Number(value & 0xffn));
    value >>= 8n;
  }
  significant.reverse();

  return Uint8Array.from([...Array.from({ length: leadingZeros }, () => 0), ...significant]);
}

/** Base64url (RFC 4648 §5) with no padding. */
export function base64urlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

/** Strict: no padding, no `+` or `/`, no whitespace, and the unused trailing bits must be zero. */
export function base64urlDecode(text: string): Uint8Array {
  if (!BASE64URL_PATTERN.test(text) || text.length % 4 === 1) {
    throw new MultibaseError('not unpadded base64url');
  }
  const bytes = new Uint8Array(Buffer.from(text, 'base64url'));
  if (base64urlEncode(bytes) !== text) {
    throw new MultibaseError('base64url has non-zero trailing bits');
  }

  return bytes;
}

/** Standard base64 (RFC 4648 §4) with padding. */
export function base64Encode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}

/** Strict: padded, standard alphabet, no whitespace, and the unused trailing bits must be zero. */
export function base64Decode(text: string): Uint8Array {
  if (!BASE64_PATTERN.test(text)) {
    throw new MultibaseError('not padded base64');
  }
  const bytes = new Uint8Array(Buffer.from(text, 'base64'));
  if (base64Encode(bytes) !== text) {
    throw new MultibaseError('base64 has non-zero trailing bits');
  }

  return bytes;
}

export type MultibasePrefix = 'z' | 'u';

export function multibaseEncode(prefix: MultibasePrefix, bytes: Uint8Array): string {
  return prefix === 'z' ? `z${base58btcEncode(bytes)}` : `u${base64urlEncode(bytes)}`;
}

export function multibaseDecode(text: string): { prefix: MultibasePrefix; bytes: Uint8Array } {
  const prefix = text.charAt(0);
  const rest = text.slice(1);
  if (prefix === 'z') {
    return { prefix, bytes: base58btcDecode(rest) };
  }
  if (prefix === 'u') {
    return { prefix, bytes: base64urlDecode(rest) };
  }

  throw new MultibaseError('only the multibase prefixes z and u are supported');
}

/** The sha2-256 multihash of `data`: code 0x12, length 0x20, then the digest. */
export function sha256Multihash(data: Uint8Array): Uint8Array {
  const digest = createHash('sha256').update(data).digest();

  return Uint8Array.from([0x12, 0x20, ...digest]);
}
