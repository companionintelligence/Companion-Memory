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
 */

/** DER `SubjectPublicKeyInfo` header for an Ed25519 key; the 32 raw bytes follow it. */
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** DER PKCS#8 header for an Ed25519 private key; the 32-byte seed follows it. */
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

/** The order L of the Ed25519 base point, 2^252 + 27742317777372353535851937790883648493 (RFC 8032 §5.1). */
const GROUP_ORDER = 2n ** 252n + 27742317777372353535851937790883648493n;

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

/** Whether `signature` is a valid Ed25519 signature over `message`. Never throws. */
export function verifyEd25519(publicKey: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  if (signature.length !== 64 || publicKey.length !== 32 || !hasCanonicalScalar(signature)) {
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
