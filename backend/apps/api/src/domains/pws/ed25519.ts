import {
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from 'node:crypto';

/**
 * Ed25519 (RFC 8032) over `node:crypto`, with raw 32-byte keys at the edges. No dependency is added.
 *
 * `ed25519.spec.ts` pins sign and verify to RFC 8032 §7.1 test vectors 1-3 (Ed25519 is deterministic, so a
 * signature must come out byte for byte) and checks that a malleated signature (`S + L`) is refused.
 *
 * `isWeakEd25519PublicKey` mirrors `peers/ed25519Weak.ts` (the same 48 encodings, the same y-value test): the
 * dependency rules keep this library from importing another domain's internals, so it is a copy, and folding the
 * copies into one shared module is a follow-up. `verifyEd25519`, `didKey.ts` and `keys.ts` refuse such a key.
 */

/** DER `SubjectPublicKeyInfo` header for an Ed25519 key; the 32 raw bytes follow it. */
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** DER PKCS#8 header for an Ed25519 private key; the 32-byte seed follows it. */
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/** The order L of the Ed25519 base point, 2^252 + 27742317777372353535851937790883648493 (RFC 8032 §5.1). */
const GROUP_ORDER = 2n ** 252n + 27742317777372353535851937790883648493n;

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

/** What the rest of the module needs from a signing key: its verification method id and a signature. */
export interface Signer {
  /** The DID URL a verifier resolves to find the public key, e.g. `did:key:z6Mk...#z6Mk...`. */
  readonly id: string;
  /** Signs `data` and returns the 64-byte Ed25519 signature. Async so custody can be remote. */
  sign(data: Uint8Array): Promise<Uint8Array>;
}

function privateKeyFromSeed(seed: Uint8Array): KeyObject {
  if (seed.length !== 32) {
    throw new RangeError('an Ed25519 seed is 32 bytes');
  }

  return createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' });
}

function publicKeyObject(raw: Uint8Array): KeyObject {
  if (raw.length !== 32) {
    throw new RangeError('an Ed25519 public key is 32 bytes');
  }

  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
}

/** The 32-byte public key that belongs to `seed`. */
export function publicKeyFromSeed(seed: Uint8Array): Uint8Array {
  const spki = createPublicKey(privateKeyFromSeed(seed)).export({ format: 'der', type: 'spki' });

  return new Uint8Array(spki.subarray(spki.length - 32));
}

/** Whether the scalar half of `signature` is below the group order (RFC 8032 §5.1.7 requires it). */
function hasCanonicalScalar(signature: Uint8Array): boolean {
  let scalar = 0n;
  for (let i = 63; i >= 32; i--) {
    scalar = (scalar << 8n) | BigInt(signature[i] ?? 0);
  }

  return scalar < GROUP_ORDER;
}

/**
 * Whether a 32-byte Ed25519 public key is a small-order point or a non-canonical encoding (y ≥ p). Any other
 * length is weak. A signature can be made for a small-order key without its private key, so such a key names no
 * one; a non-canonical encoding is a second spelling of a key.
 */
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
    value = (value << 8n) | BigInt(bytes[i] ?? 0);
  }

  return value;
}

/**
 * Whether `signature` is a valid Ed25519 signature over `message`. Never throws. Under a small-order or
 * non-canonical key (`isWeakEd25519PublicKey`) nothing verifies.
 */
export function verifyEd25519(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  if (
    signature.length !== 64 ||
    publicKey.length !== 32 ||
    !hasCanonicalScalar(signature) ||
    isWeakEd25519PublicKey(publicKey)
  ) {
    return false;
  }

  try {
    return cryptoVerify(null, message, publicKeyObject(publicKey), signature);
  } catch {
    return false;
  }
}

/** A `Signer` over a seed held in this process. Production custody implements `Signer` itself. */
export class LocalEd25519Signer implements Signer {
  readonly publicKey: Uint8Array;
  private readonly privateKey: KeyObject;

  constructor(
    readonly id: string,
    seed: Uint8Array,
  ) {
    this.privateKey = privateKeyFromSeed(seed);
    this.publicKey = publicKeyFromSeed(seed);
  }

  sign(data: Uint8Array): Promise<Uint8Array> {
    return Promise.resolve(new Uint8Array(cryptoSign(null, data, this.privateKey)));
  }
}
