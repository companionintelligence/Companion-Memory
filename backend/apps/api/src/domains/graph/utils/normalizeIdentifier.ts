/**
 * Identifier normalization — the single source of truth for the rule shared by
 * the importer (which pre-normalizes Person `properties.emails`/`.phones`) and
 * the server (which normalizes raw communication participants and defensively
 * re-normalizes ingested identifiers). The two MUST stay byte-identical or the
 * people-linking lookup silently misses.
 *
 * Rule:
 *   - email: trim + lowercase.
 *   - phone: last 10 digits of the digit string (drops country code, spaces,
 *     punctuation, '+', leading '1', etc.). Fewer than 10 digits → keep all
 *     digits as-is.
 *
 * Returns `null` when the input is empty/whitespace or (for phone) has no
 * digits, so callers can skip non-matchable values rather than store empties.
 */

export type IdentifierKind = 'email' | 'phone' | 'name';

export function normalizeEmail(raw: string | null | undefined): string | null {
  if (raw == null) {
    return null;
  }

  const normalized = raw.trim().toLowerCase();

  return normalized.length > 0 ? normalized : null;
}

export function normalizePhone(raw: string | null | undefined): string | null {
  if (raw == null) {
    return null;
  }

  const digits = raw.replace(/\D/g, '');
  if (digits.length === 0) {
    return null;
  }

  // Last 10 digits — strips a leading country code (e.g. US '1') so the same
  // number written +1 (415) 555-0100 and 4155550100 collapse to one value.
  return digits.length > 10 ? digits.slice(-10) : digits;
}

/**
 * Display-name identifier for participants that carry neither an email nor a
 * phone number (chat networks — Facebook Messenger, Instagram — export display
 * names only). NFKD-fold + strip diacritics, lowercase, collapse whitespace,
 * so "José  GARCÍA" and "jose garcia" collapse to one value. Weaker than an
 * email/phone (display names are not globally unique), which is acceptable for
 * the per-user identifier index: the tuple is scoped to owner_user_id, and a
 * chat participant's display name is stable within one user's corpus.
 */
export function normalizeName(raw: string | null | undefined): string | null {
  if (raw == null) {
    return null;
  }

  const normalized = raw
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

  return normalized.length > 0 ? normalized : null;
}

export function normalizeIdentifier(kind: IdentifierKind, raw: string | null | undefined): string | null {
  if (kind === 'email') {
    return normalizeEmail(raw);
  }

  if (kind === 'phone') {
    return normalizePhone(raw);
  }

  return normalizeName(raw);
}

/**
 * Structured name parts for a Person's `properties`, split from a display
 * name. snake_case keys mirror what PersonEntity.loadPropertiesFromJsonb reads
 * (properties.first_name / .last_name; middle_name rides along for when a
 * reader wants it). Rule: one token -> no parts at all (a lone token is a
 * display name/handle, not reliably a first name); two -> first + last; three
 * or more -> first token, last token, everything between as middle. Middle is
 * OMITTED (not empty) when absent.
 */
export interface PersonNameParts {
  first_name: string;
  middle_name?: string;
  last_name?: string;
}

/** Split a display name into first/middle/last parts (null for empty input). */
export function splitPersonName(fullName: string | null | undefined): PersonNameParts | null {
  if (fullName == null) {
    return null;
  }

  const tokens = fullName.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  if (tokens.length <= 1) {
    return null;
  }

  if (tokens.length === 2) {
    return { first_name: tokens[0], last_name: tokens[1] };
  }

  return {
    first_name: tokens[0],
    middle_name: tokens.slice(1, -1).join(' '),
    last_name: tokens[tokens.length - 1],
  };
}

/** A normalized (kind, value) pair used as a lookup key. */
export interface ClassifiedIdentifier {
  kind: IdentifierKind;
  valueNormalized: string;
}

/**
 * Phone-shaped end-to-end: nothing but digits and common phone punctuation
 * (+ ( ) - . and whitespace). A string that merely CONTAINS digits is not a
 * phone — chat handles routinely embed digit runs ("alexmz12", "griffin5131").
 */
const PHONE_SHAPE_REGEX = /^[+()\-.\s\d]+$/;

/**
 * Minimum digits for a phone classification (7 = the shortest local subscriber
 * number). Below this, even an all-digit participant (SMS short codes, a handle
 * that is just "42") classifies as a name — still a stable per-user identifier,
 * but never collapsible with a real phone number.
 */
const PHONE_MIN_DIGITS = 7;

function isPhoneShaped(trimmed: string): boolean {
  if (!PHONE_SHAPE_REGEX.test(trimmed)) {
    return false;
  }

  return trimmed.replace(/\D/g, '').length >= PHONE_MIN_DIGITS;
}

/**
 * Classify a raw communication participant string and normalize it with the
 * shared rule the identifier index uses — THE single classification rule for
 * people-extraction and people-linking (the stub backfill, the link backfill,
 * and the per-row link listener all resolve through this, so they agree
 * byte-for-byte on what counts as a match):
 *   - contains '@'                    -> email
 *   - phone-shaped (see isPhoneShaped) -> phone (normalizePhone keeps the digits)
 *   - anything else                   -> name (display-name / handle
 *     participants — Messenger names, Discord handles like "alexmz12")
 *
 * The phone branch used to fire on ANY digit-bearing string, which turned chat
 * handles into bogus short "phone numbers" ("alexmz12" -> phone '12') and let
 * unrelated handles sharing a digit run collide into one Person.
 */
export function classifyParticipant(raw: string | null): ClassifiedIdentifier | null {
  if (raw == null) {
    return null;
  }

  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const kind: IdentifierKind = trimmed.includes('@') ? 'email' : isPhoneShaped(trimmed) ? 'phone' : 'name';
  const valueNormalized = normalizeIdentifier(kind, trimmed);
  if (valueNormalized == null) {
    return null;
  }

  return { kind, valueNormalized };
}
