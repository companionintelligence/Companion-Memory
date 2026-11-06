/**
 * Validation of the JSON documents a client writes: the Space and Collection Metadata objects,
 * the Resource Metadata object, and the request headers that carry attribution.
 *
 * Server-derived members (`createdAt`, `updatedAt`, `createdBy`, `url`, `linkset`, `backends`) are
 * ignored wherever they appear, so a client can read a Metadata object, edit it and write it
 * back without stripping them. Everything else a client sends is checked, and a bad value is an
 * `invalid-request-body` that points at the member (RFC 9457 `errors[].pointer`).
 *
 * These run only after authorization: for a target that exists, a caller who may not write it
 * must see `not-found`, never a validation error that confirms the target is there.
 */
import type { JsonObject, JsonValue } from './dataIntegrity';
import { isValidId } from './ids';
import { isDid } from './keys';
import type { Custom, Generator, PlaintextIndex, PlaintextIndexDeclaration } from './models';
import { PwsError, invalidBody } from './problems';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sortedTypes(value: unknown, required: string, pointer: string): string[] {
  if (value === undefined) {
    return [required];
  }
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === 'string' && entry.length > 0)) {
    throw invalidBody('"type" must be an array of strings.', pointer);
  }
  if (!value.includes(required)) {
    throw invalidBody(`"type" must include "${required}".`, pointer);
  }
  return [...new Set(value as string[])].sort();
}

function optionalString(value: unknown, pointer: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw invalidBody('The value must be a string.', pointer);
  }
  return value;
}

/** A body `epoch` follows the same rule as the `Key-Epoch` header: 1 to 128 visible ASCII characters. */
function optionalLabel(value: unknown, pointer: string): string | undefined {
  const text = optionalString(value, pointer);
  if (text !== undefined && !LABEL.test(text)) {
    throw invalidBody(
      'The value must be a non-empty label of visible ASCII characters (at most 128).',
      pointer,
    );
  }
  return text;
}

// --- Space -----------------------------------------------------------------------------------

export interface SpaceInput {
  id?: string;
  type: string[];
  name?: string;
  controller?: string;
}

export function readSpaceBody(body: unknown): SpaceInput {
  if (!isRecord(body)) {
    throw invalidBody('The request body must be a JSON object.');
  }
  const { id, controller } = body;
  if (id !== undefined && typeof id !== 'string') {
    throw invalidBody('"id" must be a string.', '/id');
  }
  if (controller !== undefined && typeof controller !== 'string') {
    throw invalidBody('"controller" must be a DID.', '/controller');
  }
  const name = optionalString(body.name, '/name');
  return {
    ...(id !== undefined ? { id } : {}),
    type: sortedTypes(body.type, 'Space', '/type'),
    ...(name !== undefined ? { name } : {}),
    ...(controller !== undefined ? { controller } : {}),
  };
}

export function requireUrlSafeId(id: string, pointer: string): void {
  if (!isValidId(id)) {
    throw new PwsError('invalid-id', 'The identifier is not URL-safe.', {
      errors: [{ detail: 'Use 1 to 128 of A-Z a-z 0-9 . _ ~ -', pointer }],
    });
  }
}

// --- custom annotations ----------------------------------------------------------------------

/** Whether a JSON value holds arrays or objects nested more than `remaining` deep. Recursion stops at the limit. */
function nestedDeeperThan(value: unknown, remaining: number): boolean {
  const children = Array.isArray(value) ? value : isRecord(value) ? Object.values(value) : undefined;
  if (children === undefined) {
    return false;
  }
  return remaining === 0 || children.some((child) => nestedDeeperThan(child, remaining - 1));
}

/** Deeper than any real annotation, and far below what makes `structuredClone` throw a `RangeError`. */
const MAX_TAGS_DEPTH = 8;

export function readCustom(value: unknown, pointer: string): Custom {
  if (!isRecord(value)) {
    throw invalidBody('"custom" must be a JSON object.', pointer);
  }
  const name = optionalString(value.name, `${pointer}/name`);
  let tags: JsonObject | undefined;
  if (value.tags !== undefined) {
    if (!isRecord(value.tags)) {
      throw invalidBody('"tags" must be a JSON object.', `${pointer}/tags`);
    }
    if (nestedDeeperThan(value.tags, MAX_TAGS_DEPTH)) {
      throw invalidBody(
        `"tags" may not be nested more than ${MAX_TAGS_DEPTH} levels deep.`,
        `${pointer}/tags`,
      );
    }
    tags = value.tags as JsonObject;
  }
  return { ...(name !== undefined ? { name } : {}), ...(tags !== undefined ? { tags } : {}) };
}

