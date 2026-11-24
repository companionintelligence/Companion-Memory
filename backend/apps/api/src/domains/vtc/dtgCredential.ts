import { DTG_CONTEXT_V1, W3C_CREDENTIALS_V2 } from './contexts';
import { parseDateTime } from './dateTime';
import { isPlainObject, type JsonObject } from './json';
import { parseStatusEntry, StatusListError, type BitstringStatusListEntry } from './statusList';

/**
 * The envelope of a DTG Credentials v1 credential (https://github.com/trustoverip/dtgwg-cred-spec,
 * Working Draft 0.6.0), as the Verifiable Trust Community (OpenVTC) issues and reads it.
 *
 *     {
 *       "@context": ["https://www.w3.org/ns/credentials/v2",
 *                    "https://registry.trustoverip.org/dtg/context/v1"],
 *       "type": ["VerifiableCredential", "DTGCredential", "MembershipCredential"],
 *       "issuer": "did:…", "issuerScope": "public",
 *       "validFrom": "…", "validUntil": "…",
 *       "credentialSubject": { "id": "did:…" },
 *       "credentialStatus": { "type": "BitstringStatusListEntry", … },
 *       "proof": { … }
 *     }
 *
 * The parser is strict on purpose. Where the reference implementation is strict too (its README,
 * "A parse refuses anything else") it agrees: `type` holding `VerifiableCredential`,
 * `DTGCredential` and EXACTLY ONE concrete subtype; `PersonhoodCredential` allowed only as a hint
 * on a membership credential; a REQUIRED `issuerScope`. A looser reading would let a document that
 * two implementations classify differently be accepted by the one that is easier to fool.
 *
 * It is deliberately STRICTER than the reference and the specification about `@context`: exactly
 * the W3C VC 2.0 context and then the DTG v1 context, as exact strings, and nothing after them. The
 * reference also reads the VC 1.1 context first and tolerates further contexts, so a credential
 * carrying either is refused here and read there. Nothing is interpreted as JSON-LD (proofs are
 * over canonical JSON), so a context this module cannot name could redefine terms for a JSON-LD
 * consumer while this module reads the same bytes differently; refusing it keeps the two readings
 * identical. Loosening this is an interop decision to take against a real credential.
 *
 * This file reads the envelope. It does not verify the proof (`dataIntegrity.ts`), check the
 * status (`statusList.ts`) or decide whether the issuer is trusted (`recognition.ts`).
 */

export type IssuerScope = 'pairwise' | 'directed' | 'public';

const ISSUER_SCOPES: readonly string[] = ['pairwise', 'directed', 'public'];

export const DTG_SUBTYPES = [
  'MembershipCredential',
  'RelationshipCredential',
  'DelegationCredential',
  'InvitationCredential',
  'PersonaCredential',
  'StatementCredential',
  'AuthorityCredential',
] as const;

export type DtgSubtype = (typeof DTG_SUBTYPES)[number];

/** Refused by name: two became predicate profiles of `StatementCredential`, one is not a credential. */
const RETIRED_TYPES: ReadonlySet<string> = new Set([
  'EndorsementCredential',
  'WitnessCredential',
  'RCardCredential',
]);

/** The most status entries (one per purpose) read from one credential. */
const MAX_STATUS_ENTRIES = 4;

export type DtgParseCode =
  | 'NOT_AN_OBJECT'
  | 'CONTEXT'
  | 'TYPE'
  | 'RETIRED_TYPE'
  | 'ID'
  | 'ISSUER'
  | 'ISSUER_SCOPE'
  | 'VALIDITY'
  | 'SUBJECT'
  | 'STATUS';

export class DtgParseError extends Error {
  constructor(
    readonly code: DtgParseCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'DtgParseError';
  }
}

export interface DtgCredential {
  /** The document as received. Verify its proof against THIS, never against a re-serialization. */
  raw: JsonObject;
  id: string | null;
  subtype: DtgSubtype;
  /** A `PersonhoodCredential` type riding on a membership credential. A hint, never authority. */
  personhoodHint: boolean;
  issuer: string;
  issuerScope: IssuerScope;
  validFrom: Date;
  validUntil: Date | null;
  /** `credentialSubject.id`. */
  subject: string;
  /**
   * `credentialSubject.digestMultibase`. A member-issued ACKNOWLEDGEMENT of a membership carries
   * one (it digests the grant being acknowledged) and a community's own grant never does, so a
   * membership credential with a digest is the member speaking about the community, not the
   * other way round.
   */
  subjectDigest: string | null;
  status: BitstringStatusListEntry[];
}

const DID = /^did:[a-z0-9]+:[A-Za-z0-9._%:-]+$/;

function isDid(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 2048 && DID.test(value);
}

function isSubtype(type: string): type is DtgSubtype {
  return (DTG_SUBTYPES as readonly string[]).includes(type);
}

