import { asBytes, asSafeUint, asText, cbor, closedMap, decode, encode, type Cbor } from '../encoding/dcbor';
import { IdentiKeyError } from '../errors';

import {
  classicalPublicKeyFromCbor,
  classicalSignatureFromCbor,
  pqPublicKeyFromCbor,
  pqSignatureFromCbor,
  publicKeyToCbor,
  requireMember,
  signatureToCbor,
  type ClassicalPublicKey,
  type ClassicalSignature,
  type PqPublicKey,
  type PqSignature,
} from './keys';

/**
 * The challenge and response messages and the payload that is signed (identikey-auth-challenge-v1 §4).
 *
 *   Challenge = { "v": 1, "aud": tstr, "nonce": bstr (>= 16), "iat": uint, "exp": uint }
 *   Response  = { "chal": bstr, "pub": {alg,key}, "sig": {alg,sig} [, "pqpub": {alg,key}, "pqsig": {alg,sig}] }
 *   signed    = dCBOR([ "identikey-auth/v1", "challenge", chal ])
 *
 * `chal` is the challenge's canonical bytes EXACTLY as the verifier issued them, and it is what both
 * signatures cover. Decoding a challenge is for reading fields; a signature is never checked against a
 * re-encoding.
 *
 * Unlike the Rust reference, every map here is CLOSED: a member the protocol does not define is
 * rejected rather than ignored. `v` is the extension point; a version that adds a member bumps it.
 */

export const PROTOCOL_VERSION = 1;
/** Domain separation: an IdentiKey-auth signature can never be mistaken for a signature over anything else. */
export const SIGNING_CONTEXT = 'identikey-auth/v1';
export const PURPOSE_CHALLENGE = 'challenge';

/** A challenge is a few dozen bytes; the ceiling exists so a hostile `chal` cannot make us parse a megabyte. */
export const MAX_CHALLENGE_BYTES = 1024;
/** The largest legitimate response is ML-DSA-87 (2592-byte key + 4627-byte signature) on top of a classical pair, about 8 KiB. */
export const MAX_RESPONSE_BYTES = 16 * 1024;
/**
 * Values and map keys a message may hold. A challenge has 11 (the map, five keys, five values) and the
 * largest response, with both post-quantum members, has 27. The ceilings leave room, and no more: bytes
 * alone do not bound the work a decoder does for an anonymous caller (see `DEFAULT_MAX_ITEMS`).
 */
export const MAX_CHALLENGE_ITEMS = 16;
export const MAX_RESPONSE_ITEMS = 40;

export interface Challenge {
  readonly version: number;
  readonly audience: string;
  readonly nonce: Uint8Array;
  /** Unix seconds. */
  readonly issuedAt: number;
  /** Unix seconds. */
  readonly expiresAt: number;
}

export function encodeChallenge(challenge: Challenge): Uint8Array {
  return encode(
    cbor.map([
      ['v', cbor.uint(challenge.version)],
      ['aud', cbor.text(challenge.audience)],
      ['nonce', cbor.bytes(challenge.nonce)],
      ['iat', cbor.uint(challenge.issuedAt)],
      ['exp', cbor.uint(challenge.expiresAt)],
    ]),
  );
}

export function decodeChallenge(bytes: Uint8Array): Challenge {
  const members = closedMap(decode(bytes, { maxBytes: MAX_CHALLENGE_BYTES, maxItems: MAX_CHALLENGE_ITEMS }), [
    'v',
    'aud',
    'nonce',
    'iat',
    'exp',
  ]);

  return {
    version: asSafeUint(requireMember(members, 'v')),
    audience: asText(requireMember(members, 'aud')),
    nonce: new Uint8Array(asBytes(requireMember(members, 'nonce'))),
    issuedAt: asSafeUint(requireMember(members, 'iat')),
    expiresAt: asSafeUint(requireMember(members, 'exp')),
  };
}

/** The bytes both signatures are computed over, given the challenge's canonical bytes. */
export function signingPayload(challengeBytes: Uint8Array): Uint8Array {
  return encode(
    cbor.array([cbor.text(SIGNING_CONTEXT), cbor.text(PURPOSE_CHALLENGE), cbor.bytes(challengeBytes)]),
  );
}

export interface Response {
  /** The challenge, verbatim. */
  readonly challengeBytes: Uint8Array;
  readonly publicKey: ClassicalPublicKey;
  readonly signature: ClassicalSignature;
  /** Both halves or neither. */
  readonly pq?: { readonly publicKey: PqPublicKey; readonly signature: PqSignature };
}

export function encodeResponse(response: Response): Uint8Array {
  const entries: (readonly [string, Cbor])[] = [
    ['chal', cbor.bytes(response.challengeBytes)],
    ['pub', publicKeyToCbor(response.publicKey)],
    ['sig', signatureToCbor(response.signature)],
  ];
  if (response.pq !== undefined) {
    entries.push(['pqpub', publicKeyToCbor(response.pq.publicKey)]);
    entries.push(['pqsig', signatureToCbor(response.pq.signature)]);
  }

  return encode(cbor.map(entries));
}

export function decodeResponse(bytes: Uint8Array): Response {
  const members = closedMap(
    decode(bytes, { maxBytes: MAX_RESPONSE_BYTES, maxItems: MAX_RESPONSE_ITEMS }),
    ['chal', 'pub', 'sig'],
    ['pqpub', 'pqsig'],
  );

  const challengeBytes = new Uint8Array(asBytes(requireMember(members, 'chal')));
  const publicKey = classicalPublicKeyFromCbor(requireMember(members, 'pub'));
  const signature = classicalSignatureFromCbor(requireMember(members, 'sig'));

  const pqpub = members.get('pqpub');
  const pqsig = members.get('pqsig');
  if (pqpub === undefined && pqsig === undefined) {
    return { challengeBytes, publicKey, signature };
  }

  // A key without its signature (or the reverse) is not a smaller response, it is a malformed one.
  if (pqpub === undefined || pqsig === undefined) {
    throw new IdentiKeyError('pq-dangling', 'a post-quantum key and signature come as a pair');
  }

  return {
    challengeBytes,
    publicKey,
    signature,
    pq: { publicKey: pqPublicKeyFromCbor(pqpub), signature: pqSignatureFromCbor(pqsig) },
  };
}
