/**
 * Pure presentation helpers for the ask surfaces.
 *
 * Kept free of React so they can be unit-tested directly — the disclosure and
 * consent vocabulary is exactly the sort of thing that must not drift silently
 * between the backend policy engine and what the owner is shown.
 */

import type { AnswerForm, PeerTrustTier } from '@/graphql/graphql';

/** Consent posture of a standing grant (mirrors GrantMode on the backend). */
export type GrantMode = 'auto' | 'review' | 'block';

/** How much an answer disclosed (mirrors DisclosureRung). Coarsest first. */
export type DisclosureRung = 'none' | 'boolean' | 'count' | 'summary' | 'redacted' | 'full';

export type AskStatus =
  | 'sent'
  | 'delivered'
  | 'under_review'
  | 'answering'
  | 'answered'
  | 'declined'
  | 'expired';

/**
 * Owner-facing label for a grant mode.
 *
 * Deliberately plain language: the Grant Manager is read by people deciding who
 * may ask them what, not by engineers.
 */
export function grantModeLabel(mode: GrantMode): string {
  switch (mode) {
    case 'auto':
      return 'Answers automatically';
    case 'block':
      return 'Blocked';
    case 'review':
    default:
      return 'Ask me first';
  }
}

/**
 * Short badge text for a grant mode.
 *
 * Every status is ALSO carried in text, never colour alone — WCAG 1.4.1 (use of
 * colour). The badge variant only reinforces what the words already say.
 */
export function grantModeBadge(mode: GrantMode): {
  label: string;
  variant: 'default' | 'secondary' | 'destructive' | 'outline';
} {
  switch (mode) {
    case 'auto':
      return { label: 'Auto', variant: 'default' };
    case 'block':
      return { label: 'Blocked', variant: 'destructive' };
    case 'review':
    default:
      return { label: 'Ask first', variant: 'secondary' };
  }
}

/** Owner-facing status line for an ask. */
export function askStatusLabel(status: AskStatus): string {
  switch (status) {
    case 'sent':
      return 'Sending…';
    case 'delivered':
      return 'Waiting for them';
    case 'under_review':
      return 'Waiting for your review';
    case 'answering':
      return 'Preparing the answer';
    case 'answered':
      return 'Answered';
    case 'declined':
      return 'Declined';
    case 'expired':
      return 'Expired';
    default:
      return status;
  }
}

/** Whether an ask is still waiting on the owner. */
export function needsOwnerReview(status: AskStatus): boolean {
  return status === 'under_review';
}

/**
 * Whether a human looked at this answer before it left the box.
 *
 * THREE values, not two, and the third is the whole point. `AskAnswerType`
 * carries no auto-vs-reviewed flag at all, and the one field that could stand
 * in — `consentBasis` — is projected to NULL for the asker on purpose (it is
 * the id of one of the responder's own grant rows, and handing it over turns
 * the answer into a grant-matrix oracle). So the person who ASKED genuinely
 * cannot be told, and a card that defaulted `autoAnswered` to `false` would
 * print "reviewed by Sam" over an answer Sam never saw.
 *
 * `'undisclosed'` is what that looks like when it is said out loud. The
 * responder's own history CAN say — `AskAuditType.outcome` separates `answered`
 * from `auto_answered` — which is why the same card renders a real value there.
 */
export type AnswerReview = 'auto' | 'reviewed' | 'undisclosed';

/**
 * The provenance line shown on an answer — prose, not badges.
 *
 * "Answered by X's Companion, reviewed by X, under your family grant" is the
 * single most load-bearing sentence in the feature: it is how the asker knows
 * the answer is real, who stood behind it, and on what basis. An auto-answered
 * reply must never claim a human reviewed it — and, just as importantly, an
 * answer whose provenance was never disclosed must not claim either one.
 */
export function provenanceLine(params: {
  responderName: string;
  review: AnswerReview;
  consentBasis?: string | null;
}): string {
  const who = `Answered by ${params.responderName}'s Companion`;
  const how = reviewClause(params.review, params.responderName);
  const basis = params.consentBasis ? ` · ${params.consentBasis}` : '';

  return `${who} · ${how}${basis}`;
}

