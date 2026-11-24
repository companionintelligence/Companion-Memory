import { createPrivateKey, randomBytes } from 'node:crypto';

import { didKeyFromJwk, didKeyVerificationMethodId } from './didKey';
import { createDidPeer2, type PeerServiceInput } from './didPeer';
import { ed25519PublicKeyToX25519, ed25519SeedToX25519Secret } from './edwards';
import { base64urlDecode, base64urlEncode } from './encoding';
import { DidcommError } from './errors';
import { generateKeyPair, parsePrivateJwk, type PrivateJwk, publicJwkOf } from './jwk';
import { multikeyFromJwk } from './multikey';
import { InMemorySecretsResolver } from './secrets';

/**
 * Ready-made DIDComm identities: a DID plus the private keys behind it.
 *
 * `did:key` is the identity that needs no setup and no network, and the bridge to what Companion
 * Memory already has: one Ed25519 key (the 32-byte seed behind a peer's `did:keri:D<x>` key id,
 * which is that convention's own spelling and no KERI) yields a `did:key` that signs with the
 * Ed25519 key and receives with the X25519 key derived from it, with no new key material.
 *
 * `did:peer:2` is the identity to hand a single counterparty: fresh keys, and a service endpoint in
 * the identifier itself, so nothing about it is shared with any other relationship.
 */
export interface DidcommIdentity {
  did: string;
  /** Key id used to sign (`authentication`). */
  signingKid: string;
  /** Key id used for ECDH (`keyAgreement`). */
  agreementKid: string;
  /** Both private keys, `kid` set. Secret material: hand to a {@link SecretsResolver}, never log. */
  secrets: PrivateJwk[];
}

/** An identity from an existing Ed25519 seed (RFC 8032: the 32 secret bytes, not the 64-byte expanded key). */
export function didKeyIdentityFromEd25519Seed(seed: Uint8Array): DidcommIdentity {
  if (seed.length !== 32) {
    throw new DidcommError('invalid-key', 'an Ed25519 seed is 32 bytes');
  }

  const edKey = createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]),
    format: 'der',
    type: 'pkcs8',
  });
  const edJwk = edKey.export({ format: 'jwk' });
  const edPublic = publicJwkOf({ kty: 'OKP', crv: 'Ed25519', x: edJwk.x as string });
  const did = didKeyFromJwk(edPublic);

  const x25519Public = base64urlEncode(
    ed25519PublicKeyToX25519(base64urlDecode(edPublic.x, 'x', 'invalid-key')),
  );
  const agreementPublic = publicJwkOf({ kty: 'OKP', crv: 'X25519', x: x25519Public });

  const signingKid = didKeyVerificationMethodId(did, multikeyFromJwk(edPublic));
  const agreementKid = didKeyVerificationMethodId(did, multikeyFromJwk(agreementPublic));

  return {
    did,
    signingKid,
    agreementKid,
    secrets: [
      parsePrivateJwk({ kty: 'OKP', crv: 'Ed25519', x: edPublic.x, d: edJwk.d, kid: signingKid }),
      parsePrivateJwk({
        kty: 'OKP',
        crv: 'X25519',
        x: x25519Public,
        d: base64urlEncode(ed25519SeedToX25519Secret(seed)),
        kid: agreementKid,
      }),
    ],
  };
}

export function generateDidKeyIdentity(): DidcommIdentity {
  return didKeyIdentityFromEd25519Seed(randomBytes(32));
}

/**
 * A fresh `did:peer:2` identity: an X25519 key for `keyAgreement` (`#key-1`), an Ed25519 key for
 * `authentication` (`#key-2`), and optionally a `DIDCommMessaging` service endpoint.
 */
export function generateDidPeerIdentity(service?: PeerServiceInput): DidcommIdentity {
  const agreement = generateKeyPair('X25519');
  const signing = generateKeyPair('Ed25519');
  const did = createDidPeer2({
    keys: [
      { purpose: 'keyAgreement', jwk: agreement.publicJwk },
      { purpose: 'authentication', jwk: signing.publicJwk },
    ],
    services: service ? [service] : [],
  });
  const agreementKid = `${did}#key-1`;
  const signingKid = `${did}#key-2`;

  return {
    did,
    signingKid,
    agreementKid,
    secrets: [
      parsePrivateJwk({ ...agreement.privateJwk, kid: agreementKid }),
      parsePrivateJwk({ ...signing.privateJwk, kid: signingKid }),
    ],
  };
}

export function secretsOf(...identities: DidcommIdentity[]): InMemorySecretsResolver {
  return new InMemorySecretsResolver(identities.flatMap((identity) => identity.secrets));
}
