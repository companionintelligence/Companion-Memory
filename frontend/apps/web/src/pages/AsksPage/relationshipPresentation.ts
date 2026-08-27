/**
 * Pure presentation for the relationship-first disclosure view.
 *
 * The flat history answers "what happened at 14:07 on Tuesday". The question an
 * owner actually arrives with is "what has Ana been getting?", and every helper
 * here exists to answer that in a sentence they can act on rather than a number
 * they have to interpret.
 */

/** Matches `UNATTRIBUTED` in the backend's `disclosureSummary.ts`. */
export const UNATTRIBUTED_KEY = 'unattributed';

/** The wire shape of one folded relationship. */
export interface RelationshipSummary {
  key: string;
  // Nullable AND optional, matching the generated GraphQL types: a nullable
  // field arrives as `string | null | undefined`, and narrowing it here would
  // force every call site to map the payload just to satisfy this file.
  askerId?: string | null;
  peerLinkId?: string | null;
  peerHandle?: string | null;
  total: number;
  autoAnswered: number;
  reviewed: number;
  declined: number;
  expired: number;
  itemsDisclosed: number;
  asksInWindow: number;
  itemsInWindow: number;
  firstAt: string;
  lastAt: string;
}

/**
 * What to call a counterparty.
 *
 * NEVER INVENTS A NAME. A federated peer has a handle; a LOCAL asker has only
 * an opaque id on this wire, and the surface says so rather than dressing the
 * id up as a person. That is the same rule `partyAvatar` and the review card
 * already follow — a history that labelled someone confidently and wrongly is
 * worse than one that admits what it does not know, because the owner may act
 * on it by revoking the wrong person.
 */
export function relationshipLabel(summary: RelationshipSummary): string {
  if (summary.key === UNATTRIBUTED_KEY) {
    // Deliberately not "Unknown person": there may be several, and calling the
    // bucket a person would imply these disclosures went to one.
    return 'Unattributed disclosures';
  }

  const handle = summary.peerHandle?.trim();
  if (handle) {
    return handle;
  }

  const id = summary.askerId ?? summary.peerLinkId ?? '';

  return id ? `Someone on this box · …${id.slice(-6)}` : 'Someone on this box';
}

/** Whether this row is the unattributed bucket rather than a person. */
export function isUnattributed(summary: RelationshipSummary): boolean {
  return summary.key === UNATTRIBUTED_KEY;
}

/**
 * The outcome split, in the owner's words.
 *
 * `autoAnswered` LEADS, and is named as the thing that happened without them.
 * Summing it into a single "answered" count is the one simplification this line
 * must not make: the two differ by whether a human was in the loop, which is
 * the entire question an owner is here to answer.
 *
 * Zero-valued parts are dropped rather than printed as "0 declined" — a list of
 * zeroes buries the number that is not zero.
 */
export function activityLine(summary: RelationshipSummary): string {
  const parts: string[] = [];

  if (summary.autoAnswered > 0) {
    parts.push(`${summary.autoAnswered} answered automatically`);
  }

  if (summary.reviewed > 0) {
    parts.push(`${summary.reviewed} you reviewed`);
  }

  if (summary.declined > 0) {
    parts.push(`${summary.declined} declined`);
  }

  if (summary.expired > 0) {
    parts.push(`${summary.expired} expired unanswered`);
  }

  return parts.length > 0 ? parts.join(' · ') : 'No terminal outcomes recorded.';
}

/**
 * How much actually crossed, all time and lately.
 *
 * MAGNITUDE, NOT ASK COUNT. "14 asks" and "213 items" are different facts and
 * only the second one describes what the other person now holds.
 */
export function magnitudeLine(summary: RelationshipSummary, windowDays: number): string {
  const items = `${summary.itemsDisclosed} item${summary.itemsDisclosed === 1 ? '' : 's'} shared`;

  if (summary.itemsInWindow === 0) {
    return `${items} · none in the last ${windowDays} days`;
  }

  return `${items} · ${summary.itemsInWindow} in the last ${windowDays} days`;
}

/**
 * The share of a relationship's disclosure that is recent, as a sentence — or
 * null when there is nothing worth saying.
 *
 * DELIBERATELY NOT A VERDICT. There is no enforced disclosure budget yet
 * (CI-Server #2364), so a threshold rendered here would be a number with
 * nothing behind it — the "protection that is not there" this domain has been
 * burned by. What it says instead is a fact: most of what they have ever
 * received, they received lately.
 *
 * Null below the threshold so the line appears only when it is telling the
 * owner something they did not already read off the two numbers.
 */
export function accelerationNote(summary: RelationshipSummary): string | null {
  if (summary.itemsDisclosed <= 0 || summary.itemsInWindow <= 0) {
    return null;
  }

  const share = summary.itemsInWindow / summary.itemsDisclosed;

  if (share < 0.6) {
    return null;
  }

  if (share >= 0.999) {
    return 'Everything they have ever received, they received in this window.';
  }

  return `${Math.round(share * 100)}% of everything they have ever received arrived in this window.`;
}

/**
 * "Last shared 3 days ago", give or take.
 *
 * RELATIVE here, unlike the individual rows, and the difference is deliberate.
 * A row answers "did this happen when I think it did", which needs a date. An
 * index answers "is this still going on", which is a duration — and reading
 * fourteen absolute timestamps to work out which relationship is live is the
 * scrolling-and-tallying the fold exists to remove.
 */
export function lastActiveLine(lastAt: string, now: Date = new Date()): string {
  const at = new Date(lastAt);

  if (Number.isNaN(at.getTime())) {
    return lastAt;
  }

  const ms = now.getTime() - at.getTime();
  const days = Math.floor(ms / 86_400_000);

  if (ms < 0) {
    // A future timestamp is a clock problem, not a duration. Say the date.
    return at.toLocaleDateString(undefined, { dateStyle: 'medium' });
  }

  if (days === 0) {
    return 'Last shared today';
  }

  if (days === 1) {
    return 'Last shared yesterday';
  }

  if (days < 30) {
    return `Last shared ${days} days ago`;
  }

  if (days < 365) {
    const months = Math.floor(days / 30);

    return `Last shared ${months} month${months === 1 ? '' : 's'} ago`;
  }

  const years = Math.floor(days / 365);

  return `Last shared ${years} year${years === 1 ? '' : 's'} ago`;
}

/**
 * The sentence shown when a fold ran over a capped read.
 *
 * Rendered rather than hidden: the totals beside it are FLOORS, and a
 * completeness surface that presents a floor as a total is the exact failure
 * the `truncated` flag was put on the wire to prevent.
 */
export function truncationNote(truncated: boolean, shown: number): string | null {
  if (!truncated) {
    return null;
  }

  return `Counted from your ${shown.toLocaleString()} most recent disclosures. Older ones exist, so these totals are minimums.`;
}