function reviewClause(review: AnswerReview, responderName: string): string {
  switch (review) {
    case 'auto':
      return 'answered automatically under a standing grant';
    case 'reviewed':
      return `reviewed by ${responderName}`;
    case 'undisclosed':
    default:
      // Deliberately says that the FACT is withheld rather than hedging about
      // the answer. "Possibly reviewed" would read as a weak yes; this reads as
      // what it is — a question their box declined to answer.
      return `whether ${responderName} saw this personally is not disclosed to you`;
  }
}

/**
 * How the withheld count is described to the asker.
 *
 * The COUNT is disclosed; WHICH items were withheld never is. Returning null
 * (rather than "0 withheld") keeps the common case quiet.
 */
export function withheldNote(withheldCount: number): string | null {
  if (withheldCount <= 0) {
    return null;
  }

  return withheldCount === 1 ? '1 item withheld' : `${withheldCount} items withheld`;
}

/**
 * Human summary of what a rung discloses.
 *
 * NO CALLER TODAY, and deliberately kept. It was the "share less" control's
 * vocabulary until that control was rewired to `AnswerForm` — the type
 * `runAsk(disclosureForm:)` actually accepts — see OWNER_ANSWER_FORMS below for
 * why the two ladders are not interchangeable. Rungs remain the vocabulary of
 * CEILINGS on this page's roadmap ("this answer was capped at 'just how many'",
 * which the wire cannot yet say), so the words are worth keeping in one place
 * rather than reinvented later beside the form labels they must not duplicate.
 */
export function rungLabel(rung: DisclosureRung): string {
  switch (rung) {
    case 'full':
      return 'Everything that matched';
    case 'redacted':
      return 'Only what I pick';
    case 'summary':
      return 'A summary only';
    case 'count':
      return 'Just how many';
    case 'boolean':
      return 'Just yes or no';
    case 'none':
    default:
      return 'Nothing';
  }
}

/**
 * ═══ THE OWNER'S "ANSWER WITH LESS" LADDER ═══
 *
 * `rungLabel` above speaks `DisclosureRung`, which is the vocabulary of
 * CEILINGS — what a tier or a grant caps an answer at. It is NOT what
 * `runAsk(disclosureForm:)` accepts. That argument is an `AnswerForm`, and the
 * two ladders are related but not the same: `rungForForm` on the backend maps
 * boolean/identity → `boolean`, existence → `count`, attribute → `summary`,
 * retrieval → `full`. Offering the owner a rung and sending it as a form would
 * either fail the schema or, worse, send a value that means something else.
 *
 * So the control speaks forms, and the labels are written as CEILINGS ("at
 * most") rather than as promises ("a summary"). That wording is load-bearing:
 * `narrowerForm(chosen, inferred)` keeps whichever of the owner's pick and the
 * archetype-inferred form sits LOWER on the ladder, so the owner's choice can
 * only ever cap the answer. If the ask was already going to be a yes/no,
 * picking "at most a count" still yields a yes/no — which "at most" describes
 * correctly and "a count" would not.
 */
export const OWNER_ANSWER_FORMS: readonly AnswerForm[] = ['boolean', 'existence', 'attribute'];

/**
 * Owner-facing label for an answer form, phrased as the ceiling it imposes.
 *
 * `identity` is deliberately absent from {@link OWNER_ANSWER_FORMS}: it sits on
 * the same rung as `boolean` but reads differently to the asker ("yes, that is
 * me"), so it is a different ANSWER rather than a smaller one, and offering it
 * as a way to share less would be a lie about what it does.
 */
export function answerFormLabel(form: AnswerForm): string {
  switch (form) {
    case 'boolean':
      return 'At most yes or no';
    case 'existence':
      return 'At most how many';
    case 'attribute':
      return 'At most a summary';
    case 'identity':
      return 'At most confirming who they asked about';
    case 'retrieval':
    default:
      return 'At most the matching items';
  }
}

