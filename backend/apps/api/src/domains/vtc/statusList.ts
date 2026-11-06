import { gunzipSync, gzipSync } from 'node:zlib';

import { W3C_CREDENTIALS_V2 } from './contexts';
import { parseDateTime, toDateTimeStamp } from './dateTime';
import { hasType, isPlainObject, type JsonObject } from './json';
import { decodeMultibaseBase64url, encodeMultibaseBase64url, MultibaseError } from './multibase';

/**
 * W3C Bitstring Status List v1.0 (https://www.w3.org/TR/vc-bitstring-status-list/): how a verifier
 * learns, without asking the holder or the community anything, that a credential was revoked or
 * suspended.
 *
 * The issuer publishes one signed credential per purpose. Its `encodedList` is a bitstring, GZIP
 * compressed and Multibase base64url encoded; each credential it issues names a slot in that
 * string, and the bit at the slot is 0 until the credential is revoked (or suspended). Many
 * credentials share one list so that fetching it reveals nothing about which one a verifier cares
 * about: that is why the specification sets a 131,072-entry floor.
 *
 * Everything here is pure. Fetching the list, and verifying its Data Integrity proof, belong to the
 * caller (`recognition.ts`), which must do both BEFORE calling `evaluateStatus`.
 *
 * ═══ FAILS CLOSED ═══
 *
 * A list that cannot be read, is too short, is stale, answers for another purpose, or has no slot
 * for the credential is an error here, never "valid". The specification names the codes below and
 * they are kept, so a caller can report them in the same words as other implementations.
 */

export const MIN_STATUS_LIST_ENTRIES = 131_072;
export const MAX_STATUS_SIZE = 32;

/** The longest `encodedList` text read. The specification's floor is about 100 characters. */
const MAX_ENCODED_CHARS = 4 * 1024 * 1024;

/** Largest bitstring expanded: 64 Mi one-bit entries. A GZIP bomb stops here. */
const MAX_EXPANDED_BYTES = 8 * 1024 * 1024;

const INDEX = /^(?:0|[1-9][0-9]{0,14})$/;

export type StatusErrorCode =
  'STATUS_RETRIEVAL_ERROR' | 'STATUS_VERIFICATION_ERROR' | 'STATUS_LIST_LENGTH_ERROR' | 'RANGE_ERROR';

export class StatusListError extends Error {
  constructor(
    readonly code: StatusErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'StatusListError';
  }
}

function invalid(message: string): StatusListError {
  return new StatusListError('STATUS_VERIFICATION_ERROR', message);
}

/** The `credentialStatus` entry of a credential that is tracked in a status list. */
export interface BitstringStatusListEntry {
  id?: string;
  statusPurpose: string;
  /** Position of the credential's slot, counted in entries of `statusSize` bits. */
  statusListIndex: number;
  /** The https URL of the list credential. */
  statusListCredential: string;
  statusSize: number;
}

export function parseStatusEntry(value: unknown): BitstringStatusListEntry {
  if (!isPlainObject(value) || value.type !== 'BitstringStatusListEntry') {
    throw invalid('credentialStatus is not a BitstringStatusListEntry');
  }

  const { id, statusPurpose, statusListIndex, statusListCredential, statusSize } = value;
  if (typeof statusPurpose !== 'string' || statusPurpose === '') {
    throw invalid('statusPurpose must be a non-empty string');
  }

  if (typeof statusListIndex !== 'string' || !INDEX.test(statusListIndex)) {
    throw invalid('statusListIndex must be a non-negative integer written as a string');
  }

  if (typeof statusListCredential !== 'string' || !isHttpsUrl(statusListCredential)) {
    throw invalid('statusListCredential must be an https URL without credentials or a fragment');
  }

  const size = statusSize === undefined ? 1 : statusSize;
  if (typeof size !== 'number' || !Number.isInteger(size) || size < 1 || size > MAX_STATUS_SIZE) {
    throw invalid(`statusSize must be an integer from 1 to ${MAX_STATUS_SIZE}`);
  }

  if (id !== undefined && typeof id !== 'string') {
    throw invalid('id must be a string');
  }

  return {
    ...(id === undefined ? {} : { id }),
    statusPurpose,
    statusListIndex: Number(statusListIndex),
    statusListCredential,
    statusSize: size,
  };
}

function isHttpsUrl(text: string): boolean {
  try {
    const url = new URL(text);

    return url.protocol === 'https:' && url.username === '' && url.password === '' && url.hash === '';
  } catch {
    return false;
  }
}

