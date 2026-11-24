import { randomUUID } from 'node:crypto';

import { isPartyIdentifier } from './did';
import { isRecord, parseJsonObject } from './encoding';
import { DidcommError } from './errors';

/**
 * DIDComm plaintext messages (DIDComm Messaging v2.1, "Plaintext Message Structure"): the JSON
 * object every envelope ultimately carries, and the only thing application protocols see.
 *
 * Validation is structural and strict about what the specification fixes (identifier shapes, time
 * fields as integer seconds, `body` as an object, attachment `data`) and open about what it leaves
 * open: unknown top-level members are headers and are kept, untouched. `body` is never rewritten,
 * so a signature over the received object (a Trust Task's Data Integrity proof, say) still verifies
 * after the message has been through here.
 */

export const MEDIA_TYPE = {
  plain: 'application/didcomm-plain+json',
  signed: 'application/didcomm-signed+json',
  encrypted: 'application/didcomm-encrypted+json',
} as const;

export interface AttachmentData {
  jws?: unknown;
  hash?: string;
  links?: string[];
  base64?: string;
  json?: unknown;
}

export interface Attachment {
  id?: string;
  description?: string;
  filename?: string;
  media_type?: string;
  format?: string;
  lastmod_time?: number;
  byte_count?: number;
  data: AttachmentData;
}

export interface DidcommMessage {
  id: string;
  type: string;
  typ?: string;
  from?: string;
  to?: string[];
  thid?: string;
  pthid?: string;
  created_time?: number;
  expires_time?: number;
  body?: Record<string, unknown>;
  attachments?: Attachment[];
  from_prior?: string;
  [header: string]: unknown;
}

export interface MessageInit {
  type: string;
  body?: Record<string, unknown>;
  id?: string;
  from?: string;
  to?: string[];
  thid?: string;
  pthid?: string;
  created_time?: number;
  expires_time?: number;
  attachments?: Attachment[];
  from_prior?: string;
  /** Extra headers (DIDComm Messaging allows them). Names the specification defines are refused here. */
  headers?: Record<string, unknown>;
}

/** Printable ASCII, no space: wide enough for UUIDs and `urn:uuid:` ids, narrow enough to be safe in logs and URIs. */
const ID = /^[\x21-\x7e]{1,256}$/;
const TYPE = /^[\x21-\x7e]{1,512}$/;
/** RFC 3986 unreserved characters: an attachment id becomes part of a URI. */
const ATTACHMENT_ID = /^[A-Za-z0-9\-._~]{1,128}$/;
const BASE64_TEXT = /^[A-Za-z0-9+/_-]*={0,2}$/;

const MAX_RECIPIENTS = 100;
const MAX_ATTACHMENTS = 64;
const MAX_LINKS = 16;

const DEFINED_HEADERS = new Set([
  'id',
  'type',
  'typ',
  'from',
  'to',
  'thid',
  'pthid',
  'created_time',
  'expires_time',
  'body',
  'attachments',
  'from_prior',
]);

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** RFC 7515 §4.1.9: a media type without a `/` is read as having the `application/` prefix. */
export function mediaTypeMatches(actual: unknown, expected: string): boolean {
  if (typeof actual !== 'string' || actual.length === 0 || actual.length > 128) {
    return false;
  }

  const normalized = actual.includes('/') ? actual : `application/${actual}`;

  return normalized.toLowerCase() === expected;
}

function malformed(detail: string): DidcommError {
  return new DidcommError('malformed-message', `invalid DIDComm message: ${detail}`);
}

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && ID.test(value);
}

