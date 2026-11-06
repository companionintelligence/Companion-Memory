import { decodeMultibaseBase58btc, encodeMultibaseBase58btc } from './multibase';

/**
 * `did:key` for Ed25519, the one DID method this module resolves without a network.
 *
 * A `did:key` is the key: `did:key:` + the Multibase (`z`, base58btc) form of the public key
 * behind the Ed25519 multicodec prefix `0xed 0x01`. Its verification method is
 * `did:key:z6Mk…#z6Mk…`, the fragment repeating the key.
 *
 * ═══ NOT KERI ═══
 *
 * `did:keri:` identifiers are deliberately unsupported. Companion Memory's own `did:keri:D<x>`
 * peer key id (`peers/sovereignKeyId.ts`) is a local convention, not CESR, and the Hub's KERI
 * module is frozen as non-interoperable. A verifier here that accepted either as a DID would
 * present a string that looks like proof of a key and is not one. Add KERI by adding a
 * conformant resolver, not by widening these patterns.
 */

export class DidKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DidKeyError';
  }
}

const ED25519_PUBLIC_MULTICODEC = [0xed, 0x01] as const;

const MULTIKEY = /^z[1-9A-HJ-NP-Za-km-z]+$/;

/** `z6Mk…`: the Multibase multikey form of a raw Ed25519 public key. */
export function multikeyFromPublicKey(publicKey: Uint8Array): string {
  if (publicKey.length !== 32) {
    throw new DidKeyError('an Ed25519 public key is 32 bytes');
  }

  return encodeMultibaseBase58btc(Uint8Array.from([...ED25519_PUBLIC_MULTICODEC, ...publicKey]));
}

/** The raw Ed25519 public key a multikey holds. Any other key type is refused. */
export function publicKeyFromMultikey(multikey: string): Uint8Array {
  if (!MULTIKEY.test(multikey)) {
    throw new DidKeyError('not a multikey');
  }

  const bytes = decodeMultibaseBase58btc(multikey);
  if (
    bytes.length !== 34 ||
    bytes[0] !== ED25519_PUBLIC_MULTICODEC[0] ||
    bytes[1] !== ED25519_PUBLIC_MULTICODEC[1]
  ) {
    throw new DidKeyError('not an Ed25519 multikey');
  }

  return bytes.subarray(2);
}

export function didKeyFromPublicKey(publicKey: Uint8Array): string {
  return `did:key:${multikeyFromPublicKey(publicKey)}`;
}

/** The raw key a `did:key:z6Mk…` DID is. */
export function publicKeyFromDidKey(did: string): Uint8Array {
  if (!did.startsWith('did:key:')) {
    throw new DidKeyError('not a did:key');
  }

  return publicKeyFromMultikey(did.slice('did:key:'.length));
}

/** The verification method URL of a `did:key`: `did:key:z6Mk…#z6Mk…`. */
export function didKeyVerificationMethod(did: string): string {
  return `${did}#${did.slice('did:key:'.length)}`;
}