/**
 * Where an inbox ask actually stands, which is NOT the same question as who is
 * asking.
 *
 * The card used to render every pending ask identically and let a trust badge
 * ("known contact" / "no standing grant") carry the whole difference. That
 * badge answers "do I know them", and the owner reads it as "is this decision
 * still mine to make" — which it is not. An ask the owner PRE-AUTHORIZED with a
 * standing `auto` grant reaches the inbox already authorized: `AskService.submit`
 * leaves it at `delivered` and stamps `consentBasis`, and `isAnswerable` accepts
 * exactly that shape without any approval. Showing it with an Approve button and
 * a quarantine warning misdescribes it in both directions at once — it implies a
 * gate that has already opened, and it implies the owner is about to decide
 * something they decided earlier.
 *
 * The predicate below is deliberately the mirror image of the backend's
 * `isAnswerable(status, consentBasis)` second accepted shape. If that gate ever
 * changes, this must change with it or the card starts lying again.
 */
export type AskDecisionState =
  /** Already authorized by a standing grant; no approval is outstanding. */
  | 'pre-authorized'
  /** A grant matched, but it routes to the owner rather than answering. */
  | 'covered-review'
  /** Nothing covers this asker; the owner's decision is the only gate. */
  | 'unreviewed';

export function askDecisionState(
  status: AskStatus,
  consentBasis: string | null | undefined,
): AskDecisionState {
  if (!consentBasis) {
    return 'unreviewed';
  }

  return status === 'delivered' ? 'pre-authorized' : 'covered-review';
}

/** The sentence the consent card leads with, in the owner's own terms. */
export function askDecisionNote(state: AskDecisionState): string {
  switch (state) {
    case 'pre-authorized':
      return 'A standing grant you gave already authorizes this. It is waiting to be answered, not for your permission — decline it here if you have changed your mind.';
    case 'covered-review':
      return 'A standing grant covers this asker, and it routes their asks to you rather than answering them.';
    case 'unreviewed':
    default:
      return 'No standing grant covers this request. Nothing is shared unless you approve it.';
  }
}

/** Label for the card's primary button, which is a different act per state. */
export function askApproveLabel(state: AskDecisionState): string {
  return state === 'pre-authorized' ? 'Answer now' : 'Approve and answer';
}

/** Terminal outcomes recorded in `ci.ask_audit` (mirrors AskAuditOutcome). */
export type AskAuditOutcome = 'answered' | 'auto_answered' | 'declined' | 'expired';

/**
 * Short badge text for a disclosure-history outcome.
 *
 * `answered` and `auto_answered` get DIFFERENT labels, and that separation is
 * the reason this function exists rather than a `startCase(outcome)`. They are
 * the same event from the asker's side and completely different events from the
 * owner's: one is a decision they made, the other is a rule they wrote once
 * acting on their behalf while they were not looking. Collapsing them into
 * "Answered" would hide the only outcome in this list that an owner might want
 * to go and stop.
 */
export function outcomeBadge(outcome: AskAuditOutcome): {
  label: string;
  variant: 'default' | 'secondary' | 'destructive' | 'outline';
} {
  switch (outcome) {
    case 'auto_answered':
      return { label: 'Answered automatically', variant: 'default' };
    case 'answered':
      return { label: 'You answered', variant: 'secondary' };
    case 'declined':
      return { label: 'Declined', variant: 'outline' };
    case 'expired':
    default:
      return { label: 'Expired', variant: 'outline' };
  }
}

/** The history row's lead sentence, in the owner's own terms. */
export function outcomeSentence(outcome: AskAuditOutcome, askerName: string): string {
  switch (outcome) {
    case 'auto_answered':
      return `A standing grant answered ${askerName} without asking you.`;
    case 'answered':
      return `You reviewed this and answered ${askerName}.`;
    case 'declined':
      return `This was declined. Nothing was shared with ${askerName}.`;
    case 'expired':
    default:
      return `This expired before it was answered. Nothing was shared with ${askerName}.`;
  }
}

/**
 * How much crossed, said in a way a non-terminal-answered outcome cannot
 * misread.
 *
 * `disclosedCount` is 0 on a declined or expired row because nothing happened,
 * and 0 on an ANSWERED row whose form disclosed no item references — a yes/no
 * still told the asker something. Printing "0 items shared" over both makes the
 * second one look like the first, which on a disclosure record is the reassuring
 * lie this whole page exists to avoid.
 */
export function disclosureMagnitudeNote(outcome: AskAuditOutcome, disclosedCount: number): string {
  if (outcome === 'declined' || outcome === 'expired') {
    return 'nothing was shared';
  }

  if (disclosedCount <= 0) {
    return 'answered without sending any items — but an answer is still something shared';
  }

  return disclosedCount === 1 ? '1 item shared' : `${disclosedCount} items shared`;
}

