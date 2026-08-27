import type { AskAudit } from './entities/AskAuditEntity';
import type { AskAuditOutcome } from './types';

/**
 * Disclosure history, aggregated BY RELATIONSHIP rather than by event.
 *
 * ═══ WHY THE UNIT IS THE PERSON, NOT THE ASK ═══
 *
 * `askDisclosureHistory` returns every audit row this box holds, in one flat
 * reverse-chronological list, with no filter and no window. Its own surface
 * exists because "you cannot withdraw consent you cannot see the consequences
 * of" — and a standing grant answering twice a day produces some seven hundred
 * rows a year. The list is therefore at its LEAST usable exactly when it has
 * accumulated the most to say, which is the opposite of what an audit trail is
 * for.
 *
 * Pagination alone would not fix that, because the unit is wrong. The question
 * an owner actually arrives with is not "what happened at 14:07 on Tuesday", it
 * is "what has Ana been getting?" — and answering it from a flat list means
 * holding a running tally in your head while you scroll. So the tally is
 * computed here, and the flat list becomes the drill-in.
 *
 * ═══ EVERYTHING HERE IS PURE ═══
 *
 * Given the same rows and the same `now`, the same summary. That matters more
 * than usual for this module: these numbers are what an owner will act on when
 * deciding whether to revoke, and a figure that shifts because it was computed
 * twice is worse than no figure. `now` is a parameter for the same reason it is
 * everywhere else in this domain.
 */

/** Who a disclosure was made to. Exactly one of the two ids identifies them. */
export interface DisclosureCounterparty {
  /**
   * Stable grouping key. `user:<id>` for a local asker, `peer:<linkId>` for a
   * federated one, {@link UNATTRIBUTED} when the row names neither.
   */
  key: string;
  askerUserId: string | null;
  peerLinkId: string | null;
  /** The peer's handle AS OF the most recent disclosure — see {@link summarizeDisclosures}. */
  peerHandle: string | null;
}

/**
 * The bucket for audit rows that name neither a local asker nor a peer link.
 *
 * Such a row should not exist — `ci.ask_audit` records one or the other — but
 * the columns are nullable and FK-less by design (the audit outlives both
 * parties), so a row whose counterparty has been erased is reachable.
 *
 * They are collected under ONE key rather than dropped, because dropping them
 * would make the totals silently disagree with the row count. They are
 * deliberately NOT merged into any real person's bucket: attributing an
 * unattributable disclosure to someone specific is the one error this surface
 * must never make, since the owner may act on it by revoking that person.
 */
export const UNATTRIBUTED = 'unattributed';

export interface DisclosureSummary {
  counterparty: DisclosureCounterparty;
  /** Terminal outcomes recorded for this counterparty, all time. */
  total: number;
  /** Released by a standing grant, with no human in the loop. */
  autoAnswered: number;
  /** The owner decided this one personally. */
  reviewed: number;
  declined: number;
  expired: number;
  /**
   * How many items actually crossed, all time — the sum of `disclosedCount`,
   * which is the magnitude the asker received, not the number of asks.
   */
  itemsDisclosed: number;
  /** Asks in the recency window. */
  asksInWindow: number;
  /** Items disclosed in the recency window. */
  itemsInWindow: number;
  firstAt: Date;
  lastAt: Date;
}

/**
 * Fold audit rows into one summary per counterparty.
 *
 * ═══ THE WINDOW IS HALF-OPEN, AND IT IS `(now - windowMs, now]` ═══
 *
 * A row stamped exactly at the boundary counts as INSIDE. The alternative
 * drops a disclosure from the window on a tie, and the tie is not rare: rows
 * written in the same transaction share a timestamp to the microsecond, so an
 * exclusive lower bound loses whole batches rather than edge cases.
 *
 * `peerHandle` is taken from the MOST RECENT row rather than the first. The
 * handle is denormalized into each audit row as of that disclosure, so a peer
 * who renamed has several; showing the newest is the one an owner will
 * recognize, and the older ones remain visible on the individual rows.
 *
 * Rows are NOT required to arrive sorted. Sorting is the caller's business and
 * relying on it here would make the totals depend on the SQL `ORDER BY`.
 */
