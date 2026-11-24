/**
 * Graph participant classification and structured name helpers.
 *
 * Email, phone, and display-name normalization lives in `common/normalizeIdentifier`
 * so the graph, import, and memory-write paths share one rule without crossing
 * domain internals or loading the graph module for a pure string operation.
 */
import { normalizeIdentifier, type IdentifierKind } from '@ci/common/normalizeIdentifier';

import { isNonNameParticipant } from './participantSanity';

export {
  PHONE_EXTENSION_PATTERN,
  hasPhoneExtension,
  normalizeEmail,
  normalizeName,
  normalizePhone,
} from '@ci/common/normalizeIdentifier';
export { normalizeIdentifier };
export type { IdentifierKind };

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

/**
 * Exported for the owner match in `import/push/self.ts`, which must test a
 * string as a phone number only when it IS one. Any digits inside a display
 * name or a mailbox are not a number the owner can be matched on.
 */
export function isPhoneShaped(trimmed: string): boolean {
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
 *
 * The `name` branch is the permissive one — it is the fallthrough — so a parser
 * leak arrives here as a perfectly ordinary "name" and leaves as somebody's
 * contact card. {@link isNonNameParticipant} is the door: a call-log heading,
 * an export filename or anything carrying a newline is refused (and logged)
 * rather than classified. Refusing means the participant does not resolve and
 * does not mint, which is the same "unresolved" state every one of these
 * callers already handles for a participant nothing matched.
 */
export function classifyParticipant(raw: string | null): ClassifiedIdentifier | null {
  if (raw == null) {
    return null;
  }

  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return null;
  }

  if (isNonNameParticipant(trimmed, 'classifyParticipant')) {
    return null;
  }

  const kind: IdentifierKind = trimmed.includes('@') ? 'email' : isPhoneShaped(trimmed) ? 'phone' : 'name';
  const valueNormalized = normalizeIdentifier(kind, trimmed);
  if (valueNormalized == null) {
    return null;
  }

  return { kind, valueNormalized };
}
