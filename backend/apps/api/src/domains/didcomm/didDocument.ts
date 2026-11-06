import { didOf, isDid, isDidUrl, MAX_DID_LENGTH } from './did';
import { base58btcDecode, base64urlEncode, isRecord } from './encoding';
import { DidcommError } from './errors';
import { type KeyCurve, parsePublicJwk, type PublicJwk } from './jwk';
import { jwkFromMultikey } from './multikey';

/**
 * The slice of a DID document DIDComm uses: the keys behind each verification relationship and the
 * `DIDCommMessaging` service endpoints. A DID document is remote input, so everything here is
 * checked as it is read and anything unusable is skipped rather than guessed at.
 *
 * Rules that matter for security:
 *
 *   - A key is identified by its absolute DID URL, and that URL must belong to the document's own
 *     DID. A relationship entry pointing into another DID's document is ignored, never fetched.
 *   - The verification-method type has to agree with the key material (an
 *     `X25519KeyAgreementKey2020` holding an Ed25519 key is not an X25519 key).
 *   - Which keys are *authorized* is the relationship they are listed under, not their curve:
 *     DIDComm signatures are checked against `authentication`, key agreement against `keyAgreement`.
 */

export type VerificationRelationship =
  'authentication' | 'assertionMethod' | 'keyAgreement' | 'capabilityInvocation' | 'capabilityDelegation';

export interface VerificationMethod {
  id: string;
  type: string;
  controller?: string;
  publicKeyJwk?: unknown;
  publicKeyMultibase?: string;
  publicKeyBase58?: string;
  [member: string]: unknown;
}

export interface DidService {
  id: string;
  type: string | string[];
  serviceEndpoint: unknown;
  [member: string]: unknown;
}

export interface DidDocument {
  '@context'?: unknown;
  id: string;
  verificationMethod?: VerificationMethod[];
  authentication?: Array<string | VerificationMethod>;
  assertionMethod?: Array<string | VerificationMethod>;
  keyAgreement?: Array<string | VerificationMethod>;
  capabilityInvocation?: Array<string | VerificationMethod>;
  capabilityDelegation?: Array<string | VerificationMethod>;
  service?: DidService[];
  [member: string]: unknown;
}

/** Anything that turns a DID into its document. See `resolver.ts` for the implementations. */
export interface DidResolver {
  resolve(did: string): Promise<DidDocument>;
}

/** A verification method that parsed into a usable public key. */
export interface DocumentKey {
  /** Absolute DID URL, e.g. `did:example:bob#key-1`. */
  id: string;
  did: string;
  type: string;
  jwk: PublicJwk;
}

export interface DidcommEndpoint {
  id: string;
  /** An `https:`/`wss:` URL, or a DID when the recipient sits behind a mediator. */
  uri: string;
  accept: string[];
  routingKeys: string[];
}

const MAX_ENTRIES = 256;
const MAX_URI_LENGTH = 2048;

const RELATIONSHIPS: readonly VerificationRelationship[] = [
  'authentication',
  'assertionMethod',
  'keyAgreement',
  'capabilityInvocation',
  'capabilityDelegation',
];

/** Verification-method types that fix the curve, and so can be cross-checked against the key. */
const TYPE_CURVE: Record<string, KeyCurve> = {
  Ed25519VerificationKey2018: 'Ed25519',
  Ed25519VerificationKey2020: 'Ed25519',
  X25519KeyAgreementKey2019: 'X25519',
  X25519KeyAgreementKey2020: 'X25519',
  EcdsaSecp256k1VerificationKey2019: 'secp256k1',
  EcdsaSecp256r1VerificationKey2019: 'P-256',
};

/** Types that carry any curve in their own material. */
const GENERIC_TYPES = new Set(['JsonWebKey2020', 'JsonWebKey', 'Multikey']);

/**
 * Structural checks on a resolved document: an object whose `id` is the DID that was asked for, and
 * arrays where arrays belong. The `id` check is what stops a resolver, or a `did:web` host, from
 * answering for someone else's DID.
 */
export function parseDidDocument(value: unknown, expectedDid?: string): DidDocument {
  if (!isRecord(value) || !isDid(value.id)) {
    throw new DidcommError('did-document-invalid', 'a DID document needs an "id" that is a DID');
  }

  if (expectedDid !== undefined && value.id !== expectedDid) {
    throw new DidcommError('did-document-invalid', 'the DID document is for a different DID');
  }

  for (const member of ['verificationMethod', 'service', ...RELATIONSHIPS]) {
    const entries = value[member];

    if (entries === undefined) {
      continue;
    }

    if (!Array.isArray(entries) || entries.length > MAX_ENTRIES) {
      throw new DidcommError(
        'did-document-invalid',
        `"${member}" must be an array of at most ${MAX_ENTRIES} entries`,
      );
    }
  }

  return value as DidDocument;
}

function absoluteId(reference: unknown, didId: string): string | undefined {
  if (typeof reference !== 'string' || reference.length > MAX_DID_LENGTH) {
    return undefined;
  }

  const id = reference.startsWith('#') ? `${didId}${reference}` : reference;

  // Never follow a reference into another DID's document.
  return isDidUrl(id) && didOf(id) === didId ? id : undefined;
}