export function summarizeDisclosures(
  rows: readonly AskAudit[],
  options: { now?: Date; windowMs?: number } = {},
): DisclosureSummary[] {
  const now = (options.now ?? new Date()).getTime();
  const windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
  const cutoff = now - windowMs;

  const byKey = new Map<string, DisclosureSummary>();

  for (const row of rows) {
    const counterparty = counterpartyOf(row);
    const at = row.createdAt.getTime();
    const inWindow = at >= cutoff && at <= now;
    const disclosed = row.disclosedCount ?? 0;

    const existing = byKey.get(counterparty.key);

    if (existing == null) {
      byKey.set(counterparty.key, {
        counterparty,
        total: 1,
        autoAnswered: countFor(row.outcome, 'auto_answered'),
        reviewed: countFor(row.outcome, 'answered'),
        declined: countFor(row.outcome, 'declined'),
        expired: countFor(row.outcome, 'expired'),
        itemsDisclosed: disclosed,
        asksInWindow: inWindow ? 1 : 0,
        itemsInWindow: inWindow ? disclosed : 0,
        firstAt: row.createdAt,
        lastAt: row.createdAt,
      });

      continue;
    }

    existing.total += 1;
    existing.autoAnswered += countFor(row.outcome, 'auto_answered');
    existing.reviewed += countFor(row.outcome, 'answered');
    existing.declined += countFor(row.outcome, 'declined');
    existing.expired += countFor(row.outcome, 'expired');
    existing.itemsDisclosed += disclosed;
    existing.asksInWindow += inWindow ? 1 : 0;
    existing.itemsInWindow += inWindow ? disclosed : 0;

    if (row.createdAt < existing.firstAt) {
      existing.firstAt = row.createdAt;
    }

    if (row.createdAt > existing.lastAt) {
      existing.lastAt = row.createdAt;
      // Newest handle wins; see the note above on renames.
      existing.counterparty.peerHandle = counterparty.peerHandle;
    }
  }

  // MOST RECENTLY ACTIVE FIRST, then by total, then by key.
  //
  // Recency first because the surface answers "what is happening", and a
  // relationship that has been quiet for a year is not what an owner opened
  // this to find. The two further tiebreaks make the order a pure function of
  // the rows: without them, two counterparties whose last disclosure shares a
  // timestamp would order by Map insertion, i.e. by whatever the SQL returned.
  return [...byKey.values()].sort(
    (a, b) =>
      b.lastAt.getTime() - a.lastAt.getTime() ||
      b.total - a.total ||
      a.counterparty.key.localeCompare(b.counterparty.key),
  );
}

/** Thirty days. A month is the unit people reason about consent in. */
export const DEFAULT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * The counterparty a row names.
 *
 * A LOCAL ASKER WINS OVER A PEER LINK when a row somehow carries both. They are
 * meant to be mutually exclusive; if one ever is not, grouping by the local id
 * keeps the disclosure attached to an account the owner can actually act on,
 * rather than to a link that may already be revoked.
 */
export function counterpartyOf(row: AskAudit): DisclosureCounterparty {
  if (row.askerUserId != null) {
    return {
      key: `user:${row.askerUserId}`,
      askerUserId: row.askerUserId,
      peerLinkId: null,
      // A local asker has no handle. Carrying the row's `peerHandle` here would
      // label a household member with a peer's name.
      peerHandle: null,
    };
  }

  if (row.peerLinkId != null) {
    return {
      key: `peer:${row.peerLinkId}`,
      askerUserId: null,
      peerLinkId: row.peerLinkId,
      peerHandle: row.peerHandle,
    };
  }

  return { key: UNATTRIBUTED, askerUserId: null, peerLinkId: null, peerHandle: null };
}

function countFor(outcome: AskAuditOutcome, match: AskAuditOutcome): number {
  return outcome === match ? 1 : 0;
}

/**
 * How much of a relationship's disclosure is recent — 0…1, or null when there
 * is nothing to compare against.
 *
 * Deliberately a RATIO and not a verdict. There is no enforced disclosure
 * budget yet (CI-Server #2364), and inventing a threshold here would put a
 * number on the screen that nothing behind it enforces — the same "protection
 * that is not there" the ask domain has been burned by before. What this
 * supports is the honest statement: *"most of what Ana has ever received, she
 * received this month."*
 *
 * Null rather than 0 when nothing was ever disclosed, so a caller cannot render
 * "0% recent" for a relationship that has disclosed nothing at all.
 */
export function recentShare(summary: DisclosureSummary): number | null {
  if (summary.itemsDisclosed <= 0) {
    return null;
  }

  return summary.itemsInWindow / summary.itemsDisclosed;
}
