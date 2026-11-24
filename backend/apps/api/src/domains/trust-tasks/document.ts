/**
 * The Trust Task document (SPEC §4): one JSON object, no envelope.
 *
 * `validateStructure` is this consumer's check of the OUTER shape — SPEC §7.2 item 1, "validate the
 * outer document structure against the framework JSON Schema". It is hand-written rather than
 * generated because the shape is twelve members, and because the one thing it must never do is
 * return anything but the very object it was given: a proof is verified over the document AS
 * RECEIVED (SPEC §4.7, "What a consumer verifies"), so a validator that returned a normalized copy
 * would quietly move the signed bytes.
 *
 * Unknown top-level members are preserved and ignored, as §7.2 requires; `x-` members are the
 * experimental extensions §4.2 reserves.
 */

export type JsonObject = Record<string, unknown>;

export interface TrustTaskDocument extends JsonObject {
  id: string;
  type: string;
  payload: JsonObject;
  threadId?: string;
  parentThreadId?: string;
  issuer?: string;
  recipient?: string;
  issuedAt?: string;
  expiresAt?: string;
  ceremony?: JsonObject;
  proof?: JsonObject;
}

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Generous, and only there so no member can be used to make this box hold or hash something huge. */
const MAX_ID_LENGTH = 512;
const MAX_IDENTIFIER_LENGTH = 2048;

/** Control characters (including NUL and DEL) have no place in any identifier-like member. */
function hasControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }

  return false;
}

/** Whitespace and control characters (including DEL) have no place in a VID (SPEC 4.8 canonical form). */
function hasForbiddenCharacter(value: string): boolean {
  if (hasControlCharacter(value)) {
    return true;
  }

  for (const char of value) {
    if (/\s/.test(char)) {
      return true;
    }
  }

  return false;
}

const RFC_3339 = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  }

  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/**
 * The instant an RFC 3339 `date-time` names, in epoch milliseconds, or null when it is not one.
 *
 * Calendar-checked rather than left to `Date.parse`, which accepts out-of-range days in some engines.
 * A leap second (`:60`) is accepted and placed one second after `:59`, because the framework types these
 * members as RFC 3339 and a conforming producer may emit one.
 */
export function parseRfc3339(value: unknown): number | null {
  if (typeof value !== 'string' || value.length > 64) {
    return null;
  }

  const match = RFC_3339.exec(value);
  if (match == null) {
    return null;
  }

  const [, year, month, day, hour, minute, second, fraction, zone] = match;
  const [y, mo, d, h, mi, s] = [year, month, day, hour, minute, second].map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];

  // Second 60 is a legal RFC 3339 leap second. ECMAScript cannot represent it, so it is placed on the
  // instant it labels, one second after :59 of the same minute (below).
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo) || h > 23 || mi > 59 || s > 60) {
    return null;
  }

  if (zone !== undefined && zone !== 'Z' && zone !== 'z') {
    const offsetHours = Number(zone.slice(1, 3));
    const offsetMinutes = Number(zone.slice(4, 6));
    if (offsetHours > 23 || offsetMinutes > 59) {
      return null;
    }
  }

  const instant = Date.parse(
    `${year}-${month}-${day}T${hour}:${minute}:${s === 60 ? '59' : second}${fraction ?? ''}${zone?.toUpperCase() ?? ''}`,
  );

  return Number.isFinite(instant) ? instant + (s === 60 ? 1000 : 0) : null;
}

export type StructureResult =
  | { readonly ok: true; readonly document: TrustTaskDocument }
  | { readonly ok: false; readonly member: string };

function fail(member: string): StructureResult {
  return { ok: false, member };
}

function isIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_IDENTIFIER_LENGTH &&
    !hasForbiddenCharacter(value)
  );
}

/** Check the outer shape of `value`. On success the SAME object is returned, typed. */
export function validateStructure(value: unknown): StructureResult {
  if (!isJsonObject(value)) {
    return fail('document');
  }

  const {
    id,
    type,
    payload,
    threadId,
    parentThreadId,
    issuer,
    recipient,
    issuedAt,
    expiresAt,
    ceremony,
    proof,
  } = value;
  const context = value['@context'];

  // `id` is opaque (SPEC 4.3), so whitespace is fine, but a control character is not: it becomes part of
  // the duplicate-record key, and a NUL there is rejected by Postgres.
  if (typeof id !== 'string' || id.length === 0 || id.length > MAX_ID_LENGTH || hasControlCharacter(id)) {
    return fail('id');
  }

  if (typeof type !== 'string' || type.length === 0) {
    return fail('type');
  }

  if (!isJsonObject(payload)) {
    return fail('payload');
  }

  // SPEC 4.9 and 4.9.2: the framework places no constraint on the FORM of a thread identifier and a
  // consumer must not reject a document on that basis, so these are checked as bounded opaque strings.
  for (const [name, member] of [
    ['threadId', threadId],
    ['parentThreadId', parentThreadId],
  ] as const) {
    if (
      member !== undefined &&
      (typeof member !== 'string' ||
        member.length === 0 ||
        member.length > MAX_IDENTIFIER_LENGTH ||
        hasControlCharacter(member))
    ) {
      return fail(name);
    }
  }

  // The parties are VIDs, and SPEC 4.8 lets a consumer refuse a non-canonical one.
  for (const [name, member] of [
    ['issuer', issuer],
    ['recipient', recipient],
  ] as const) {
    if (member !== undefined && !isIdentifier(member)) {
      return fail(name);
    }
  }

  for (const [name, member] of [
    ['issuedAt', issuedAt],
    ['expiresAt', expiresAt],
  ] as const) {
    if (member !== undefined && parseRfc3339(member) === null) {
      return fail(name);
    }
  }

  if (ceremony !== undefined && !isJsonObject(ceremony)) {
    return fail('ceremony');
  }

  if (proof !== undefined && !isJsonObject(proof)) {
    return fail('proof');
  }

  if (context !== undefined && typeof context !== 'string' && typeof context !== 'object') {
    return fail('@context');
  }

  return { ok: true, document: value as TrustTaskDocument };
}
