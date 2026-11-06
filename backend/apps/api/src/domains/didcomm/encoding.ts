import { timingSafeEqual } from 'node:crypto';

import { DidcommError, type DidcommErrorCode } from './errors';

/**
 * Byte and text encodings the envelope formats are built from: unpadded base64url (JOSE),
 * base58btc and multibase (`did:key`, `did:peer`), unsigned varints (multicodec prefixes).
 *
 * Decoders are strict. A lenient decoder (padding accepted, trailing bits ignored, stray
 * characters skipped) lets two byte strings stand for one value, which breaks anything that
 * compares encodings, signs them, or uses them as identifiers.
 */

const BASE64URL = /^[A-Za-z0-9_-]*$/;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function base64urlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64url');
}

/**
 * Decodes unpadded base64url and nothing else: no `=` padding, no `+` or `/`, no whitespace, and
 * no non-zero trailing bits (the canonical-form check; without it a value has several encodings).
 */
export function base64urlDecode(
  text: unknown,
  what: string,
  code: DidcommErrorCode = 'malformed-envelope',
): Buffer {
  if (typeof text !== 'string' || !BASE64URL.test(text) || text.length % 4 === 1) {
    throw new DidcommError(code, `${what} is not unpadded base64url`);
  }

  const bytes = Buffer.from(text, 'base64url');

  if (bytes.toString('base64url') !== text) {
    throw new DidcommError(code, `${what} is not canonical base64url`);
  }

  return bytes;
}

export function utf8Encode(text: string): Buffer {
  return Buffer.from(text, 'utf8');
}

const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export function utf8Decode(
  bytes: Uint8Array,
  what: string,
  code: DidcommErrorCode = 'malformed-message',
): string {
  try {
    return STRICT_UTF8.decode(bytes);
  } catch {
    throw new DidcommError(code, `${what} is not valid UTF-8`);
  }
}

/** Parses JSON that must be an object. Arrays, scalars and `null` are refused. */
export function parseJsonObject(
  text: string,
  what: string,
  code: DidcommErrorCode = 'malformed-message',
): Record<string, unknown> {
  let value: unknown;

  try {
    value = JSON.parse(text);
  } catch {
    throw new DidcommError(code, `${what} is not valid JSON`);
  }

  if (!isRecord(value)) {
    throw new DidcommError(code, `${what} is not a JSON object`);
  }

  if (Object.prototype.hasOwnProperty.call(value, '__proto__')) {
    // JSON.parse keeps this as a plain own key, which is harmless until something copies the
    // object with Object.assign. Nothing legitimate sends it.
    throw new DidcommError(code, `${what} contains a "__proto__" member`);
  }

  return value;
}

export function uint32be(value: number): Buffer {
  const out = Buffer.alloc(4);
  out.writeUInt32BE(value);
  return out;
}

/** 32-bit big-endian length, then the bytes: the encoding Concat KDF (SP 800-56A) uses for each field. */
export function lengthPrefixed(bytes: Uint8Array): Buffer {
  return Buffer.concat([uint32be(bytes.length), bytes]);
}

export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

// ─── base58btc, multibase, multicodec varints ────────────────────────────────────────────────

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]*$/;
/** Longest base58 string accepted. The decoder is quadratic, and the longest legitimate input is a P-521 key. */
const MAX_BASE58_LENGTH = 1024;

export function base58btcEncode(bytes: Uint8Array): string {
  let zeros = 0;

  while (zeros < bytes.length && bytes[zeros] === 0) {
    zeros += 1;
  }

  let value = 0n;

  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte);
  }

  let digits = '';

  while (value > 0n) {
    digits = BASE58_ALPHABET[Number(value % 58n)] + digits;
    value /= 58n;
  }

  return '1'.repeat(zeros) + digits;
}

export function base58btcDecode(text: string, what = 'base58btc value'): Buffer {
  if (typeof text !== 'string' || text.length > MAX_BASE58_LENGTH || !BASE58.test(text)) {
    throw new DidcommError('invalid-key', `${what} is not base58btc`);
  }

  let zeros = 0;

  while (zeros < text.length && text[zeros] === '1') {
    zeros += 1;
  }

  let value = 0n;

  for (const char of text) {
    value = value * 58n + BigInt(BASE58_ALPHABET.indexOf(char));
  }

  let hex = value.toString(16);

  if (value === 0n) {
    hex = '';
  } else if (hex.length % 2 === 1) {
    hex = `0${hex}`;
  }

  return Buffer.concat([Buffer.alloc(zeros), Buffer.from(hex, 'hex')]);
}

/** Multibase `z` (base58btc): the only multibase base DID methods here use. */
export function multibaseEncodeBase58btc(bytes: Uint8Array): string {
  return `z${base58btcEncode(bytes)}`;
}

export function multibaseDecodeBase58btc(text: string, what = 'multibase value'): Buffer {
  if (typeof text !== 'string' || !text.startsWith('z')) {
    throw new DidcommError('invalid-key', `${what} is not multibase base58btc (it must start with "z")`);
  }

  return base58btcDecode(text.slice(1), what);
}

export function varintEncode(value: number): Buffer {
  if (!Number.isInteger(value) || value < 0 || value > 0x1fffff) {
    throw new DidcommError('invalid-argument', 'varint out of range');
  }

  const out: number[] = [];
  let rest = value;

  while (rest >= 0x80) {
    out.push((rest & 0x7f) | 0x80);
    rest >>>= 7;
  }

  out.push(rest);
  return Buffer.from(out);
}

/** Reads one unsigned varint (up to three bytes, minimal form only) from the front of `bytes`. */
export function varintDecode(bytes: Uint8Array): { value: number; length: number } {
  let value = 0;

  for (let index = 0; index < Math.min(bytes.length, 3); index += 1) {
    const byte = bytes[index];
    value |= (byte & 0x7f) << (7 * index);

    if ((byte & 0x80) === 0) {
      if (varintEncode(value).length !== index + 1) {
        break;
      }

      return { value, length: index + 1 };
    }
  }

  throw new DidcommError('invalid-key', 'multicodec prefix is not a minimal varint');
}