function isEpochSeconds(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function parseAttachment(value: unknown): Attachment {
  if (!isRecord(value)) {
    throw malformed('an attachment must be an object');
  }

  if (value.id !== undefined && !(typeof value.id === 'string' && ATTACHMENT_ID.test(value.id))) {
    throw malformed('an attachment "id" must be made of URI-unreserved characters');
  }

  for (const member of ['description', 'filename', 'media_type', 'format'] as const) {
    if (value[member] !== undefined && typeof value[member] !== 'string') {
      throw malformed(`attachment "${member}" must be a string`);
    }
  }

  for (const member of ['lastmod_time', 'byte_count'] as const) {
    if (value[member] !== undefined && !isEpochSeconds(value[member])) {
      throw malformed(`attachment "${member}" must be a non-negative integer`);
    }
  }

  const data = value.data;

  if (!isRecord(data)) {
    throw malformed('an attachment needs a "data" object');
  }

  const present = (['jws', 'hash', 'links', 'base64', 'json'] as const).filter(
    (member) => data[member] !== undefined,
  );

  if (present.length === 0) {
    throw malformed('attachment "data" needs one of jws, hash, links, base64 or json');
  }

  if (
    data.hash !== undefined &&
    (typeof data.hash !== 'string' || data.hash.length === 0 || data.hash.length > 512)
  ) {
    throw malformed('attachment "hash" must be a multihash string');
  }

  if (data.base64 !== undefined && !(typeof data.base64 === 'string' && BASE64_TEXT.test(data.base64))) {
    throw malformed('attachment "base64" must be base64 text');
  }

  if (data.links !== undefined) {
    if (
      !Array.isArray(data.links) ||
      data.links.length === 0 ||
      data.links.length > MAX_LINKS ||
      data.links.some((link) => typeof link !== 'string' || link.length === 0 || link.length > 2048)
    ) {
      throw malformed('attachment "links" must be a short list of URLs');
    }

    // A link is only a pointer; the hash is what makes the content checkable once fetched.
    if (data.hash === undefined) {
      throw malformed('attachment "links" need a "hash" to check the fetched content against');
    }
  }

  return value as unknown as Attachment;
}

/**
 * Checks a parsed JSON value against the plaintext message structure and returns it typed. The
 * input is not copied or normalized; a message without `body` stays without one (v2.1 allows that
 * on receipt).
 */
export function parseMessage(value: unknown): DidcommMessage {
  if (!isRecord(value)) {
    throw malformed('not a JSON object');
  }

  if (Object.prototype.hasOwnProperty.call(value, '__proto__')) {
    throw malformed('contains a "__proto__" member');
  }

  if (!isIdentifier(value.id)) {
    throw malformed('"id" is required (printable ASCII, up to 256 characters)');
  }

  if (typeof value.type !== 'string' || !TYPE.test(value.type)) {
    throw malformed('"type" is required (a message type URI)');
  }

  if (value.typ !== undefined && !mediaTypeMatches(value.typ, MEDIA_TYPE.plain)) {
    throw malformed(`"typ" must be ${MEDIA_TYPE.plain}`);
  }

  if (value.from !== undefined && !isPartyIdentifier(value.from)) {
    throw malformed('"from" must be a DID (a party, not a key)');
  }

  if (value.to !== undefined) {
    if (
      !Array.isArray(value.to) ||
      value.to.length === 0 ||
      value.to.length > MAX_RECIPIENTS ||
      !value.to.every(isPartyIdentifier)
    ) {
      throw malformed('"to" must be a non-empty array of DIDs');
    }
  }

  for (const member of ['thid', 'pthid'] as const) {
    if (value[member] !== undefined && !isIdentifier(value[member])) {
      throw malformed(`"${member}" must be an identifier`);
    }
  }

  for (const member of ['created_time', 'expires_time'] as const) {
    if (value[member] !== undefined && !isEpochSeconds(value[member])) {
      throw malformed(`"${member}" must be an integer number of seconds since the epoch`);
    }
  }

  if (value.body !== undefined && !isRecord(value.body)) {
    throw malformed('"body" must be an object');
  }

  if (
    value.from_prior !== undefined &&
    (typeof value.from_prior !== 'string' || value.from_prior.length > 8192)
  ) {
    throw malformed('"from_prior" must be a JWT string');
  }

  if (value.attachments !== undefined) {
    if (!Array.isArray(value.attachments) || value.attachments.length > MAX_ATTACHMENTS) {
      throw malformed(`"attachments" must be an array of at most ${MAX_ATTACHMENTS}`);
    }

    value.attachments.forEach(parseAttachment);
  }

  return value as DidcommMessage;
}

/** Parses JSON text into a message. */
export function parseMessageJson(text: string): DidcommMessage {
  return parseMessage(parseJsonObject(text, 'message', 'malformed-message'));
}

/**
 * Builds an outgoing message with a fresh UUID id and the current time, then validates it, so a
 * bad DID in `to` fails here and not in a remote agent. `body` defaults to `{}` (always send it:
 * v2.0 receivers require it).
 */
export function createMessage(init: MessageInit, now: number = nowSeconds()): DidcommMessage {
  for (const name of Object.keys(init.headers ?? {})) {
    if (DEFINED_HEADERS.has(name)) {
      throw new DidcommError(
        'invalid-argument',
        `"${name}" is a defined header; pass it as a field, not in headers`,
      );
    }
  }

  const message: DidcommMessage = {
    id: init.id ?? randomUUID(),
    typ: MEDIA_TYPE.plain,
    type: init.type,
    ...(init.from !== undefined ? { from: init.from } : {}),
    ...(init.to !== undefined ? { to: init.to } : {}),
    ...(init.thid !== undefined ? { thid: init.thid } : {}),
    ...(init.pthid !== undefined ? { pthid: init.pthid } : {}),
    created_time: init.created_time ?? now,
    ...(init.expires_time !== undefined ? { expires_time: init.expires_time } : {}),
    ...(init.from_prior !== undefined ? { from_prior: init.from_prior } : {}),
    body: init.body ?? {},
    ...(init.attachments !== undefined ? { attachments: init.attachments } : {}),
    ...(init.headers ?? {}),
  };

  return parseMessage(message);
}

/** The thread a message belongs to: `thid`, or its own `id` when it starts a thread. */
export function threadIdOf(message: DidcommMessage): string {
  return message.thid ?? message.id;
}

/** True when `expires_time` has passed, allowing for clock skew between the parties. */
export function isExpired(message: DidcommMessage, now: number, skewSeconds = 0): boolean {
  return message.expires_time !== undefined && message.expires_time + skewSeconds < now;
}

/** The decoded bytes of a `base64` attachment (base64 or base64url, padded or not), or `undefined` if it has none. */
export function attachmentBytes(attachment: Attachment): Buffer | undefined {
  const text = attachment.data.base64;

  if (text === undefined) {
    return undefined;
  }

  return Buffer.from(text.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}
