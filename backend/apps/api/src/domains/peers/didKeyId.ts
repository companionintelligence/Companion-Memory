/**
 * The W3C CCG `did:key` form of one Ed25519 public key: `did:key:z6Mk…`.
 *
 * ═══ WHY THIS EXISTS NEXT TO `sovereignKeyId.ts` ═══
 *
 * `sovereignKeyId.ts` accepts a `did:keri:D<jwk-x>` that is Companion Memory's OWN convention and
 * says so: a real KERI prefix is CESR, and decoding CESR is a design change of its own. `did:key`
 * is the opposite situation. It is a published, ledger-free method whose whole identifier is the
 * key, with an encoding fixed by two public tables (multicodec and multibase) and nothing that
 * needs resolving, so a verifier reading one needs no network and no log. That is what lets two
 * boxes federate with neither Portal nor a KERI library.
 *
 * It is NOT an identifier Local.Pub publishes for its people. An actor lists its key as
 * `publicKeyMultibase: z6Mk…`, which is the tail of this DID, but nothing ties that key to the person
 * (see `localPubProfile.ts`). A Companion's `did:key` is the `kid` of its own `peers.signingKeyJwk`,
 * and the owner confirms it with the person before linking.
 *
 * ═══ THE ENCODING, SO IT CAN BE CHECKED BY HAND ═══
 *
 *   did:key:  +  "z"  +  base58btc( 0xed 0x01  ||  32-byte public key )
 *
 * `z` is the multibase code for base58btc. `0xed 0x01` is the unsigned-varint multicodec for an
 * Ed25519 public key. Every such DID is 48 characters after `did:key:` and starts `z6Mk`.
 *
 * ═══ WHAT IS DELIBERATELY REFUSED ═══
 *
 * - Any other key type (`z6LS…` X25519, `zQ3s…` secp256k1, `zDn…` P-256). This profile is
 *   Ed25519-only, like the signature algorithm.
 * - A DID URL (`…#z6Mk…`, a query, a path). One key must have one spelling: two spellings of one
 *   key would be two identifiers for one peer, and a peer link matches on the exact string.
 * - A string that decodes but does not re-encode to itself.
 * - 32 bytes that are not a point on the Ed25519 curve (`ed25519Curve.ts`). Such a key can never
 *   verify a signature. About half of all 32-byte strings are not points, so a one-character slip in a
 *   DID is caught about half the time (46% of single-character substitutions still decode to another
 *   valid key that nobody holds): this is a guard against some typing slips, not a substitute for
 *   comparing the whole key with the person.
 * - A key nobody can hold (`ed25519Weak.ts`): a small-order point, which anyone can sign for without
 *   a private key, or a non-canonical spelling (y >= p), which would be a second identifier for one
 *   key. An identifier that is the key is only worth trusting if signing under it takes the key.
 * - Every other `did:` method (`did:web`, `did:webvh`, `did:scid:vh`). Those can rotate keys, so
 *   reading one means resolving a log. That is the KERI-shaped problem this file does not solve; see
 *   ADR-0016.
 *
 * ═══ TWO LEVELS OF STRICTNESS, BECAUSE THE CURVE TEST COSTS ABOUT 0.2 MS ═══
 *
 * "Well formed" is everything except the curve test: the canonical string, an Ed25519 multicodec, 32
 * bytes, not one of the 48 weak encodings (about 7 microseconds). "Valid" is well formed AND a point.
 * Admitting a key (writing a link, reading a profile's claim) needs "valid". READING a keyid off an
 * inbound request needs only "well formed": the link lookup is by exact string, a link can only exist
 * under a key that was valid when it was written, and an off-curve key cannot verify a signature. The
 * inbound path runs this codec several times per request before any limiter, so making it pay the curve
 * test each time would hand an unauthenticated caller about a millisecond of CPU per request.
 *
 * Pure: no clock, no config, no I/O.
 */

import { isEd25519CurvePoint } from './ed25519Curve';
import { isWeakEd25519PublicKey } from './ed25519Weak';

const DID_KEY_PREFIX = 'did:key:';

/** The multibase code for base58btc, which `did:key` puts directly after the method. */
const MULTIBASE_BASE58BTC = 'z';

/** Unsigned-varint multicodec for an Ed25519 public key. */
const ED25519_PUB_MULTICODEC = Uint8Array.of(0xed, 0x01);

const ED25519_KEY_BYTES = 32;

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/**
 * `did:key:z` and 47 base58btc characters: 34 bytes (2 multicodec + 32 key) is always exactly 47
 * digits, because the leading byte is 0xed. A cheap shape check in front of the real decode.
 */
const DID_KEY_PATTERN = /^did:key:z[1-9A-HJ-NP-Za-km-z]{47}$/;

/** Whether `keyid` is a VALID Ed25519 `did:key`: well formed, and a point on the curve. */
export function isDidKeyId(keyid: string): boolean {
  return didKeyPublicJwk(keyid) != null;
}

