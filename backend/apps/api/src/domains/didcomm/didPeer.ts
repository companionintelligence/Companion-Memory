import { type DidDocument, type DidResolver } from './didDocument';
import { base64urlDecode, base64urlEncode, isRecord, utf8Decode, utf8Encode } from './encoding';
import { DidcommError } from './errors';
import { isKeyAgreementCurve, type PublicJwk } from './jwk';
import { jwkFromMultikey, multikeyFromJwk } from './multikey';

/**
 * `did:peer` numalgo 2 (https://identity.foundation/peer-did-method-spec/): a DID that carries its
 * own document. Keys and services are encoded in the identifier, so it resolves with no network and
 * can be minted per relationship, which is why DIDComm uses it for pairwise identities.
 *
 *     did:peer:2 . E<multikey> . V<multikey> . S<base64url(service JSON)>
 *
 * | purpose | relationship      |
 * | ------- | ----------------- |
 * | `E`     | keyAgreement      |
 * | `V`     | authentication    |
 * | `A`     | assertionMethod   |
 * | `I`     | capabilityInvocation |
 * | `D`     | capabilityDelegation |
 * | `S`     | service           |
 *
 * Key ids are `#key-1`, `#key-2`, … in order of appearance; services are `#service`, `#service-1`, …
 * (the resolver here returns them absolute, `did:peer:2…#key-1`, because that is what goes in a
 * DIDComm `kid`/`skid`). Both sides of a conversation must derive the same ids, so these rules are
 * the interoperable part and are tested against the specification's example.
 *
 * Not supported, and refused with `unsupported-did-method`: numalgo 0, 1, 3 and 4. Numalgo 0 is a
 * `did:key` with a different prefix and has no agreed key-id scheme; numalgo 4 (long form) is the
 * likely next addition.
 */

const PREFIX = 'did:peer:2';

const CONTEXT = ['https://www.w3.org/ns/did/v1', 'https://w3id.org/security/multikey/v1'];

export type PeerKeyPurpose =
  'keyAgreement' | 'authentication' | 'assertionMethod' | 'capabilityInvocation' | 'capabilityDelegation';

const PURPOSE_CODE: Record<PeerKeyPurpose, string> = {
  keyAgreement: 'E',
  authentication: 'V',
  assertionMethod: 'A',
  capabilityInvocation: 'I',
  capabilityDelegation: 'D',
};

const CODE_PURPOSE = new Map<string, PeerKeyPurpose>(
  Object.entries(PURPOSE_CODE).map(([purpose, code]) => [code, purpose as PeerKeyPurpose]),
);

const MAX_ELEMENTS = 64;

export interface PeerKeyInput {
  purpose: PeerKeyPurpose;
  jwk: PublicJwk;
}

export interface PeerServiceInput {
  /** Where to POST DIDComm messages: an `https:`/`wss:` URL, or a mediator's DID. */
  uri: string;
  routingKeys?: string[];
  accept?: string[];
}

/** Builds a `did:peer:2` from keys and `DIDCommMessaging` services. */
export function createDidPeer2(input: { keys: PeerKeyInput[]; services?: PeerServiceInput[] }): string {
  if (input.keys.length === 0) {
    throw new DidcommError('invalid-argument', 'a did:peer:2 needs at least one key');
  }

  const elements = input.keys.map(({ purpose, jwk }) => {
    const code = PURPOSE_CODE[purpose];

    if (!code) {
      throw new DidcommError('invalid-argument', `unknown key purpose ${String(purpose)}`);
    }

    if (purpose === 'keyAgreement' ? !isKeyAgreementCurve(jwk.crv) : jwk.crv === 'X25519') {
      throw new DidcommError('invalid-argument', `a ${jwk.crv} key cannot serve as ${purpose}`);
    }

    return `${code}${multikeyFromJwk(jwk)}`;
  });

  for (const service of input.services ?? []) {
    const abbreviated: Record<string, unknown> = { t: 'dm', s: service.uri };

    if (service.routingKeys?.length) {
      abbreviated.r = service.routingKeys;
    }

    if (service.accept?.length) {
      abbreviated.a = service.accept;
    }

    elements.push(`S${base64urlEncode(utf8Encode(JSON.stringify(abbreviated)))}`);
  }

  return `${PREFIX}.${elements.join('.')}`;
}

