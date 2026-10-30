import { canonicalDataClass } from './canonical';
import {
  TRUST_TIERS,
  type AnswerForm,
  type DisclosedAnswer,
  type DisclosureRung,
  type TrustTier,
} from './types';

/**
 * The disclosure ladder, coarsest first. Every rung discloses strictly less than
 * the one above it, so "downgrade" is always a safe direction to move.
 *
 *   none     — nothing at all (the ask is refused)
 *   boolean  — yes/no only
 *   count    — how many, no references
 *   summary  — a templated sentence + count
 *   redacted — the item references the owner kept, and nothing about the rest
 *   full     — every matching item reference, and how many were held back
 */
export const DISCLOSURE_RUNGS: readonly DisclosureRung[] = [
  'none',
  'boolean',
  'count',
  'summary',
  'redacted',
  'full',
] as const;

const RUNG_INDEX: Readonly<Record<DisclosureRung, number>> = DISCLOSURE_RUNGS.reduce(
  (acc, rung, index) => ({ ...acc, [rung]: index }),
  {} as Record<DisclosureRung, number>,
);

/** Whether `a` discloses at least as much as `b`. */
export function rungAtLeast(a: DisclosureRung, b: DisclosureRung): boolean {
  return RUNG_INDEX[a] >= RUNG_INDEX[b];
}

/** The lesser (safer) of two rungs. */
export function minRung(a: DisclosureRung, b: DisclosureRung): DisclosureRung {
  return RUNG_INDEX[a] <= RUNG_INDEX[b] ? a : b;
}

/**
 * The narrower of two ceilings that may not exist.
 *
 * Nullish means "this SOURCE imposes no ceiling" — not "no ceiling applies".
 * Every caller combines several independent sources (the tier, the grant's own
 * `maxDisclosure`, the ceiling stamped when the owner consented) and the rule
 * is the same for all of them: a source that says nothing must not be able to
 * erase one that does.
 *
 * That is precisely the bug this exists to make unwriteable. The answer path
 * read a live grant ceiling and used it *instead of* the one captured at
 * consent time, so a revoked grant — which reads as nothing at all, because
 * every SQL path filters `revoked_at IS NULL` — dropped the cap and the answer
 * grew when the owner withdrew consent. `undefined ?? live` is the shape of
 * that bug; this function is the shape of the fix.
 *
 * Pure.
 */
export function narrowestRung(
  a: DisclosureRung | null | undefined,
  b: DisclosureRung | null | undefined,
): DisclosureRung | undefined {
  if (a == null) {
    return b ?? undefined;
  }

  if (b == null) {
    return a;
  }

  return minRung(a, b);
}

/**
 * Data classes that are never disclosed automatically, whatever the tier says.
 * A grant may still authorize them, but only through explicit owner review —
 * the ceiling below forces `review` by capping the auto path at `none`.
 */
const SENSITIVE_CLASSES: ReadonlySet<string> = new Set([
  'health',
  'medical',
  'financial',
  'finance',
  'secrets',
  'credentials',
  'location',
]);

/**
 * Default disclosure ceiling per trust tier, mirroring the tier table in
 * ARCHITECTURE.md §8.1. `'*'` is the fallback for any class not named.
 *
 * This is a CEILING, not a grant: it can only ever reduce what a grant allows.
 * A tier never authorizes disclosure on its own — an ask still needs a matching
 * grant to be answered at all.
 *
 * A PER-CLASS ENTRY MAY ONLY TIGHTEN `'*'`, and {@link disclosureCeiling}
 * enforces that rather than trusting the table — see the note there on why
 * `peer.photos` was a disclosure UPGRADE bought with an asker-supplied label.
 */
const TIER_CEILINGS: Readonly<Record<TrustTier, Readonly<Record<string, DisclosureRung>>>> = {
  // Members of the owner's own household on the same box.
  household: { '*': 'full' },
  family: { '*': 'full', location: 'redacted' },
  trusted: { '*': 'redacted', location: 'summary' },
  peer: { '*': 'summary', photos: 'redacted', location: 'count' },
  stranger: { '*': 'boolean', location: 'none' },
};

/** The narrowest rung this tier imposes on ANY class — its floor. */
function strictestIn(table: Readonly<Record<string, DisclosureRung>>): DisclosureRung {
  return Object.values(table).reduce<DisclosureRung>(minRung, table['*'] ?? 'boolean');
}