/**
 * ═══ THE PEER TRUST LADDER, WIDEST FIRST ═══
 *
 * A peer link's tier is not a label. `policy.ts` maps each one to a maximum
 * disclosure rung — family `full`, trusted `redacted`, peer `summary`, stranger
 * `boolean` — so it is the CEILING on everything that peer can ever be told, and
 * it applies to every answer regardless of which grant authorized it.
 *
 * The ORDER below is what lets the UI tell a widening change from a narrowing
 * one, which is the difference between a control that needs a confirmation and
 * one that does not. `household` is deliberately absent: it means "shares this
 * appliance", the DB CHECK on `ci.peer_links.trust_tier` rejects it, and it is
 * the one tier exempt from the sensitive-class floor.
 */
export const PEER_TRUST_TIERS = [
  'family',
  'trusted',
  'peer',
  'stranger',
] as const satisfies readonly PeerTrustTier[];

/**
 * Re-exported from codegen rather than re-declared.
 *
 * The `satisfies` above is the load-bearing half: it makes this array a subset
 * of the generated enum, so a tier ADDED to the schema is silently absent from
 * the dial (safe — an unknown tier renders as itself and reads as widest) while
 * a tier REMOVED from the schema, or misspelled here, fails the build. A
 * hand-written union would have failed neither.
 */
export type { PeerTrustTier };

/**
 * Whether moving from `from` to `to` lets this peer be told MORE.
 *
 * Index in {@link PEER_TRUST_TIERS} is the whole implementation, and the array
 * is ordered widest-first, so a SMALLER index is more permissive.
 *
 * An unknown tier (a value from a newer server) is treated as the widest
 * possible, which makes any move away from it read as narrowing and any move
 * TOWARD it read as widening. That is the safe direction: the failure mode is
 * an unnecessary confirmation prompt, not a silent escalation.
 *
 * Pure.
 */
export function widensPeerTrust(from: string, to: string): boolean {
  const rank = (tier: string) => {
    const index = (PEER_TRUST_TIERS as readonly string[]).indexOf(tier);

    return index === -1 ? 0 : index;
  };

  return rank(to) < rank(from);
}

/** Owner-facing name for a tier, phrased as the ceiling it sets. */
export function peerTrustLabel(tier: string): string {
  switch (tier) {
    case 'family':
      return 'Family';
    case 'trusted':
      return 'Trusted';
    case 'peer':
      return 'Peer';
    case 'stranger':
      return 'Stranger';
    default:
      // Never invented. A tier this client does not know about is reported as
      // itself rather than mapped onto the nearest familiar word.
      return tier;
  }
}

/**
 * What a tier actually permits, in the owner's words.
 *
 * ═══ THIS IS THE EFFECTIVE CEILING, NOT THE TABLE ═══
 *
 * `TIER_CEILINGS` in policy.ts is not the answer on its own, and reading it as
 * if it were is how these four sentences were wrong the first time. Two rules in
 * `disclosureCeiling` run AFTER the table lookup and both of them tighten it:
 *
 *  - THE SENSITIVE FLOOR. `location`, `health`, `medical`, `financial`,
 *    `finance`, `secrets` and `credentials` return `none` outright for every
 *    tier below `family`. So `trusted`'s `location: 'summary'` row and `peer`'s
 *    `location: 'count'` row are unreachable — those classes are not summarised
 *    or counted for a trusted peer, they are refused. The note used to promise
 *    the table's value, which described MORE disclosure than ever happens.
 *  - A PER-CLASS ENTRY MAY ONLY TIGHTEN `'*'`. `peer`'s `photos: 'redacted'`
 *    sits ABOVE its `'*': 'summary'` on the ladder, so it is clamped back down
 *    to `summary`; naming "photos" buys a peer nothing. The old note said
 *    photos were "redacted" for a peer, which was the pre-clamp reading of that
 *    same row.
 *
 * Both corrections point the same way — less is disclosed than these sentences
 * used to claim — which is the safe direction to have been wrong in, and still
 * the wrong direction for a consent surface: an owner who believes a tier leaks
 * more than it does sets it lower than they need to, and one who later learns
 * the copy was decorative stops trusting the dial at all.
 *
 * The ceiling caps EVERY answer, auto and owner-reviewed alike — `runAsk`
 * applies it after the grant and the owner's own form choice — so these read as
 * absolutes rather than as "unless you approve it".
 */