/** A zeroed bitstring of `entries` one-bit entries. The specification's floor applies. */
export function createBitstring(entries: number = MIN_STATUS_LIST_ENTRIES): Uint8Array {
  if (
    !Number.isInteger(entries) ||
    entries < MIN_STATUS_LIST_ENTRIES ||
    entries % 8 !== 0 ||
    entries / 8 > MAX_EXPANDED_BYTES
  ) {
    throw new RangeError(`a status list holds a multiple of 8 entries, from ${MIN_STATUS_LIST_ENTRIES} up`);
  }

  return new Uint8Array(entries / 8);
}

/** Bitstring Generation Algorithm, last step: GZIP, then Multibase base64url. */
export function encodeBitstring(bits: Uint8Array): string {
  return encodeMultibaseBase64url(gzipSync(bits, { level: 9 }));
}

/** Bitstring Expansion Algorithm. */
export function expandBitstring(encodedList: unknown): Uint8Array {
  if (typeof encodedList !== 'string' || encodedList.length > MAX_ENCODED_CHARS) {
    throw invalid('encodedList is missing or too long');
  }

  let compressed: Uint8Array;
  try {
    compressed = decodeMultibaseBase64url(encodedList);
  } catch (error) {
    throw invalid(error instanceof MultibaseError ? error.message : 'encodedList is not Multibase base64url');
  }

  try {
    return new Uint8Array(gunzipSync(compressed, { maxOutputLength: MAX_EXPANDED_BYTES }));
  } catch {
    throw invalid('encodedList is not a GZIP stream, or expands past the size limit');
  }
}

function checkSlot(bits: Uint8Array, index: number, size: number): number {
  if (!Number.isInteger(size) || size < 1 || size > MAX_STATUS_SIZE) {
    throw new StatusListError('RANGE_ERROR', `a slot is 1 to ${MAX_STATUS_SIZE} bits wide`);
  }

  const first = index * size;
  if (!Number.isSafeInteger(index) || index < 0 || first + size > bits.length * 8) {
    throw new StatusListError('RANGE_ERROR', `slot ${index} is outside the list`);
  }

  return first;
}

/**
 * The value at slot `index`, `size` bits wide. Bit 0 of the list is the left-most bit of the first
 * byte (§7.1), so the bits of a slot are read most significant first.
 */
export function readStatus(bits: Uint8Array, index: number, size = 1): number {
  const first = checkSlot(bits, index, size);
  let value = 0;
  for (let position = first; position < first + size; position += 1) {
    value = value * 2 + (((bits[position >> 3] ?? 0) >> (7 - (position & 7))) & 1);
  }

  return value;
}

export function writeStatus(bits: Uint8Array, index: number, value: number, size = 1): void {
  const first = checkSlot(bits, index, size);
  if (!Number.isInteger(value) || value < 0 || value >= 2 ** size) {
    throw new RangeError(`${value} does not fit in ${size} bit(s)`);
  }

  for (let offset = 0; offset < size; offset += 1) {
    const position = first + offset;
    const mask = 1 << (7 - (position & 7));
    const bit = Math.floor(value / 2 ** (size - 1 - offset)) % 2;
    const current = bits[position >> 3] ?? 0;
    bits[position >> 3] = bit === 1 ? current | mask : current & ~mask;
  }
}

export interface StatusResult {
  purpose: string;
  status: number;
  /** True when the slot holds 0: not revoked, not suspended. */
  valid: boolean;
  /** How long the publisher asks verifiers to keep the list, when it says. */
  ttlMs: number | null;
  /** True when the list carries a `validUntil`, so a replayed old copy ages out. */
  bounded: boolean;
}

export interface EvaluateOptions {
  now: Date;
  /** Clock drift tolerated on `validFrom` only. Expiry gets no allowance. Default 0. */
  skewMs?: number;
  /** Refuse a list that has no `validUntil`. Default false: the specification does not require one. */
  requireExpiry?: boolean;
  /**
   * The oldest a list may be, counted from its `validFrom`. A list with no `validUntil` never ages
   * out on its own, and OpenVTC's lists have none: without this a copy saved before a revocation
   * would be believed for as long as the credential lives. When set, a list with no `validFrom`
   * is refused, because its age cannot be known. Unset means no age limit; the recognizer always
   * sets one.
   */
  maxAgeMs?: number;
}

function optionalDate(value: unknown, field: string): Date | null {
  if (value === undefined) {
    return null;
  }

  const date = parseDateTime(value);
  if (!date) {
    throw invalid(`${field} is not a date-time`);
  }

  return date;
}

/**
 * Validate Algorithm (§3.2), steps after the fetch and the proof check: purpose, expansion, length,
 * slot. `listCredential` must already have had its proof verified by the caller.
 */