// --- Collection ------------------------------------------------------------------------------

export interface CollectionInput {
  id?: string;
  type: string[];
  name?: string;
  generator?: Generator;
  backend?: { id: string };
  plaintext?: { indexes?: PlaintextIndexDeclaration[] };
  custom?: Custom;
  epoch?: string;
  /** The client sent an `encryption` descriptor, which this server does not implement. */
  encryption: boolean;
}

function readGenerator(value: unknown): Generator {
  const pointer = '/generator';
  if (!isRecord(value)) {
    throw invalidBody('"generator" must be an object.', pointer);
  }
  for (const member of Object.keys(value)) {
    if (!['id', 'origin', 'url', 'name'].includes(member)) {
      throw invalidBody(`"generator" has an unknown member "${member}".`, `${pointer}/${member}`);
    }
  }
  if (!isDid(value.id)) {
    throw invalidBody('"generator.id" must be a DID.', `${pointer}/id`);
  }
  const generator: Generator = { id: value.id };
  if (value.origin !== undefined) {
    if (typeof value.origin !== 'string') {
      throw invalidBody('"generator.origin" must be a Web origin.', `${pointer}/origin`);
    }
    let origin: URL;
    try {
      origin = new URL(value.origin);
    } catch {
      throw invalidBody('"generator.origin" must be a Web origin.', `${pointer}/origin`);
    }
    if (origin.origin !== value.origin || (origin.protocol !== 'https:' && origin.protocol !== 'http:')) {
      throw invalidBody(
        '"generator.origin" must be the ASCII serialization of a Web origin.',
        `${pointer}/origin`,
      );
    }
    generator.origin = value.origin;
  }
  if (value.url !== undefined) {
    if (generator.origin === undefined) {
      throw invalidBody('"generator.url" requires "generator.origin".', `${pointer}/url`);
    }
    if (typeof value.url !== 'string') {
      throw invalidBody('"generator.url" must be a string.', `${pointer}/url`);
    }
    let url: URL;
    try {
      url = new URL(value.url);
    } catch {
      throw invalidBody('"generator.url" must be an absolute http(s) URL.', `${pointer}/url`);
    }
    if (
      (url.protocol !== 'https:' && url.protocol !== 'http:') ||
      url.origin !== generator.origin ||
      // the raw text: `URL.search` is empty for a bare `?`
      value.url.includes('?') ||
      value.url.includes('#')
    ) {
      throw invalidBody(
        '"generator.url" must be an http(s) URL on the generator origin, without a query or fragment.',
        `${pointer}/url`,
      );
    }
    generator.url = value.url;
  }
  if (value.name !== undefined) {
    if (typeof value.name !== 'string' || value.name.length === 0) {
      throw invalidBody('"generator.name" must be a non-empty string.', `${pointer}/name`);
    }
    generator.name = value.name;
  }
  return generator;
}

/**
 * The declared form is what is stored and echoed: a bare string stays a bare string, so a
 * client that reads the declaration back sees what it wrote. This gives the canonical form the
 * server enforces.
 */
export function normalizeIndexes(indexes: readonly PlaintextIndexDeclaration[]): PlaintextIndex[] {
  return indexes.map((entry) =>
    typeof entry === 'string'
      ? { name: entry, source: 'content' as const, unique: false }
      : { name: entry.name, source: entry.source ?? 'content', unique: entry.unique === true },
  );
}