export function peerTrustCeilingNote(tier: string): string {
  switch (tier) {
    case 'family':
      // The only tier the sensitive floor does not apply to, which is the fact
      // that actually distinguishes it from `trusted` — worth more than the
      // rung name to somebody deciding whether to promote a person.
      return 'The widest tier: an ask that names a data class can be answered with item references, and it is the only tier where health, finances and secrets are answerable at all. Your location is redacted, never exact.';
    case 'trusted':
      return 'Answers are redacted at most — the items you keep, never the ones you hold back. Location, health, finances and secrets are never disclosed at this tier.';
    case 'peer':
      return 'Answers are summaries at most — a sentence and a count, never item references, and naming “photos” does not change that. Location, health, finances and secrets are never disclosed at this tier.';
    case 'stranger':
      return 'Answers are yes or no at most, your location is never disclosed, and an ask that names no data class gets nothing at all.';
    default:
      return 'This tier is not one this page knows; treat it as unbounded until you check.';
  }
}

/** What made an ask, as the wire carries it. */
export interface AskActorView {
  kind: string;
  label?: string | null;
}

/**
 * Who — or WHAT — is asking, in one line for the consent moment.
 *
 * ═══ WHY THIS IS ITS OWN LINE AND NOT A BADGE ═══
 *
 * "Ana is asking" and "something Ana delegated to is asking" are different
 * consent decisions, and the second is the newer and less familiar of the two.
 * Compressing it into a chip beside the name would put the least understood
 * fact in the smallest type on the card.
 *
 * ═══ THE LABEL IS QUOTED, NOT ASSERTED ═══
 *
 * `label` is a string the ASKER writes and this box never verifies — the same
 * class of input as the prompt, which is why the prompt goes through
 * `AskerQuote`. So the label is attributed ("calling itself …") rather than
 * stated, and the KIND — which is a commitment, and what the consent evaluator
 * actually matches on — carries the meaning.
 *
 * Returns null when the ask declares no actor, because there is nothing
 * truthful to say. The absence is not neutral, though: a grant restricting
 * delegation will not auto-answer an ask that declines to say who is acting,
 * so an undeclared actor is part of why some asks reach the inbox at all.
 */
export function actorLine(actor: AskActorView | null | undefined): string | null {
  if (actor == null) {
    return null;
  }

  const calling = actor.label?.trim() ? ` calling itself \u201C${actor.label.trim()}\u201D` : '';

  switch (actor.kind) {
    case 'person':
      return 'They say a person is asking, not software acting for them.';
    case 'first-party-agent':
      return `Their own Companion is asking on their behalf${calling}.`;
    case 'third-party-agent':
      return `Software they delegated to is asking${calling} — not their own Companion.`;
    default:
      // An unrecognized kind reaches here only if the server's vocabulary grew
      // past this build's. Say what is known and claim nothing more.
      return 'Something is asking on their behalf, and this app does not recognise what.';
  }
}

/**
 * Whether an actor should be drawn attention to.
 *
 * True for delegated software, false for a person and for an UNDECLARED actor.
 * Not true for undeclared: an ask with no actor is the ordinary case today —
 * nothing sends the field yet — and marking every ask as noteworthy would make
 * the mark worthless by the time it means something.
 */
export function actorIsDelegated(actor: AskActorView | null | undefined): boolean {
  return actor?.kind === 'first-party-agent' || actor?.kind === 'third-party-agent';
}

/**
 * WHY the asker says they want this, shown at the consent moment.
 *
 * ═══ CARRIED, SHOWN, NEVER JUDGED ═══
 *
 * UMA-for-agents' recommendation #15 is *stated intent, never evaluated*: let a
 * requester declare their purpose, carry it unread, and let policy notice its
 * ABSENCE rather than judge its truthfulness. That is exactly right here — this
 * box has no way to verify why anyone wants anything, and a UI that implied it
 * had checked would be asserting something nobody checked.
 *
 * So the purpose is ATTRIBUTED, like the prompt and the actor label: it appears
 * as something they said, not as something established. The one place a purpose
 * is enforced is a purpose-LIMITED grant, which is the owner's own narrowing
 * and can only ever refuse to match.
 *
 * Null when none was stated — and the absence is worth noticing rather than
 * hiding, which is why `purposeAbsentNote` exists beside this.
 */
