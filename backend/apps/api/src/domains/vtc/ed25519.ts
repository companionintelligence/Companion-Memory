import {
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  verify as cryptoVerify,
  type KeyObject,
} from 'node:crypto';

/**
 * Ed25519 (RFC 8032) over `node:crypto`, with raw 32-byte keys at the edges.
 *
 * No dependency is added for this: Node's OpenSSL-backed Ed25519 rejects a non-canonical `S`
 * (RFC 8032 §5.1.7), which is the malleability check a verifier needs.
 */

/**
 * The public keys that sign anything: the eight points whose order divides 8 and their
 * non-canonical encodings (libsodium's blocklist), written with the sign bit cleared. A signature of
 * zeroes can verify under such a key for every message, so a key like this makes any document
 * "signed" without a secret. No honest key is one of these.
 */
const SMALL_ORDER_PUBLIC_KEYS: readonly Buffer[] = [
  '00'.repeat(32),
  `01${'00'.repeat(31)}`,
  `ec${'ff'.repeat(30)}7f`,
  `ed${'ff'.repeat(30)}7f`,
  `ee${'ff'.repeat(30)}7f`,
  '26e8958fc2b227b045c3f489f2ef98f0d5dfac05d3c63339b13802886d53fc05',
  'c7176a703d4dd84fba3c0b760d10670f2a2053fa2c39ccc64ec7fd7792ac037a',
].map((hex) => Buffer.from(hex, 'hex'));

/** Whether `raw` is one of the small-order encodings (the sign bit is ignored, as it is for a point). */
export function isSmallOrderPublicKey(raw: Uint8Array): boolean {
  if (raw.length !== 32) {
    return false;
  }

  const masked = Buffer.from(raw);
  masked[31] = (masked[31] ?? 0) & 0x7f;

  return SMALL_ORDER_PUBLIC_KEYS.some((entry) => entry.equals(masked));
}

/** DER `SubjectPublicKeyInfo` header for an Ed25519 key; the 32 raw bytes follow it. */
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** DER PKCS#8 header for an Ed25519 private key; the 32-byte seed follows it. */
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/** The community's signing key as the rest of the module sees it. */
export interface Signer {
  /** The DID URL a verifier resolves to find the public key, e.g. `did:example:community#key-0`. */
  readonly verificationMethod: string;
  /** Signs `data` and returns the 64-byte Ed25519 signature. Async so custody can be remote. */
  sign(data: Uint8Array): Promise<Uint8Array>;
}

export function publicKeyObject(raw: Uint8Array): KeyObject {
  if (raw.length !== 32) {
    throw new RangeError('an Ed25519 public key is 32 bytes');
  }

  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
}

export function privateKeyFromSeed(seed: Uint8Array): KeyObject {
  if (seed.length !== 32) {
    throw new RangeError('an Ed25519 seed is 32 bytes');
  }

  return createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' });
}

/** The 32 raw bytes of an Ed25519 public key. */
export function rawPublicKey(key: KeyObject): Uint8Array {
  const der = key.type === 'private' ? createPublicKey(key) : key;
  const spki = der.export({ format: 'der', type: 'spki' });

  return spki.subarray(spki.length - 32);
}

/** Whether `signature` is a valid Ed25519 signature over `message`. Never throws. */
export function verifyEd25519(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  if (signature.length !== 64 || isSmallOrderPublicKey(publicKey)) {
    return false;
  }

  try {
    return cryptoVerify(null, message, publicKeyObject(publicKey), signature);
  } catch {
    return false;
  }
}

/** A `Signer` over a key held in this process. Production custody implements `Signer` itself. */
export class LocalSigner implements Signer {
  constructor(
    readonly verificationMethod: string,
    private readonly privateKey: KeyObject,
  ) {}

  sign(data: Uint8Array): Promise<Uint8Array> {
    return Promise.resolve(new Uint8Array(cryptoSign(null, data, this.privateKey)));
  }
}
