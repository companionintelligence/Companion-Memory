import { createPublicKey, randomBytes, sign, verify, type KeyObject } from 'node:crypto';

import { didKeyPublicJwk } from './didKeyId';
import { publishedBase } from './peerRequest';

/**
 * "The box at this address holds this person's key, right now."
 *
 * `GET <endpoint>/identity/<did:key>?challenge=<nonce>` answers with this
 * document, signed by the key the `did:key` names over a message that binds the
 * key, the endpoint the box publishes and the caller's fresh challenge. A caller
 * that checks it knows three things before it links anyone:
 *
 *   - the key is held by whoever answers at that address (the signature);
 *   - the answer is fresh, not replayed from an earlier fetch (the challenge);
 *   - the box itself says that address is where it takes peer requests (the
 *     signed endpoint), so a person cannot pair someone else's address with
 *     their own key.
 *
 * It says nothing about WHO the person is. That comes from the people
 * themselves, through the invite code they handed each other.
 */

/** Domain separation: this signature can never be mistaken for any other this key makes. */
const PROOF_PREFIX = 'companion-memory peer identity v1\n';

/** 128 bits or more of base64url. A short challenge is a replayable one. */
export const IDENTITY_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{22,128}$/;

export interface IdentityProofDocument {
  v: 1;
  didKey: string;
  endpoint: string;
  challenge: string;
  /** base64url Ed25519 signature over {@link identityProofMessage}. */
  signature: string;
}

export function newIdentityChallenge(): string {
  return randomBytes(24).toString('base64url');
}

export function identityProofMessage(fields: {
  didKey: string;
  endpoint: string;
  challenge: string;
}): string {
  return `${PROOF_PREFIX}${fields.didKey}\n${fields.endpoint}\n${fields.challenge}`;
}

export function signIdentityProof(
  key: KeyObject,
  fields: { didKey: string; endpoint: string; challenge: string },
): IdentityProofDocument {
  const signature = sign(null, Buffer.from(identityProofMessage(fields), 'utf8'), key).toString('base64url');

  return { v: 1, ...fields, signature };
}

/**
 * Whether `raw` proves that the box at `expected.endpoint` holds the key of
 * `expected.didKey`, in answer to `expected.challenge`. Every field is checked
 * against what the CALLER expected, never against what the document says it is.
 */
export function verifyIdentityProof(
  raw: unknown,
  expected: { didKey: string; endpoint: string; challenge: string },
): boolean {
  if (typeof raw !== 'object' || raw == null) {
    return false;
  }

  const doc = raw as Partial<IdentityProofDocument>;
  const endpoint = publishedBase(expected.endpoint);

  if (
    doc.v !== 1 ||
    endpoint == null ||
    doc.didKey !== expected.didKey ||
    doc.challenge !== expected.challenge ||
    typeof doc.endpoint !== 'string' ||
    publishedBase(doc.endpoint) !== endpoint ||
    typeof doc.signature !== 'string'
  ) {
    return false;
  }

  const jwk = didKeyPublicJwk(expected.didKey);
  if (jwk == null) {
    return false;
  }

  try {
    const publicKey = createPublicKey({ key: jwk as never, format: 'jwk' });
    const message = identityProofMessage({
      didKey: expected.didKey,
      endpoint: doc.endpoint,
      challenge: doc.challenge,
    });

    return verify(null, Buffer.from(message, 'utf8'), publicKey, Buffer.from(doc.signature, 'base64url'));
  } catch {
    return false;
  }
}
