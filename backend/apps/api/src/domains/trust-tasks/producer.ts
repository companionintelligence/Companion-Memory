import { randomUUID, type KeyObject } from 'node:crypto';

import { createEddsaJcs2022Proof } from './crypto/dataIntegrity';
import type { JsonObject, TrustTaskDocument } from './document';
import { ERROR_TYPE_URI, errorPayload, type ErrorPayloadInput } from './errors';

/**
 * Producing Trust Task documents — SPEC §7.1.
 *
 * A producer MUST emit a well-formed document with a unique `id`, the right `type`, and everything
 * task-specific in `payload`; it SHOULD set `issuedAt`, and `threadId` on a reply. This box also signs
 * every document it emits, with `authentication` as the proof purpose (§4.7.3: the proof of a Trust
 * Task shows that the party controlling `issuer` produced the document, which is what that
 * relationship authorizes a key to show — `assertionMethod` is for attestations a third party relies
 * on in its own right).
 *
 * ═══ THE CORRELATORS ARE RANDOM, NOT DERIVED ═══
 *
 * SPEC §13.1 item 2: `id` and `threadId` exist so documents can be joined, which means anything that
 * joins them for the parties joins them equally for an observer. They must be freshly minted and
 * unguessable, never derived from a subject, an account, a counter or an ask id. A random UUIDv4
 * satisfies both; `threadId` on a reply is the REQUEST's `id` (or its own `threadId`), which is itself
 * random, so a reply adds no join key the request had not already put on the wire.
 *
 * `issuedAt` is rounded down to the second (§13.1 item 3): millisecond precision is a fingerprint, and
 * nothing here needs finer than the acceptance window's own resolution.
 */

export interface DocumentSigner {
  /** The signer's VID: what goes in `issuer`. */
  readonly vid: string;
  /** The absolute verification method the proof names. */
  readonly verificationMethod: string;
  readonly privateKey: KeyObject;
}

export function newDocumentId(): string {
  return `urn:uuid:${randomUUID()}`;
}

/** RFC 3339 UTC at second precision. */
export function isoSeconds(epochMs: number): string {
  return new Date(epochMs).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export interface BuildInput {
  type: string;
  issuer: string;
  recipient: string;
  payload: JsonObject;
  threadId?: string;
  parentThreadId?: string;
  expiresAt?: string;
  now: number;
}

export function buildDocument(input: BuildInput): TrustTaskDocument {
  return {
    id: newDocumentId(),
    type: input.type,
    ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
    ...(input.parentThreadId === undefined ? {} : { parentThreadId: input.parentThreadId }),
    issuer: input.issuer,
    recipient: input.recipient,
    issuedAt: isoSeconds(input.now),
    ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
    payload: input.payload,
  };
}

/** `unsigned` plus a Data Integrity proof over everything else in it. */
export function signDocument(
  unsigned: TrustTaskDocument,
  signer: DocumentSigner,
  now: number,
): TrustTaskDocument {
  const proof = createEddsaJcs2022Proof(unsigned, {
    verificationMethod: signer.verificationMethod,
    privateKey: signer.privateKey,
    proofPurpose: 'authentication',
    created: isoSeconds(now),
  });

  return { ...unsigned, proof };
}

/** The bare Type URI of a document's `type`: the fragment, if any, removed. */
function withoutFragment(type: string): string {
  const hash = type.indexOf('#');

  return hash === -1 ? type : type.slice(0, hash);
}

/**
 * The success response to `request` (§4.4.1): the same Type URI with `#response`, addressed back to the
 * request's issuer, correlated by `threadId`, and never reusing the request's `id` (§4.9).
 */
export function buildSuccessResponse(params: {
  request: TrustTaskDocument;
  payload: JsonObject;
  signer: DocumentSigner;
  recipient: string;
  now: number;
}): TrustTaskDocument {
  const { request, payload, signer, recipient, now } = params;

  return signDocument(
    buildDocument({
      type: `${withoutFragment(request.type)}#response`,
      issuer: signer.vid,
      recipient,
      payload,
      threadId: request.threadId ?? request.id,
      // SPEC 7.1: a reply inside a nested exchange carries the same parent thread.
      ...(request.parentThreadId === undefined ? {} : { parentThreadId: request.parentThreadId }),
      now,
    }),
    signer,
    now,
  );
}

/**
 * A `trust-task-error` document (§8.1). `threadId` is set from the document being reported on when
 * there is one (§8.2: a producer of an error response MUST set it); an error about a document too
 * malformed to have an `id` carries a fresh one, so it still joins to nothing.
 */
export function buildErrorResponse(params: {
  signer: DocumentSigner;
  recipient: string;
  payload: ErrorPayloadInput;
  threadId?: string;
  parentThreadId?: string;
  now: number;
}): TrustTaskDocument {
  const { signer, recipient, payload, now } = params;

  return signDocument(
    buildDocument({
      type: ERROR_TYPE_URI,
      issuer: signer.vid,
      recipient,
      payload: errorPayload(payload),
      threadId: params.threadId ?? newDocumentId(),
      ...(params.parentThreadId === undefined ? {} : { parentThreadId: params.parentThreadId }),
      now,
    }),
    signer,
    now,
  );
}
