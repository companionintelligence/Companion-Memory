/**
 * Stored shapes of the three PWS container levels, and the validators that version them.
 *
 * These are the *store's* records, not the wire documents: a record carries what the server needs
 * (validators, the stored bytes) and `views.ts` projects it into the Metadata objects the
 * specification defines. Timestamps are RFC 3339 strings so a record survives JSON storage.
 */
import { randomBytes } from 'node:crypto';

import type { JsonObject } from './dataIntegrity';
import type { Stamp } from './stamp';

/**
 * A server-managed version validator (spec "Conditional Requests"): an opaque strong ETag that
 * changes on every write and is never reused after the entity is deleted and re-created. The
 * `nonce` is minted when the entity is created, so a re-created entity starts a new sequence.
 */
export interface Validator {
  readonly nonce: string;
  readonly n: number;
}

export function newValidator(): Validator {
  return { nonce: randomBytes(4).toString('base64url').replace(/[-_]/g, 'x').toLowerCase(), n: 1 };
}

export function bump(validator: Validator): Validator {
  return { nonce: validator.nonce, n: validator.n + 1 };
}

/** The strong entity-tag form: `"nonce.n"`. */
export function etagOf(validator: Validator): string {
  return `"${validator.nonce}.${validator.n}"`;
}

/** User-writable annotations shared by a Collection's and a Resource's Metadata object. */
export interface Custom {
  name?: string;
  tags?: JsonObject;
}

/** `Collection.generator`: the requester the controller says a Collection was provisioned for. */
export interface Generator {
  id: string;
  origin?: string;
  url?: string;
  name?: string;
}

/** One entry of `plaintext.indexes` as the controller declared it: a bare name, or an object. */
export type PlaintextIndexDeclaration =
  string | { name: string; source?: 'content' | 'custom'; unique?: boolean };

/** The enforced form of a declaration (bare names default to `source: content`, `unique: false`). */
export interface PlaintextIndex {
  name: string;
  source: 'content' | 'custom';
  unique: boolean;
}

export interface SpaceRecord {
  id: string;
  type: string[];
  name?: string;
  /** The DID that is the root of trust for everything in the Space. */
  controller: string;
  /** The DID whose invocation created the Space (differs from `controller` when provisioned). */
  createdBy: string;
  createdAt: string;
  /** The write stamp of the last write of the Metadata object. */
  stamp: Stamp;
  validator: Validator;
}

export interface CollectionRecord {
  spaceId: string;
  id: string;
  type: string[];
  name?: string;
  generator?: Generator;
  backend: { id: string };
  /** The server-side processing the controller declared (`plaintext.indexes`). */
  plaintext?: { indexes?: PlaintextIndexDeclaration[] };
  custom?: Custom;
  epoch?: string;
  createdBy: string;
  createdAt: string;
  stamp: Stamp;
  /** The Metadata object's validator (`metaVersion`); independent of every Resource's. */
  validator: Validator;
}

export interface ResourceRecord {
  spaceId: string;
  collectionId: string;
  id: string;
  contentType: string;
  bytes: Uint8Array;
  createdBy: string;
  createdAt: string;
  /** Write stamp of the last write of the *content*; a write of the metadata does not move it. */
  stamp: Stamp;
  /** Write stamp of the last write of the user-writable metadata; absent until one has been made. */
  metaStamp?: Stamp;
  writerId?: string;
  epoch?: string;
  custom?: Custom;
  /** Validator of the stored representation (the Resource's `ETag`). */
  validator: Validator;
  /** Validator of the Metadata object (changes with every content write and every `/meta` write). */
  metaValidator: Validator;
}

/** A stored access control policy document (`{ "type": "PublicCanRead" }`). */
export interface PolicyDocument {
  type: string;
  [member: string]: unknown;
}

/** Where a policy hangs: the Space, one of its Collections, or one of that Collection's Resources. */
export interface PolicyScope {
  spaceId: string;
  collectionId?: string;
  resourceId?: string;
}
