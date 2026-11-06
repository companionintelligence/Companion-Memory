import { base58btcDecode, base58btcEncode, MultibaseError } from './multibase';

/**
 * `did:key` for Ed25519, the one DID method every Portable Web Spaces server must accept as a Space
 * controller (PWS "Space Controller DID Method Registry").
 *
 * A `did:key` is the key itself: `did:key:` + a multibase `z` (base58btc) string of the multicodec
 * `ed25519-pub` prefix 0xED 0x01 followed by the 32 raw public-key bytes. The DID document is computed from the
 * identifier and never changes, so there is nothing to resolve and nothing to rotate. `didKey.spec.ts` pins the
 * encoding to the W3C vc-di-eddsa Appendix B key pair (`z6MkrJVnaZkeFzdQyMZu1cgjg7k1pZZ6pvBQ7XJPt4swbTQ2`) and to
 * the example DID used in the PWS specification.
 *
 * Only Ed25519 is accepted. Every other multicodec (secp256k1, P-256, X25519, ...) is refused rather than
 * guessed at, and so is every other DID method: this module never sees `did:keri`, `did:web` or `did:webvh`.
 */

export class DidKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DidKeyError';
  }
}

export interface VerificationMethod {
  id: string;
  type: 'Multikey';
  controller: string;
  publicKeyMultibase: string;
}

export interface DidDocument {
  '@context': string[];
  id: string;
  verificationMethod: VerificationMethod[];
  authentication: string[];
  assertionMethod: string[];
  capabilityDelegation: string[];
  capabilityInvocation: string[];
}

const DID_KEY_PREFIX = 'did:key:';
const FINGERPRINT_PATTERN = /^z[1-9A-HJ-NP-Za-km-z]+$/;

function fingerprintOf(publicKey: Uint8Array): string {
  return `z${base58btcEncode(Uint8Array.from([0xed, 0x01, ...publicKey]))}`;
}

/** The `did:key` that spells `publicKey`. */
export function didKeyFromPublicKey(publicKey: Uint8Array): string {
  if (publicKey.length !== 32) {
    throw new DidKeyError('an Ed25519 public key is 32 bytes');
  }

  return `${DID_KEY_PREFIX}${fingerprintOf(publicKey)}`;
}

/** The raw Ed25519 public key a `did:key` spells. The argument is a DID, not a DID URL. */
export function publicKeyFromDidKey(did: string): Uint8Array {
  if (!did.startsWith(DID_KEY_PREFIX)) {
    throw new DidKeyError('not a did:key');
  }
  const fingerprint = did.slice(DID_KEY_PREFIX.length);
  if (!FINGERPRINT_PATTERN.test(fingerprint)) {
    throw new DidKeyError('a did:key identifier is a multibase base58btc string');
  }

  let decoded: Uint8Array;
  try {
    decoded = base58btcDecode(fingerprint.slice(1));
  } catch (error) {
    if (error instanceof MultibaseError) {
      throw new DidKeyError(error.message);
    }
    throw error;
  }
  if (decoded.length !== 34 || decoded[0] !== 0xed || decoded[1] !== 0x01) {
    throw new DidKeyError('only Ed25519 did:key identifiers (multicodec 0xed01, 32 bytes) are supported');
  }

  return decoded.slice(2);
}

/** Whether `did` is a well-formed Ed25519 `did:key` (a DID, so with no fragment). */
export function isDidKey(did: string): boolean {
  try {
    publicKeyFromDidKey(did);

    return true;
  } catch {
    return false;
  }
}

/** The DID method of `did` (`key` for `did:key:...`), or undefined when `did` is not DID-shaped. */
export function didMethodOf(did: string): string | undefined {
  return /^did:([a-z0-9]+):[^\s]+$/.exec(did)?.[1];
}

/** The verification-method id a `did:key` signs with: the DID plus its own fingerprint as the fragment. */
export function keyIdFromDidKey(did: string): string {
  publicKeyFromDidKey(did);

  return `${did}#${did.slice(DID_KEY_PREFIX.length)}`;
}

/** Splits `did:key:...#fragment`. Paths and queries are not part of a verification-method id and are refused. */
export function parseDidKeyUrl(didUrl: string): { did: string; fragment?: string } {
  if (!didUrl.startsWith(DID_KEY_PREFIX)) {
    throw new DidKeyError('not a did:key URL');
  }
  const hash = didUrl.indexOf('#');
  const did = hash === -1 ? didUrl : didUrl.slice(0, hash);
  if (/[/?]/.test(did)) {
    throw new DidKeyError('a did:key URL here carries no path or query');
  }
  if (hash === -1) {
    return { did };
  }
  const fragment = didUrl.slice(hash + 1);
  if (fragment === '' || fragment.includes('#')) {
    throw new DidKeyError('malformed DID URL fragment');
  }

  return { did, fragment };
}

/**
 * The DID document of a `did:key` (or of the DID a `did:key#fragment` URL belongs to). The one key is listed under
 * every verification relationship, as the did:key method specification does for a signature key. When a fragment
 * is present it must be this key's own fingerprint: a `did:key` has exactly one verification method.
 */
export function resolveDidKey(didOrUrl: string): DidDocument {
  const { did, fragment } = parseDidKeyUrl(didOrUrl);
  const publicKey = publicKeyFromDidKey(did);
  const fingerprint = fingerprintOf(publicKey);
  if (did !== `${DID_KEY_PREFIX}${fingerprint}`) {
    throw new DidKeyError('the did:key identifier is not canonical');
  }
  if (fragment !== undefined && fragment !== fingerprint) {
    throw new DidKeyError('a did:key has one verification method, named by its own fingerprint');
  }

  const id = `${did}#${fingerprint}`;

  return {
    '@context': ['https://www.w3.org/ns/did/v1', 'https://w3id.org/security/multikey/v1'],
    id: did,
    verificationMethod: [{ id, type: 'Multikey', controller: did, publicKeyMultibase: fingerprint }],
    authentication: [id],
    assertionMethod: [id],
    capabilityDelegation: [id],
    capabilityInvocation: [id],
  };
}