export function evaluateStatus(
  entry: BitstringStatusListEntry,
  listCredential: unknown,
  options: EvaluateOptions,
): StatusResult {
  if (!isPlainObject(listCredential) || !hasType(listCredential.type, 'BitstringStatusListCredential')) {
    throw invalid('not a BitstringStatusListCredential');
  }

  if (!Number.isInteger(entry.statusSize) || entry.statusSize < 1 || entry.statusSize > MAX_STATUS_SIZE) {
    throw invalid(`statusSize must be an integer from 1 to ${MAX_STATUS_SIZE}`);
  }

  // `id` is optional in the specification, but a list that does not say which URL it is could be
  // any list the same issuer signed, served in place of this one. Stricter than the specification,
  // and every list OpenVTC and this module publish states its id.
  if (listCredential.id !== entry.statusListCredential) {
    throw invalid(
      listCredential.id === undefined
        ? 'the list credential states no id'
        : 'the list credential id differs from statusListCredential',
    );
  }

  // Every time comparison below is written as "accept only if", so a clock or allowance that is not
  // a number cannot turn a failed comparison into a pass. The values are also refused outright.
  const now = options.now.getTime();
  const skew = options.skewMs ?? 0;
  if (!Number.isFinite(now) || !Number.isFinite(skew) || skew < 0) {
    throw invalid('the clock and the skew allowance must be finite times');
  }

  if (options.maxAgeMs !== undefined && !(Number.isFinite(options.maxAgeMs) && options.maxAgeMs > 0)) {
    throw invalid('maxAgeMs must be a finite number above zero');
  }

  const validFrom = optionalDate(listCredential.validFrom, 'validFrom');
  const validUntil = optionalDate(listCredential.validUntil, 'validUntil');
  if (validFrom && !(now + skew >= validFrom.getTime())) {
    throw invalid('the status list is not valid yet');
  }

  if (validUntil && !(now < validUntil.getTime())) {
    throw invalid('the status list has expired');
  }

  if (options.requireExpiry && !validUntil) {
    throw invalid('the status list has no validUntil');
  }

  if (options.maxAgeMs !== undefined) {
    if (!validFrom) {
      throw invalid('the status list has no validFrom, so its age cannot be bounded');
    }

    if (!(now - validFrom.getTime() <= options.maxAgeMs)) {
      throw invalid('the status list is older than the allowed age');
    }
  }

  const subject = listCredential.credentialSubject;
  if (!isPlainObject(subject) || !hasType(subject.type, 'BitstringStatusList')) {
    throw invalid('credentialSubject is not a BitstringStatusList');
  }

  const purposes: unknown[] = Array.isArray(subject.statusPurpose)
    ? subject.statusPurpose
    : [subject.statusPurpose];
  if (!purposes.includes(entry.statusPurpose)) {
    throw invalid(`the list does not answer for the ${entry.statusPurpose} purpose`);
  }

  const bits = expandBitstring(subject.encodedList);
  if (Math.floor((bits.length * 8) / entry.statusSize) < MIN_STATUS_LIST_ENTRIES) {
    throw new StatusListError(
      'STATUS_LIST_LENGTH_ERROR',
      `the list holds fewer than ${MIN_STATUS_LIST_ENTRIES} entries`,
    );
  }

  const status = readStatus(bits, entry.statusListIndex, entry.statusSize);
  const ttl = subject.ttl;

  return {
    purpose: entry.statusPurpose,
    status,
    valid: status === 0,
    ttlMs: typeof ttl === 'number' && Number.isFinite(ttl) && ttl >= 0 ? ttl : null,
    bounded: validUntil !== null,
  };
}

/** The unsigned `BitstringStatusListCredential` for `bits`. The caller signs it. */
export function buildStatusListCredential(args: {
  /** The https URL the list is served from. */
  id: string;
  issuer: string;
  purpose: string;
  bits: Uint8Array;
  validFrom: Date;
  validUntil?: Date;
  ttlMs?: number;
}): JsonObject {
  return {
    '@context': [W3C_CREDENTIALS_V2],
    id: args.id,
    type: ['VerifiableCredential', 'BitstringStatusListCredential'],
    issuer: args.issuer,
    validFrom: toDateTimeStamp(args.validFrom),
    ...(args.validUntil ? { validUntil: toDateTimeStamp(args.validUntil) } : {}),
    credentialSubject: {
      id: `${args.id}#list`,
      type: 'BitstringStatusList',
      statusPurpose: args.purpose,
      encodedList: encodeBitstring(args.bits),
      ...(args.ttlMs === undefined ? {} : { ttl: args.ttlMs }),
    },
  };
}
