/**
 * The one place that decides a Person's DISPLAY name is a placeholder rather
 * than an appellation.
 *
 * ## Why this is not in `participantSanity.ts`
 *
 * That module's contract is deliberately narrow and says so out loud: three
 * structural shapes, each one a known parser leak, and "widening this predicate
 * widens what the system silently drops, so it stays narrow on purpose". It is
 * consulted by `classifyParticipant`, `PersonLinkStage.classifyIdentifier` and
 * `EntityIdentifierService`, where a refusal costs a communication its
 * participant edge. Nothing about a placeholder DISPLAY name belongs on that
 * path, so it gets its own door with its own blast radius.
 *
 * This one is consulted from `import/push/entities.ts` alone — the single
 * function that turns a staged entity into the `ci.entities.name` a user reads.
 * A refusal here costs nothing but the string: the entity is still minted, its
 * natural key is unchanged (`naturalKeyFor` reads `staged.name`, not this), and
 * the handle takes the display slot exactly as it does for a call-log heading.
 *
 * ## What it is for
 *
 * Two things a placeholder does that a bad-but-real name does not:
 *
 *  1. **It lies in the address book.** 139 `Person` rows on a real appliance
 *     carry an empty display name, from `.vcf` cards with no `FN`/`N` at all —
 *     `vcard.ts` computes `const name = fn || structuredName`, which is `''`,
 *     and `toGraphEntity`'s `?? handle` never fired because `??` does not catch
 *     the empty string. The email was right there in `properties.email` and the
 *     People view showed a blank row instead.
 *  2. **It is an identity attractor.** `properties.names` is what
 *     `GraphIngestService` indexes into `ci.entity_identifiers`, whose
 *     `(owner_user_id, kind, value_normalized)` index is UNIQUE. One `name`
 *     identifier of "Unknown" therefore belongs to exactly ONE Person, and
 *     every later participant called "Unknown" — from any source, about any
 *     human — resolves to that person. A generic label does not identify
 *     anybody, so it must never claim the row that says it does.
 *
 * ## What it is NOT
 *
 * Not a quality heuristic, and not a "does this look like a human" filter, for
 * the same reason its sibling is not. Two shapes only:
 *
 *  1. a value with no letter and no digit anywhere in it,
 *  2. a value equal to one of {@link GENERIC_PLACEHOLDERS}.
 *
 * The word list is closed and stays closed. Deliberately absent from it:
 * `me`, `self`, `you`, `user`, `guest`, `test`, `support`, `admin`, `info`,
 * `team`, `contact`, `friend`, `family`, `mom`, `dad`. Every one of those is a
 * label somebody really does file a human under in a real address book, and
 * refusing it would delete a name the export honestly contained — the cost this
 * module exists to avoid paying twice.
 */

import { Logger } from '@nestjs/common';

/**
 * Labels that name a MISSING person rather than a person.
 *
 * Compared against {@link normalizeForPlaceholderMatch}'s output, so the entry
 * is the fully normalized form: lower-cased, internal whitespace collapsed, and
 * wrapping brackets/quotes and trailing sentence punctuation already stripped
 * ("(Unknown)", "<unknown>" and "Unknown." all arrive here as "unknown").
 *
 * `na` is absent on purpose even though `n/a` is present: "Na" is a real
 * surname. So is "Nil". A two-character ambiguity is not worth a deleted name.
 */
const GENERIC_PLACEHOLDERS: ReadonlySet<string> = new Set([
  'unknown',
  'unknown contact',
  'unknown caller',
  'unknown number',
  'unknown sender',
  'no name',
  'noname',
  'unnamed',
  'untitled',
  'n/a',
  'none',
  'not available',
  'no caller id',
  'private number',
  'restricted',
  'anonymous',
  'new contact',
  'deleted contact',
]);

/**
 * A value carrying at least one letter or digit in ANY script.
 *
 * Unicode-aware on purpose: "田中" and "Ναταλία" are names, and an ASCII
 * `[a-z0-9]` test would refuse both. What it does refuse is punctuation-only
 * ("?", "-", "…") and emoji-only display names, neither of which identifies
 * anyone — note that a name merely DECORATED with an emoji ("🚀 Russell
 * Levine") still has letters and passes, which is most of what a LinkedIn
 * export actually contains.
 */
const HAS_LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

/** Why a display name was refused. Also the log key, so it is countable. */
export type PlaceholderPersonNameReason = 'no_letters_or_digits' | 'generic_placeholder';

const logger = new Logger('placeholderPersonName');

/** Rate-limiter state, same policy as `participantSanity`: first, then every thousandth. */
const seen = new Map<PlaceholderPersonNameReason, number>();

/**
 * The form {@link GENERIC_PLACEHOLDERS} is keyed on.
 *
 * The stripping is what lets one entry cover the several ways an export dresses
 * the same label up — parenthesised, angle-bracketed, quoted, full-stopped.
 * Characters are stripped only from the ENDS, so "n/a" keeps its slash and
 * "Jean-Luc" keeps its hyphen.
 */
function normalizeForPlaceholderMatch(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/^[\s()[\]<>"'.!?-]+/, '')
    .replace(/[\s()[\]<>"'.!?-]+$/, '');
}

/**
 * Why `raw` is a placeholder rather than a name, or `null` when it is usable.
 *
 * `null` is also the answer for null/empty input, matching
 * `nonNameParticipantReason`: "nothing" is not "a placeholder", and the one
 * caller already treats an empty staged name as absent before it asks.
 */
export function placeholderPersonNameReason(
  raw: string | null | undefined,
): PlaceholderPersonNameReason | null {
  if (raw == null) {
    return null;
  }

  const value = raw.trim();
  if (value.length === 0) {
    return null;
  }

  if (!HAS_LETTER_OR_DIGIT.test(value)) {
    return 'no_letters_or_digits';
  }

  return GENERIC_PLACEHOLDERS.has(normalizeForPlaceholderMatch(value)) ? 'generic_placeholder' : null;
}

/**
 * `true` when `raw` must not become a Person's display name or a `name`
 * identifier. Logs the refusal (rate-limited, see {@link seen}) so a parser that
 * starts emitting placeholders is visible instead of silent.
 *
 * @param context where the refusal happened, e.g. 'import.toGraphEntity'.
 */
export function isPlaceholderPersonName(raw: string | null | undefined, context: string): boolean {
  const reason = placeholderPersonNameReason(raw);
  if (reason == null) {
    return false;
  }

  const count = (seen.get(reason) ?? 0) + 1;
  seen.set(reason, count);

  if (count === 1 || count % 1000 === 0) {
    logger.warn(
      `Refused a Person display name that is a placeholder (${reason}) in ${context}: ` +
        `${JSON.stringify(sample(raw ?? ''))} — occurrences so far: ${count}`,
    );
  }

  return true;
}

/** Test seam: forget the rate-limiter's state. */
export function resetPlaceholderPersonNameLog(): void {
  seen.clear();
}

/** A refused value is untrusted input; never log it unbounded. */
function sample(value: string): string {
  return value.length > 80 ? `${value.slice(0, 80)}…` : value;
}
