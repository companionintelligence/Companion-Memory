import { ed25519PublicKeyToX25519 } from './edwards';
import { base64urlDecode, base64urlEncode } from './encoding';
import { DidcommError } from './errors';
import { type DidDocument, type DidResolver } from './didDocument';
import { type PublicJwk } from './jwk';
import { jwkFromMultikey, multikeyFromJwk } from './multikey';

/**
 * `did:key` (https://w3c-ccg.github.io/did-method-key/) for the six key types DIDComm uses.
 *
 * A `did:key` is the key: `did:key:` + the multikey form of one public key. Nothing is fetched, so
 * resolution is a pure function of the string, which is why this is the identifier that works with
 * no network, no ledger and no server. The cost is the usual one for a self-certifying
 * identifier: it cannot rotate. A new key is a new identity.
 *
 * ═══ NOT KERI ═══
 *
 * A `did:key` made from an Ed25519 key and a Companion Memory `did:keri:D<x>` key id
 * (`peers/sovereignKeyId.ts`, "COMPANION MEMORY'S OWN CONVENTION, NOT CESR") can name the same 32
 * bytes. That is a statement about the key, not about KERI: no key event log stands behind either.
 * `did:keri` is refused by the resolver in `resolver.ts`.
 *
 * For an Ed25519 key the document also lists the X25519 key derived from it (RFC 7748 §4.1
 * birational map, `edwards.ts`) as the `keyAgreement` method, so one Ed25519 identity can sign and
 * receive encrypted DIDComm messages.
 */

const PREFIX = 'did:key:';

const CONTEXT = ['https://www.w3.org/ns/did/v1', 'https://w3id.org/security/multikey/v1'];

export function didKeyFromJwk(jwk: PublicJwk): string {
  return `${PREFIX}${multikeyFromJwk(jwk)}`;
}

/** The public key a `did:key` names. Refuses DID URLs, a missing or wrong multibase prefix and unknown key types. */
export function jwkFromDidKey(did: string): PublicJwk {
  if (typeof did !== 'string' || !did.startsWith(PREFIX) || /[/?#]/.test(did)) {
    throw new DidcommError('unsupported-did-method', 'not a did:key identifier (DID URLs are not DIDs)');
  }

  return jwkFromMultikey(did.slice(PREFIX.length));
}

/** Absolute id of a `did:key` verification method: the DID with the key repeated as the fragment. */
export function didKeyVerificationMethodId(did: string, multikey: string): string {
  return `${did}#${multikey}`;
}

export function resolveDidKey(did: string): DidDocument {
  const jwk = jwkFromDidKey(did);
  const multikey = did.slice(PREFIX.length);
  const method = (id: string, publicKeyMultibase: string) => ({
    id,
    type: 'Multikey',
    controller: did,
    publicKeyMultibase,
  });

  const keyId = didKeyVerificationMethodId(did, multikey);

  if (jwk.crv === 'X25519') {
    return {
      '@context': CONTEXT,
      id: did,
      verificationMethod: [method(keyId, multikey)],
      keyAgreement: [keyId],
    };
  }

  if (jwk.crv === 'Ed25519') {
    const agreement = multikeyFromJwk({
      kty: 'OKP',
      crv: 'X25519',
      x: base64urlEncode(ed25519PublicKeyToX25519(base64urlDecode(jwk.x, 'x', 'invalid-key'))),
    });
    const agreementId = didKeyVerificationMethodId(did, agreement);

    return {
      '@context': CONTEXT,
      id: did,
      verificationMethod: [method(keyId, multikey), method(agreementId, agreement)],
      authentication: [keyId],
      assertionMethod: [keyId],
      capabilityInvocation: [keyId],
      capabilityDelegation: [keyId],
      keyAgreement: [agreementId],
    };
  }

  // NIST curves and secp256k1: one key, every relationship. Which relationship a given curve may
  // actually be used for is decided where it is used (DIDComm signs with P-256/secp256k1 and agrees
  // on P-256/P-384/P-521).
  return {
    '@context': CONTEXT,
    id: did,
    verificationMethod: [method(keyId, multikey)],
    authentication: [keyId],
    assertionMethod: [keyId],
    capabilityInvocation: [keyId],
    capabilityDelegation: [keyId],
    keyAgreement: [keyId],
  };
}

export const didKeyResolver: DidResolver = {
  resolve: (did) => Promise.resolve().then(() => resolveDidKey(did)),
};