function parseServiceJson(encoded: string): unknown[] {
  const text = utf8Decode(
    base64urlDecode(encoded, 'did:peer service', 'did-document-invalid'),
    'did:peer service',
    'did-document-invalid',
  );

  let json: unknown;

  try {
    json = JSON.parse(text);
  } catch {
    throw new DidcommError('did-document-invalid', 'did:peer service is not valid JSON');
  }

  return Array.isArray(json) ? json : [json];
}

function serviceFrom(did: string, index: number, encoded: string): NonNullable<DidDocument['service']> {
  const entries = parseServiceJson(encoded);

  return entries.map((entry, offset) => {
    if (!isRecord(entry) || typeof entry.t !== 'string') {
      throw new DidcommError('did-document-invalid', 'did:peer service needs a type ("t")');
    }

    const position = index + offset;
    const id = `${did}#service${position === 0 ? '' : `-${position}`}`;

    if (entry.t === 'dm') {
      if (typeof entry.s !== 'string') {
        throw new DidcommError('did-document-invalid', 'did:peer DIDCommMessaging service needs a URI ("s")');
      }

      const endpoint: Record<string, unknown> = { uri: entry.s };

      if (entry.r !== undefined) {
        endpoint.routingKeys = entry.r;
      }

      if (entry.a !== undefined) {
        endpoint.accept = entry.a;
      }

      return { id, type: 'DIDCommMessaging', serviceEndpoint: endpoint };
    }

    return { id, type: entry.t, serviceEndpoint: entry.s };
  });
}

export function resolveDidPeer(did: string): DidDocument {
  if (typeof did !== 'string' || !did.startsWith('did:peer:')) {
    throw new DidcommError('unsupported-did-method', 'not a did:peer identifier');
  }

  if (!did.startsWith(`${PREFIX}.`)) {
    throw new DidcommError(
      'unsupported-did-method',
      `did:peer numalgo ${did.charAt('did:peer:'.length) || '?'} is not supported (only numalgo 2)`,
    );
  }

  const elements = did.slice(PREFIX.length + 1).split('.');

  if (
    elements.length === 0 ||
    elements.length > MAX_ELEMENTS ||
    elements.some((element) => element.length < 2)
  ) {
    throw new DidcommError('did-document-invalid', 'malformed did:peer:2 element list');
  }

  const verificationMethod: NonNullable<DidDocument['verificationMethod']> = [];
  const relationships: Partial<Record<PeerKeyPurpose, string[]>> = {};
  const services: NonNullable<DidDocument['service']> = [];

  for (const element of elements) {
    const code = element.charAt(0);
    const value = element.slice(1);

    if (code === 'S') {
      services.push(...serviceFrom(did, services.length, value));
      continue;
    }

    const purpose = CODE_PURPOSE.get(code);

    if (!purpose) {
      throw new DidcommError('did-document-invalid', `unknown did:peer purpose code "${code}"`);
    }

    const jwk = jwkFromMultikey(value);

    if (purpose === 'keyAgreement' ? !isKeyAgreementCurve(jwk.crv) : jwk.crv === 'X25519') {
      throw new DidcommError('did-document-invalid', `a ${jwk.crv} key is not valid as ${purpose}`);
    }

    const id = `${did}#key-${verificationMethod.length + 1}`;

    verificationMethod.push({ id, type: 'Multikey', controller: did, publicKeyMultibase: value });
    (relationships[purpose] ??= []).push(id);
  }

  if (verificationMethod.length === 0) {
    throw new DidcommError('did-document-invalid', 'a did:peer:2 needs at least one key');
  }

  return {
    '@context': CONTEXT,
    id: did,
    verificationMethod,
    ...relationships,
    ...(services.length > 0 ? { service: services } : {}),
  };
}

export const didPeerResolver: DidResolver = {
  resolve: (did) => Promise.resolve().then(() => resolveDidPeer(did)),
};