export function purposeLine(purpose: unknown): string | null {
  if (typeof purpose !== 'string' || !purpose.trim()) {
    return null;
  }

  return `They say this is for: \u201C${purpose.trim()}\u201D`;
}

/**
 * The note shown when an ask states no purpose at all.
 *
 * Deliberately mild. Most asks state none — nothing populates the field on the
 * local path yet — so this is a fact, not a flag. It exists because "they did
 * not say why" is a real input to a consent decision, and a card that simply
 * omitted the line would leave the owner unable to tell it from "the app did
 * not show me".
 */
export function purposeAbsentNote(purpose: unknown): string | null {
  return purposeLine(purpose) == null ? 'They did not say what this is for.' : null;
}

/**
 * Whether a grant has ever fired, and when it last did.
 *
 * ═══ DORMANT IS A STATE, AND THE MATRIX COULD NOT SHOW IT ═══
 *
 * The Grant Manager showed what an owner ALLOWED and never whether anything
 * came of it, so a grant firing daily and one that has never once matched
 * looked identical — and they call for opposite actions. The dormant one is
 * clutter to tidy up; the busy one is the thing to look at twice.
 *
 * "Never used" is stated plainly and WITHOUT alarm. It is the ordinary state of
 * a grant somebody wrote in advance, which is exactly what standing consent is
 * for.
 */
export function grantUsageLine(
  usage: { useCount: number; lastUsedAt?: string | null },
  now: Date = new Date(),
): string {
  if (usage.useCount <= 0 || !usage.lastUsedAt) {
    return 'Never used';
  }

  const times = usage.useCount === 1 ? 'Used once' : `Used ${usage.useCount} times`;
  const last = lastActiveRelative(usage.lastUsedAt, now);

  return last ? `${times} · last ${last}` : times;
}

/** "3 days ago" / "today", or null when the value is unreadable. */
function lastActiveRelative(iso: string, now: Date): string | null {
  const at = new Date(iso);

  if (Number.isNaN(at.getTime())) {
    return null;
  }

  const days = Math.floor((now.getTime() - at.getTime()) / 86_400_000);

  if (days < 0) {
    return null;
  }

  if (days === 0) {
    return 'today';
  }

  if (days === 1) {
    return 'yesterday';
  }

  if (days < 30) {
    return `${days} days ago`;
  }

  const months = Math.floor(days / 30);

  return `${months} month${months === 1 ? '' : 's'} ago`;
}

/**
 * Grants that will lapse on their own within `withinDays`.
 *
 * ONLY LIVE ONES, and only ones that actually carry an expiry. A revoked grant
 * cannot lapse and a grant with no `expiresAt` never will, so counting either
 * would inflate a nudge whose whole value is that it is rare enough to read.
 *
 * An expiry ALREADY PAST is excluded too: that grant has lapsed, which is a
 * thing that happened rather than a thing about to. `active` from the server is
 * what decides liveness — the client re-deriving it from `revokedAt` alone is
 * how a lapsed grant gets treated as live.
 */
export function grantsLapsingWithin<T extends { active: boolean; expiresAt?: string | null }>(
  grants: readonly T[],
  withinDays: number,
  now: Date = new Date(),
): T[] {
  const horizon = now.getTime() + withinDays * 86_400_000;

  return grants.filter((grant) => {
    if (!grant.active || !grant.expiresAt) {
      return false;
    }

    const at = new Date(grant.expiresAt).getTime();

    return Number.isFinite(at) && at > now.getTime() && at <= horizon;
  });
}

/**
 * The nudge shown above the matrix, or null when there is nothing to say.
 *
 * Null rather than "0 grants lapse soon" — a banner that renders every time
 * teaches people to look past the banner, and then the one time it matters they
 * look past it too.
 */
export function lapseNudge(count: number, withinDays: number): string | null {
  if (count <= 0) {
    return null;
  }

  const grants = count === 1 ? '1 grant' : `${count} grants`;

  return `${grants} will lapse on their own within ${withinDays} days. They stop answering when they do — nothing else changes.`;
}
