/**
 * The few multiformats encodings Trust Task proofs and digests need: base58btc (`z`), unpadded
 * base64url (`u`), the Ed25519 public-key Multikey, and the SHA-256 multihash.
 *
 * Written out rather than imported because the encodings are small, security-relevant and must be
 * STRICT: a decoder that tolerates a stray character or a non-canonical padding gives one signature
 * two spellings, and two spellings of one identifier are two identifiers. Every decoder here
 * round-trips its result and returns null on any input it would not itself have produced.
 */

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const BASE58_INDEX: ReadonlyMap<string, number> = new Map(
  [...BASE58_ALPHABET].map((char, index) => [char, index]),
);

/** Bound on what any decoder will look at: far above a signature, far below an abuse payload. */
const MAX_ENCODED_LENGTH = 512;

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
    digits = `${BASE58_ALPHABET[Number(value % 58n)]}${digits}`;
    value /= 58n;
  }

  return `${'1'.repeat(zeros)}${digits}`;
}

/** Decode base58btc, or null for any character outside the alphabet or an oversized input. */
export function base58btcDecode(text: string): Uint8Array | null {
  if (text.length === 0 || text.length > MAX_ENCODED_LENGTH) {
    return null;
  }

  let zeros = 0;
  while (zeros < text.length && text[zeros] === '1') {
    zeros += 1;
  }

  let value = 0n;
  for (const char of text) {
    const index = BASE58_INDEX.get(char);
    if (index === undefined) {
      return null;
    }

    value = value * 58n + BigInt(index);
  }

  let hex = value.toString(16);
  if (value === 0n) {
    hex = '';
  } else if (hex.length % 2 === 1) {
    hex = `0${hex}`;
  }

  const body = Buffer.from(hex, 'hex');
  const decoded = new Uint8Array(zeros + body.length);
  decoded.set(body, zeros);

  return decoded;
}

/** Canonical unpadded base64url, the only spelling the `u` multibase prefix admits. */
export function base64urlDecode(text: string): Uint8Array | null {
  if (text.length > MAX_ENCODED_LENGTH || !/^[A-Za-z0-9_-]*$/.test(text)) {
    return null;
  }

  const bytes = Buffer.from(text, 'base64url');

  // A last character carrying stray bits decodes fine and re-encodes differently: reject it.
  return bytes.toString('base64url') === text ? new Uint8Array(bytes) : null;
}

export function base64urlEncode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

export type MultibaseBase = 'z' | 'u';

export function multibaseEncode(base: MultibaseBase, bytes: Uint8Array): string {
  return base === 'z' ? `z${base58btcEncode(bytes)}` : `u${base64urlEncode(bytes)}`;
}

/** Decode a `z` (base58btc) or `u` (base64url) multibase string; null for anything else. */
export function multibaseDecode(text: string): { base: MultibaseBase; bytes: Uint8Array } | null {
  const prefix = text[0];
  const body = text.slice(1);

  if (prefix === 'z') {
    const bytes = base58btcDecode(body);

    return bytes == null ? null : { base: 'z', bytes };
  }

  if (prefix === 'u') {
    const bytes = base64urlDecode(body);

    return bytes == null ? null : { base: 'u', bytes };
  }

  return null;
}

/** multicodec `ed25519-pub` (0xed) as a varint. */
const ED25519_PUB_HEADER = Uint8Array.of(0xed, 0x01);

/** The Multikey spelling of an Ed25519 public key: `z` + base58btc(0xed01 ‖ key). */
export function encodeEd25519Multikey(publicKey: Uint8Array): string {
  if (publicKey.length !== 32) {
    throw new RangeError('an Ed25519 public key is 32 bytes');
  }

  const bytes = new Uint8Array(ED25519_PUB_HEADER.length + publicKey.length);
  bytes.set(ED25519_PUB_HEADER, 0);
  bytes.set(publicKey, ED25519_PUB_HEADER.length);

  return multibaseEncode('z', bytes);
}

/** The raw 32-byte key of an Ed25519 Multikey, or null when `text` is anything else. */
export function decodeEd25519Multikey(text: string): Uint8Array | null {
  const decoded = multibaseDecode(text);
  if (decoded == null || decoded.base !== 'z' || decoded.bytes.length !== 34) {
    return null;
  }

  if (decoded.bytes[0] !== ED25519_PUB_HEADER[0] || decoded.bytes[1] !== ED25519_PUB_HEADER[1]) {
    return null;
  }

  return decoded.bytes.slice(2);
}

/** multihash for SHA-256: code 0x12, length 0x20, then the digest. */
export function sha256Multihash(digest: Uint8Array): Uint8Array {
  if (digest.length !== 32) {
    throw new RangeError('a SHA-256 digest is 32 bytes');
  }

  const bytes = new Uint8Array(2 + digest.length);
  bytes.set([0x12, 0x20], 0);
  bytes.set(digest, 2);

  return bytes;
}