/**
 * The Ed25519 public JWK a VALID `did:key` spells out (well formed, and a point on the curve), or null
 * for anything else. Use this where a key is ADMITTED; see {@link wellFormedDidKeyJwk} for reading one.
 */
export function didKeyPublicJwk(keyid: string): Record<string, unknown> | null {
  const key = wellFormedKeyBytes(keyid);

  return key != null && isEd25519CurvePoint(key) ? publicJwk(key) : null;
}

/**
 * The Ed25519 public JWK a WELL-FORMED `did:key` spells out, or null: canonical, an Ed25519 multicodec,
 * 32 bytes, not a weak key. It does NOT check that the bytes are a point on the curve (about 200 times
 * cheaper). Only for reading a keyid off a request or a stored link, where a signature check follows
 * and an off-curve key cannot pass it; never to decide that a key may be linked.
 */
export function wellFormedDidKeyJwk(keyid: string): Record<string, unknown> | null {
  const key = wellFormedKeyBytes(keyid);

  return key != null ? publicJwk(key) : null;
}

/**
 * The 32 key bytes of a well-formed `did:key`, or null. The round trip is the canonical-form check: a
 * decode that does not re-encode to the input is refused, so the one key has the one identifier; and a
 * weak key has no `did:key`, so the same comparison covers the weak-key rule.
 */
function wellFormedKeyBytes(keyid: string): Uint8Array | null {
  if (typeof keyid !== 'string' || !DID_KEY_PATTERN.test(keyid)) {
    return null;
  }

  const raw = base58btcDecode(keyid.slice(DID_KEY_PREFIX.length + MULTIBASE_BASE58BTC.length));
  if (
    raw == null ||
    raw.length !== ED25519_PUB_MULTICODEC.length + ED25519_KEY_BYTES ||
    raw[0] !== ED25519_PUB_MULTICODEC[0] ||
    raw[1] !== ED25519_PUB_MULTICODEC[1]
  ) {
    return null;
  }

  const key = raw.subarray(ED25519_PUB_MULTICODEC.length);

  return !isWeakEd25519PublicKey(key) && encodeDidKey(key) === keyid ? key : null;
}

function publicJwk(key: Uint8Array): Record<string, unknown> {
  return { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(key).toString('base64url') };
}

function encodeDidKey(key: Uint8Array): string {
  const bytes = new Uint8Array(ED25519_PUB_MULTICODEC.length + key.length);
  bytes.set(ED25519_PUB_MULTICODEC, 0);
  bytes.set(key, ED25519_PUB_MULTICODEC.length);

  return `${DID_KEY_PREFIX}${MULTIBASE_BASE58BTC}${base58btcEncode(bytes)}`;
}

/** The `did:key` for an Ed25519 public JWK, or null when it is not one. */
export function didKeyIdFor(jwk: Record<string, unknown>): string | null {
  if (
    typeof jwk !== 'object' ||
    jwk === null ||
    jwk.kty !== 'OKP' ||
    jwk.crv !== 'Ed25519' ||
    typeof jwk.x !== 'string'
  ) {
    return null;
  }

  const key = Buffer.from(jwk.x, 'base64url');
  // 32 bytes, and the one spelling of them: stray bits in the last character would otherwise give
  // two JWKs for one key.
  if (key.length !== ED25519_KEY_BYTES || key.toString('base64url') !== jwk.x) {
    return null;
  }

  return didKeyFromPublicKey(key);
}

/**
 * The `did:key` for a raw 32-byte Ed25519 public key. Null for any other length, so a caller that
 * hands over a certificate or a 33-byte compressed point gets a refusal and not a wrong identifier,
 * and null for a key nobody can hold (small order, non-canonical) or that is not a point on the curve:
 * such a key has no identifier.
 */
export function didKeyFromPublicKey(key: Uint8Array): string | null {
  if (
    !(key instanceof Uint8Array) ||
    key.length !== ED25519_KEY_BYTES ||
    isWeakEd25519PublicKey(key) ||
    !isEd25519CurvePoint(key)
  ) {
    return null;
  }

  return encodeDidKey(key);
}

/** Bitcoin-alphabet base58, big-endian, a leading zero byte for each leading `1`. */
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

/** The inverse of {@link base58btcEncode}; null when a character is outside the alphabet. */
export function base58btcDecode(text: string): Uint8Array | null {
  let zeros = 0;
  while (zeros < text.length && text[zeros] === '1') {
    zeros += 1;
  }

  let value = 0n;
  for (const char of text) {
    const digit = BASE58_ALPHABET.indexOf(char);
    if (digit < 0) {
      return null;
    }

    value = value * 58n + BigInt(digit);
  }

  let hex = value.toString(16);
  if (value === 0n) {
    hex = '';
  } else if (hex.length % 2 === 1) {
    hex = `0${hex}`;
  }

  const body = Buffer.from(hex, 'hex');
  const out = new Uint8Array(zeros + body.length);
  out.set(body, zeros);

  return out;
}