function readPlaintext(value: unknown): { indexes?: PlaintextIndexDeclaration[] } {
  const pointer = '/plaintext';
  if (!isRecord(value)) {
    throw invalidBody('"plaintext" must be an object.', pointer);
  }
  for (const member of Object.keys(value)) {
    if (member !== 'indexes') {
      throw invalidBody(`"plaintext" has an unknown member "${member}".`, `${pointer}/${member}`);
    }
  }
  if (value.indexes === undefined) {
    return {};
  }
  if (!Array.isArray(value.indexes)) {
    throw invalidBody('"plaintext.indexes" must be an array.', `${pointer}/indexes`);
  }
  const declared: PlaintextIndexDeclaration[] = [];
  const names = new Set<string>();
  for (const [index, entry] of value.indexes.entries()) {
    const at = `${pointer}/indexes/${index}`;
    let name: unknown;
    if (typeof entry === 'string') {
      name = entry;
    } else if (isRecord(entry)) {
      name = entry.name;
      if (entry.source !== undefined && entry.source !== 'content' && entry.source !== 'custom') {
        throw invalidBody('"source" must be "content" or "custom".', `${at}/source`);
      }
      if (entry.unique !== undefined && typeof entry.unique !== 'boolean') {
        throw invalidBody('"unique" must be a boolean.', `${at}/unique`);
      }
    } else {
      throw invalidBody('An index must be a name or an object with a name.', at);
    }
    if (typeof name !== 'string' || name.length === 0) {
      throw invalidBody('An index needs a non-empty "name".', `${at}/name`);
    }
    if (name === '__proto__') {
      throw invalidBody('The index name "__proto__" is not allowed.', `${at}/name`);
    }
    if (names.has(name)) {
      throw invalidBody(`The index name "${name}" is declared twice.`, `${at}/name`);
    }
    names.add(name);
    declared.push(
      typeof entry === 'string'
        ? entry
        : {
            name,
            ...(entry.source !== undefined ? { source: entry.source as 'content' | 'custom' } : {}),
            ...(entry.unique !== undefined ? { unique: entry.unique as boolean } : {}),
          },
    );
  }
  return { indexes: declared };
}

export function readCollectionBody(body: unknown): CollectionInput {
  if (!isRecord(body)) {
    throw invalidBody('The request body must be a JSON object.');
  }
  const { id } = body;
  if (id !== undefined && typeof id !== 'string') {
    throw invalidBody('"id" must be a string.', '/id');
  }
  const name = optionalString(body.name, '/name');
  const epoch = optionalLabel(body.epoch, '/epoch');

  let backend: { id: string } | undefined;
  if (body.backend !== undefined) {
    if (!isRecord(body.backend) || typeof body.backend.id !== 'string' || body.backend.id.length === 0) {
      throw invalidBody('"backend" must be an object with an "id".', '/backend');
    }
    backend = { id: body.backend.id };
  }

  const encryption = 'encryption' in body && body.encryption !== undefined;
  const plaintext = body.plaintext !== undefined ? readPlaintext(body.plaintext) : undefined;
  if (encryption && plaintext !== undefined) {
    throw invalidBody('"plaintext" and "encryption" are mutually exclusive.', '/plaintext');
  }

  return {
    ...(id !== undefined ? { id } : {}),
    type: sortedTypes(body.type, 'Collection', '/type'),
    ...(name !== undefined ? { name } : {}),
    ...(body.generator !== undefined ? { generator: readGenerator(body.generator) } : {}),
    ...(backend ? { backend } : {}),
    ...(plaintext ? { plaintext } : {}),
    ...(body.custom !== undefined ? { custom: readCustom(body.custom, '/custom') } : {}),
    ...(epoch !== undefined ? { epoch } : {}),
    encryption,
  };
}

// --- Resource Metadata -----------------------------------------------------------------------

export interface ResourceMetaInput {
  custom: Custom | undefined;
  epoch: string | undefined;
}

export function readResourceMetaBody(body: unknown): ResourceMetaInput {
  if (!isRecord(body)) {
    throw invalidBody('The request body must be a JSON object.');
  }
  return {
    custom: body.custom === undefined ? undefined : readCustom(body.custom, '/custom'),
    epoch: optionalLabel(body.epoch, '/epoch'),
  };
}

// --- attribution headers ---------------------------------------------------------------------

const LABEL = /^[\x21-\x7e]{1,128}$/;

/**
 * `Writer-Id` and `Key-Epoch` carry opaque labels the server stores and never interprets. A
 * header that is present but empty or malformed is an error; an absent one is `undefined`, which
 * on a content write means "clear the stored label".
 */
export function readLabelHeader(value: string | undefined, header: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!LABEL.test(value)) {
    throw invalidBody(`The ${header} header must be a non-empty label of visible ASCII characters.`);
  }
  return value;
}

export type { JsonValue };
