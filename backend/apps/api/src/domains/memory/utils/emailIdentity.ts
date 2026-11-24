/**
 * A shared email as duplicate-person evidence — the guards it needs.
 *
 * A mailbox is close to globally unique to a person, which is why a shared
 * email is the deterministic tier: `MergeCandidateService` folds such pairs
 * without asking, on read and hourly, and always INTO the self Person when
 * one endpoint is the owner. But contact cards are written by people, and a
 * card that lists one person's address beside another person's name — a card
 * for someone's assistant, a card merged in a phone's address book, a card
 * someone mistyped — puts two people on one mailbox. Folded, the fold carries
 * the card's other addresses along, so the next sweep folds whoever owns
 * THOSE. One real 4,927-card export has exactly such a card: named for a
 * friend, listing the friend's address and the owner's work one, which two
 * of the owner's own cards list too.
 *
 * Two holds, both capped below the auto-merge tier and marked `email_check`,
 * so the pair reaches the review queue labelled instead of being folded:
 *
 *  - `self_endpoint` — one side is the self Person and the other side's REAL
 *    name is not the owner's (`givenNameRelation`: a different given or
 *    family name, a Jr/Sr, a relational "Ada's brother"). The strict rule,
 *    because a wrong fold into "you" is the costliest one. The owner's own
 *    mail stubs (a participant minted from the owner's address, named by it)
 *    still fold.
 *  - `name_conflict` — two contacts whose full names have nothing in common
 *    ({@link namesShareNothing}). The owner's own contact cards are ordinary
 *    Persons (the self Person is minted from `ci.users`), so this is the hold
 *    that keeps the friend's card off them. Deliberately lenient: in that
 *    export, 63 addresses sit on cards that resolve to different people, and
 *    every other differently named pair among them is one person — a typo
 *    ("Cy Brightwater" / "Cy Brightwatr"), a nickname ("Dani" / "Danielle"),
 *    a maiden and married name ("Ida Quill" / "Ada Moss Quill") — which all
 *    keep a name in common and still fold.
 *
 * The phone tier never folds into the self Person at all
 * (`phoneIdentity.ts`), and holds on ANY name conflict: a phone is shared by
 * households and offices, a mailbox far more rarely.
 *
 * Pure. The detector applies it when it writes evidence; the drain re-applies
 * it to the live rows before every email fold.
 */

import { hasFamilyConflict, tokenizePersonName } from './personNameTokens';
import { givenNameRelation, isPlaceholderPersonName, type GivenNameRelation } from './phoneIdentity';

/** The evidence kinds this module reads and writes in `ci.merge_candidates.evidence`. */
export const EMAIL_EVIDENCE = {
  /** A shared mailbox. 0.95; folded without review unless held. */
  match: 'email',
  /** Why a shared-mailbox pair was held for a human. Carries no weight. */
  check: 'email_check',
} as const;

/** The score a held email item is capped at: the review tier, below every auto-merge floor. */
export const EMAIL_HELD_SCORE = 0.85;

/** Why a shared-mailbox pair was held. */
export type EmailCheckReason = 'self_endpoint' | 'name_conflict';

/** One endpoint of a pair, as the guard reads it. */
export interface EmailEndpoint {
  name: string | null | undefined;
  isSelf: boolean;
}

/** Relations under which the other side may be the owner under another spelling of their name. */
const COMPATIBLE: ReadonlySet<GivenNameRelation> = new Set(['same', 'initial', 'prefix', 'unknown']);

/**
 * Why this pair's shared email must not be folded, or null when it may be.
 *
 * Held as `self_endpoint`: exactly one side is the self Person, and the other
 * side carries a real name that {@link givenNameRelation} sets against the
 * owner's. Held as `name_conflict`: neither side is, and their names share
 * nothing ({@link namesShareNothing}). Folded: a placeholder on either side
 * (a mail stub, named by the address), a name that fits the owner's (`same`,
 * an initial, a nickname prefix) or says nothing either way (`unknown`), two
 * contacts whose names have anything in common, and two self endpoints (the
 * drain skips those anyway).
 */