const TIER_INDEX: Readonly<Record<TrustTier, number>> = TRUST_TIERS.reduce(
  (acc, tier, index) => ({ ...acc, [tier]: index }),
  {} as Record<TrustTier, number>,
);

/**
 * The stricter (lower-trust) of two trust tiers (`household` > `family` >
 * `trusted` > `peer` > `stranger`). Unknown values clamp to `'stranger'`.
 */
export function minTrustTier(a: TrustTier, b: TrustTier): TrustTier {
  const indexA = TIER_INDEX[a] ?? TIER_INDEX.stranger;
  const indexB = TIER_INDEX[b] ?? TIER_INDEX.stranger;

  return indexA >= indexB ? (TRUST_TIERS[indexA] ?? 'stranger') : (TRUST_TIERS[indexB] ?? 'stranger');
}

/**
 * Group-thread / multi-party trust-tier floor clamp (`open-instinct` pattern).
 *
 * When a question or agent turn occurs in a room or thread with multiple
 * participants, the effective trust tier for any shared response is the
 * STRICTEST (lowest-trust) tier among all participants. An empty or unknown
 * participant list fails closed to `'stranger'`.
 */
export function resolveGroupTier(tiers: readonly TrustTier[]): TrustTier {
  if (!tiers || tiers.length === 0) {
    return 'stranger';
  }

  return tiers.reduce<TrustTier>((acc, tier) => minTrustTier(acc, tier), tiers[0] ?? 'stranger');
}

/**
 * Disclosure ceiling for a multi-party / group thread context, clamping to the
 * strictest participant's tier before evaluating the class ceiling.
 */
export function groupDisclosureCeiling(tiers: readonly TrustTier[], dataClass?: unknown): DisclosureRung {
  return disclosureCeiling(resolveGroupTier(tiers), dataClass);
}

/**
 * The most this asker may ever receive for this data class.
 *
 * Sensitive classes are capped at `none` for every tier below `family`, which
 * routes them to owner review rather than silently auto-answering. Unknown tiers
 * fall back to the strictest posture.
 *
 * ═══ NAMING A CLASS MUST NEVER BUY MORE DISCLOSURE ═══
 *
 * Two rules below both exist because `dataClass` is an OPTIONAL, ASKER-SUPPLIED
 * label, and because naming it does not actually confine what gets searched:
 * `AskExecutorService` resolves a class to a coarse ENTITY TYPE (`photos` →
 * `file`, so every document, receipt and scan the keyword matches comes back
 * with the holiday snaps) and resolves an unknown or absent class to no filter
 * at all. The label describes the ask; it does not bound the answer.
 *
 * 1. A CLASS THE ASK DOES NOT NAME gets the tier's FLOOR, not its `'*'`
 *    fallback. An omitted class is the broadest an ask can be — unfiltered
 *    across every indexed entity type — so handing it the fallback written for
 *    "some ordinary class" rewarded the omission. This is the tier-side mirror
 *    of {@link autoGrantNamesQueryClass}: at the grant layer an unnamed class
 *    can no longer be auto-answered at all, which is what makes SENSITIVE_CLASSES'
 *    "never disclosed automatically" true for the omission case; here the
 *    REVIEWED path additionally loses the generous fallback. Deliberately the
 *    floor rather than a flat `none`: the tier layer cannot tell a `relationship`
 *    ask (no class exists to name) from a `content` one that dropped its label,
 *    and answering "Nothing was shared." to every non-family relationship ask
 *    would retire the archetype rather than secure it.
 *
 * 2. A PER-CLASS ENTRY MAY ONLY TIGHTEN `'*'`. `peer` reads
 *    `{ '*': 'summary', photos: 'redacted' }`, and `redacted` sits ABOVE
 *    `summary` on the ladder — so a peer who wrote `dataClass: 'photos'`
 *    received ITEM REFERENCES where the same ask without the label received a
 *    sentence. Since `photos` resolves to the whole `file` type, those
 *    references were not confined to photographs either. Clamping to the
 *    fallback keeps a class entry doing the only thing a ceiling table should
 *    do — restrict.
 */