function materialToJwk(method: VerificationMethod): PublicJwk | undefined {
  const present = [method.publicKeyJwk, method.publicKeyMultibase, method.publicKeyBase58].filter(
    (member) => member !== undefined,
  );

  if (present.length !== 1) {
    return undefined;
  }

  if (method.publicKeyJwk !== undefined) {
    return parsePublicJwk(method.publicKeyJwk);
  }

  if (typeof method.publicKeyMultibase === 'string') {
    return jwkFromMultikey(method.publicKeyMultibase);
  }

  if (typeof method.publicKeyBase58 === 'string') {
    const crv = TYPE_CURVE[method.type];

    // Legacy base58 material has no multicodec prefix, so it is only readable where the type says
    // which 32-byte curve it is.
    if (crv !== 'Ed25519' && crv !== 'X25519') {
      return undefined;
    }

    const raw = base58btcDecode(method.publicKeyBase58);

    return raw.length === 32 ? parsePublicJwk({ kty: 'OKP', crv, x: base64urlEncode(raw) }) : undefined;
  }

  return undefined;
}

/** Reads one verification method. `undefined` means "not a key this domain can use", never a guess. */
function documentKey(method: unknown, didId: string): DocumentKey | undefined {
  if (!isRecord(method) || typeof method.type !== 'string') {
    return undefined;
  }

  const id = absoluteId(method.id, didId);

  if (id === undefined || id === didId) {
    return undefined;
  }

  const typed = method as VerificationMethod;
  const fixedCurve = TYPE_CURVE[typed.type];

  if (fixedCurve === undefined && !GENERIC_TYPES.has(typed.type)) {
    return undefined;
  }

  let jwk: PublicJwk | undefined;

  try {
    jwk = materialToJwk(typed);
  } catch {
    return undefined;
  }

  if (!jwk || (fixedCurve !== undefined && jwk.crv !== fixedCurve)) {
    return undefined;
  }

  return { id, did: didId, type: typed.type, jwk: { ...jwk, kid: id } };
}

/**
 * The usable keys listed under a relationship, in document order, resolved from references or
 * embedded definitions. Duplicate ids and unusable entries are dropped.
 */
export function relationshipKeys(doc: DidDocument, relationship: VerificationRelationship): DocumentKey[] {
  const entries = doc[relationship];

  if (entries === undefined) {
    return [];
  }

  if (!Array.isArray(entries)) {
    throw new DidcommError('did-document-invalid', `"${relationship}" must be an array`);
  }

  const methods = new Map<string, unknown>();

  for (const method of (doc.verificationMethod ?? []).slice(0, MAX_ENTRIES)) {
    const id = isRecord(method) ? absoluteId(method.id, doc.id) : undefined;

    if (id !== undefined && !methods.has(id)) {
      methods.set(id, method);
    }
  }

  const keys: DocumentKey[] = [];
  const seen = new Set<string>();

  for (const entry of entries.slice(0, MAX_ENTRIES)) {
    const method = typeof entry === 'string' ? methods.get(absoluteId(entry, doc.id) ?? '') : entry;
    const key = documentKey(method, doc.id);

    if (key && !seen.has(key.id)) {
      seen.add(key.id);
      keys.push(key);
    }
  }

  return keys;
}

/** The key with this exact id under this relationship, or a `key-not-found` error. */
export function keyForKid(
  doc: DidDocument,
  kid: string,
  relationship: VerificationRelationship,
): DocumentKey {
  const key = relationshipKeys(doc, relationship).find((candidate) => candidate.id === kid);

  if (!key) {
    throw new DidcommError(
      'key-not-found',
      `no usable "${relationship}" key ${kid} in the DID document of ${doc.id}`,
    );
  }

  return key;
}

function stringArray(value: unknown): string[] | undefined {
  if (value === undefined) {
    return [];
  }

  if (!Array.isArray(value) || value.length > MAX_ENTRIES || value.some((item) => typeof item !== 'string')) {
    return undefined;
  }

  return value as string[];
}

/**
 * The `DIDCommMessaging` service endpoints (DIDComm Messaging v2.1, "Service Endpoint"), in the
 * order the document lists them, which is the owner's order of preference. An entry with a
 * malformed endpoint is skipped, so one bad entry does not hide a good one.
 */
export function didcommEndpoints(doc: DidDocument): DidcommEndpoint[] {
  const endpoints: DidcommEndpoint[] = [];

  for (const service of (doc.service ?? []).slice(0, MAX_ENTRIES)) {
    if (!isRecord(service) || typeof service.id !== 'string') {
      continue;
    }

    const types = Array.isArray(service.type) ? service.type : [service.type];

    if (!types.includes('DIDCommMessaging')) {
      continue;
    }

    const id = absoluteId(service.id, doc.id) ?? service.id;
    const declared = Array.isArray(service.serviceEndpoint)
      ? service.serviceEndpoint
      : [service.serviceEndpoint];

    for (const entry of declared.slice(0, MAX_ENTRIES)) {
      if (
        !isRecord(entry) ||
        typeof entry.uri !== 'string' ||
        entry.uri.length === 0 ||
        entry.uri.length > MAX_URI_LENGTH
      ) {
        continue;
      }

      const accept = stringArray(entry.accept);
      const routingKeys = stringArray(entry.routingKeys);

      if (accept === undefined || routingKeys === undefined || !routingKeys.every(isDidUrl)) {
        continue;
      }

      endpoints.push({ id, uri: entry.uri, accept, routingKeys });
    }
  }

  return endpoints;
}