function readTypes(document: JsonObject): { subtype: DtgSubtype; personhoodHint: boolean } {
  const { type } = document;
  if (!Array.isArray(type) || !type.every((entry): entry is string => typeof entry === 'string')) {
    throw new DtgParseError('TYPE', 'type must be an array of strings');
  }

  if (new Set(type).size !== type.length) {
    throw new DtgParseError('TYPE', 'type repeats a value');
  }

  if (!type.includes('VerifiableCredential') || !type.includes('DTGCredential')) {
    throw new DtgParseError('TYPE', 'type must hold VerifiableCredential and DTGCredential');
  }

  const rest = type.filter((entry) => entry !== 'VerifiableCredential' && entry !== 'DTGCredential');
  const retired = rest.find((entry) => RETIRED_TYPES.has(entry));
  if (retired) {
    throw new DtgParseError('RETIRED_TYPE', `${retired} is retired and not an alias for anything`);
  }

  const subtypes = rest.filter(isSubtype);
  const [subtype] = subtypes;
  if (subtypes.length !== 1 || subtype === undefined) {
    throw new DtgParseError('TYPE', 'type must hold exactly one DTG credential subtype');
  }

  const extras = rest.filter((entry) => !isSubtype(entry));
  const personhoodHint =
    extras.length === 1 && extras[0] === 'PersonhoodCredential' && subtype === 'MembershipCredential';
  if (extras.length > 0 && !personhoodHint) {
    throw new DtgParseError('TYPE', `unexpected type ${JSON.stringify(extras[0])}`);
  }

  return { subtype, personhoodHint };
}

function readValidity(document: JsonObject): { validFrom: Date; validUntil: Date | null } {
  const validFrom = parseDateTime(document.validFrom);
  if (!validFrom) {
    throw new DtgParseError('VALIDITY', 'validFrom is required and must be a date-time');
  }

  if (document.validUntil === undefined) {
    return { validFrom, validUntil: null };
  }

  const validUntil = parseDateTime(document.validUntil);
  if (!validUntil || validUntil.getTime() <= validFrom.getTime()) {
    throw new DtgParseError('VALIDITY', 'validUntil must be a date-time after validFrom');
  }

  return { validFrom, validUntil };
}

function readStatus(document: JsonObject): BitstringStatusListEntry[] {
  const { credentialStatus } = document;
  if (credentialStatus === undefined) {
    return [];
  }

  const entries: unknown[] = Array.isArray(credentialStatus) ? credentialStatus : [credentialStatus];
  if (entries.length === 0 || entries.length > MAX_STATUS_ENTRIES) {
    throw new DtgParseError('STATUS', `credentialStatus holds 1 to ${MAX_STATUS_ENTRIES} entries`);
  }

  try {
    return entries.map(parseStatusEntry);
  } catch (error) {
    if (error instanceof StatusListError) {
      throw new DtgParseError('STATUS', error.message);
    }

    throw error;
  }
}

/** Reads a DTG v1 credential, or throws `DtgParseError` naming the first rule it breaks. */
export function parseDtgCredential(document: unknown): DtgCredential {
  if (!isPlainObject(document)) {
    throw new DtgParseError('NOT_AN_OBJECT', 'a credential is a JSON object');
  }

  const context = document['@context'];
  if (
    !Array.isArray(context) ||
    context.length !== 2 ||
    context[0] !== W3C_CREDENTIALS_V2 ||
    context[1] !== DTG_CONTEXT_V1
  ) {
    throw new DtgParseError('CONTEXT', `@context must be exactly [${W3C_CREDENTIALS_V2}, ${DTG_CONTEXT_V1}]`);
  }

  const { subtype, personhoodHint } = readTypes(document);

  const { id } = document;
  if (id !== undefined && (typeof id !== 'string' || id === '' || id.length > 2048 || /\s/.test(id))) {
    throw new DtgParseError('ID', 'id must be a URI without whitespace');
  }

  if (!isDid(document.issuer)) {
    throw new DtgParseError('ISSUER', 'issuer must be a DID string');
  }

  const { issuerScope } = document;
  if (typeof issuerScope !== 'string' || !ISSUER_SCOPES.includes(issuerScope)) {
    throw new DtgParseError('ISSUER_SCOPE', 'issuerScope is required: pairwise, directed or public');
  }

  const { validFrom, validUntil } = readValidity(document);

  const subject = document.credentialSubject;
  if (!isPlainObject(subject) || !isDid(subject.id)) {
    throw new DtgParseError('SUBJECT', 'credentialSubject must be one object with a DID id');
  }

  const digest = subject.digestMultibase;
  if (
    digest !== undefined &&
    (typeof digest !== 'string' || digest === '' || digest.length > 256 || /\s/.test(digest))
  ) {
    throw new DtgParseError('SUBJECT', 'digestMultibase must be a short string without whitespace');
  }

  return {
    raw: document,
    id: id === undefined ? null : id,
    subtype,
    personhoodHint,
    issuer: document.issuer,
    issuerScope: issuerScope as IssuerScope,
    validFrom,
    validUntil,
    subject: subject.id,
    subjectDigest: digest === undefined ? null : digest,
    status: readStatus(document),
  };
}