export function disclosureCeiling(tier: TrustTier, dataClass?: unknown): DisclosureRung {
  const table = TIER_CEILINGS[tier] ?? TIER_CEILINGS.stranger;
  const fallback = table['*'] ?? 'boolean';
  const canonical = canonicalDataClass(dataClass);

  if (canonical == null) {
    return strictestIn(table);
  }

  if (SENSITIVE_CLASSES.has(canonical) && tier !== 'household' && tier !== 'family') {
    return 'none';
  }

  const forClass = table[canonical];

  return forClass != null ? minRung(forClass, fallback) : fallback;
}

/**
 * The more restrictive of two answer forms, compared on the disclosure ladder.
 *
 * Used to let the OWNER pick the form without letting them widen it. The
 * archetype-inferred form comes from `inferAnswerForm`, which reads the
 * asker-supplied `queryType` — so an owner choice that discloses MORE than the
 * archetype implies would hand the shape of the answer back to the asker's
 * input. Only a lower rung survives.
 *
 * A tie goes to `chosen`, not `inferred`: `boolean` and `identity` sit on the
 * same rung but read differently to the asker, and at equal disclosure the
 * owner's explicit pick is the one that carries intent.
 *
 * Pure.
 */
export function narrowerForm(chosen: AnswerForm, inferred: AnswerForm): AnswerForm {
  return rungAtLeast(rungForForm(inferred), rungForForm(chosen)) ? chosen : inferred;
}

/** The rung an answer of this form naturally occupies when nothing is withheld. */
export function rungForForm(form: AnswerForm): DisclosureRung {
  switch (form) {
    case 'boolean':
    case 'identity':
      return 'boolean';
    case 'existence':
      return 'count';
    case 'attribute':
      return 'summary';
    case 'retrieval':
    default:
      return 'full';
  }
}

/**
 * Clamp an already-built answer down to a ceiling.
 *
 * Downgrading only ever REMOVES information: item references are dropped first,
 * then counts, then everything. `withheldCount` is deliberately zeroed when the
 * ceiling hides the item set, because a withheld count is itself a signal about
 * how much the responder holds — at `count` and below the asker learns only what
 * the rung names.
 *
 * Pure.
 */
export function applyDisclosureCeiling(answer: DisclosedAnswer, ceiling: DisclosureRung): DisclosedAnswer {
  const natural = rungForForm(answer.form);
  const effective = minRung(natural, ceiling);

  if (effective === 'full') {
    // The item set already reflects the owner's redaction; nothing to clamp.
    return answer;
  }

  // `redacted` sits BELOW `full` on the ladder, and it used to return the same
  // object — `if (effective === 'full' || effective === 'redacted') return
  // answer` — which made a grant capped at "share only what I kept" disclose
  // exactly as much as one with no cap at all. A rung that clamps nothing is
  // not a rung; it is a label the owner can pick believing it does something.
  //
  // What the two rungs actually differ by, once `buildDisclosedAnswer` has
  // already dropped the owner's redacted ids, is the WITHHELD COUNT:
  //
  //   full     — every matching item reference, AND how many were held back
  //   redacted — the references the owner kept, and nothing about the rest
  //
  // So the clamp is to zero `withheldCount`. That is the same cut this function
  // already makes at every rung below (see the note above about a withheld
  // count being its own signal about how much the responder holds) — `redacted`
  // was simply skipping it. The asker keeps the references the owner chose to
  // share and stops learning that a redaction happened at all.
  if (effective === 'redacted') {
    return { ...answer, withheldCount: 0 };
  }

  const base = { ...answer, items: [] };

  switch (effective) {
    case 'summary':
      return { ...base, withheldCount: 0 };
    case 'count':
      return { ...base, withheldCount: 0, summary: countOnlySummary(answer.disclosedCount) };
    case 'boolean':
      return {
        ...base,
        disclosedCount: answer.disclosedCount > 0 ? 1 : 0,
        withheldCount: 0,
        summary: answer.disclosedCount > 0 ? 'Yes.' : 'No.',
      };
    case 'none':
    default:
      return {
        ...base,
        disclosedCount: 0,
        withheldCount: 0,
        summary: 'Nothing was shared.',
      };
  }
}

function countOnlySummary(count: number): string {
  return count === 1 ? '1 matching item.' : `${count} matching items.`;
}