export function emailHoldReason(a: EmailEndpoint, b: EmailEndpoint): EmailCheckReason | null {
  if (isPlaceholderPersonName(a.name) || isPlaceholderPersonName(b.name)) {
    return null;
  }

  if (a.isSelf !== b.isSelf) {
    const self = a.isSelf ? a : b;
    const other = a.isSelf ? b : a;

    return COMPATIBLE.has(givenNameRelation(self.name, other.name)) ? null : 'self_endpoint';
  }

  return !a.isSelf && namesShareNothing(a.name, b.name) ? 'name_conflict' : null;
}

/**
 * Whether two display names cannot be one person's under any variant the
 * email tier should fold through: each is a full name (a given name and a
 * surname), the given names are unrelated (neither equals nor starts the
 * other, so no nickname), the surnames conflict, and not one token of either
 * name appears in the other.
 *
 * "Cy Brightwater" / "Ada Quill" share nothing. Everything with a thread in
 * common folds: a shared surname ("Ada Quill" / "Ida Quill"), a shared given
 * name ("Ada Quill" / "Ada Moss"), a nickname ("Chris Quill" / "Christine
 * Moss"), a token in any position ("Bo Brightwater" / "Cy Bo"). So does
 * anything short of a full name on either side: a lone given name, a leading
 * initial ("A. Quill"), a relational "Ada's brother". A typo in both halves
 * ("Issac Quil" / "Isaac Quill") is held — one click in the review queue,
 * where a wrong fold costs a person.
 */
export function namesShareNothing(
  left: string | null | undefined,
  right: string | null | undefined,
): boolean {
  const a = tokenizePersonName(left);
  const b = tokenizePersonName(right);

  if (a == null || b == null || a.isRelational || b.isRelational) {
    return false;
  }

  if (a.given == null || a.family == null || b.given == null || b.family == null) {
    return false;
  }

  if (a.given.startsWith(b.given) || b.given.startsWith(a.given) || !hasFamilyConflict(a, b)) {
    return false;
  }

  return a.values.every((value) => !b.set.has(value));
}

/** Any evidence item — the detector's (numeric score) or one parsed back from a row (nullable). */
interface EmailEvidenceLike {
  kind: string;
  value: string;
  score: number | null;
}

/**
 * Hold a candidate's email evidence for review: every `email` item capped at
 * {@link EMAIL_HELD_SCORE}, one `email_check` marker naming `reason`, and the
 * score rescored to the strongest item left (never above the stored score, so
 * a profile-URL veto's cap survives). Idempotent.
 *
 * The marker is written even when the evidence carries no `email` item: the
 * drain also folds pairs whose shared mailbox it finds in their claims or
 * properties rather than in the evidence, and the marker is what stops it.
 */
export function holdEmailEvidence<E extends EmailEvidenceLike>(
  candidate: { readonly score: number; readonly evidence: readonly E[] },
  reason: EmailCheckReason,
): { score: number; evidence: Array<E | { kind: string; value: string; score: number }> } {
  const evidence: Array<E | { kind: string; value: string; score: number }> = candidate.evidence
    .filter((item) => item.kind !== EMAIL_EVIDENCE.check)
    .map((item) =>
      item.kind === EMAIL_EVIDENCE.match && (item.score ?? 0) > EMAIL_HELD_SCORE
        ? { ...item, score: EMAIL_HELD_SCORE }
        : item,
    );

  evidence.push({ kind: EMAIL_EVIDENCE.check, value: reason, score: 0 });
  evidence.sort((x, y) => (y.score ?? 0) - (x.score ?? 0) || x.kind.localeCompare(y.kind));

  const strongest = Math.max(0, ...evidence.map((item) => item.score ?? 0));

  return { score: Math.min(candidate.score, strongest), evidence };
}
