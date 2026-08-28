import {
  counterpartyOf,
  DEFAULT_WINDOW_MS,
  recentShare,
  summarizeDisclosures,
  UNATTRIBUTED,
} from './disclosureSummary';
import type { AskAudit } from './entities/AskAuditEntity';
import type { AskAuditOutcome } from './types';

const NOW = new Date('2026-08-26T12:00:00.000Z');

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000);
}

let seq = 0;

function row(overrides: Partial<AskAudit> = {}): AskAudit {
  seq += 1;

  return {
    id: `audit-${seq}`,
    askId: null,
    askerUserId: null,
    peerLinkId: null,
    peerHandle: null,
    responderUserId: 'owner-1',
    query: { queryType: 'content', prompt: 'anything' },
    consentBasis: null,
    outcome: 'answered' as AskAuditOutcome,
    disclosedEntities: [],
    disclosedCount: 0,
    withheldCount: 0,
    backingEntities: [],
    createdAt: daysAgo(1),
    ...overrides,
  } as unknown as AskAudit;
}

describe('counterpartyOf', () => {
  it('keys a local asker by user id, with no handle', () => {
    // Carrying a peerHandle here would label a household member with a peer's
    // name, which is a claim about who received a disclosure.
    const c = counterpartyOf(row({ askerUserId: 'sam', peerHandle: 'ana' }));

    expect(c).toEqual({ key: 'user:sam', askerUserId: 'sam', peerLinkId: null, peerHandle: null });
  });

  it('keys a peer by link id and carries the handle', () => {
    const c = counterpartyOf(row({ peerLinkId: 'link-9', peerHandle: 'ana' }));

    expect(c).toEqual({ key: 'peer:link-9', askerUserId: null, peerLinkId: 'link-9', peerHandle: 'ana' });
  });

  /**
   * They are meant to be mutually exclusive. If one ever is not, grouping by
   * the LOCAL id keeps the disclosure attached to an account the owner can act
   * on rather than to a link that may already be revoked.
   */
  it('prefers the local asker when a row somehow carries both', () => {
    expect(counterpartyOf(row({ askerUserId: 'sam', peerLinkId: 'link-9' })).key).toBe('user:sam');
  });

  it('buckets a row naming neither under a distinct unattributed key', () => {
    expect(counterpartyOf(row()).key).toBe(UNATTRIBUTED);
  });
});

describe('summarizeDisclosures', () => {
  it('returns nothing for no rows', () => {
    expect(summarizeDisclosures([], { now: NOW })).toEqual([]);
  });

  it('groups by counterparty and never merges two of them', () => {
    const summaries = summarizeDisclosures(
      [
        row({ askerUserId: 'sam' }),
        row({ askerUserId: 'sam' }),
        row({ peerLinkId: 'link-9', peerHandle: 'ana' }),
      ],
      { now: NOW },
    );

    expect(summaries).toHaveLength(2);
    expect(summaries.map((s) => s.counterparty.key).sort()).toEqual(['peer:link-9', 'user:sam']);
    expect(summaries.find((s) => s.counterparty.key === 'user:sam')?.total).toBe(2);
  });

  /**
   * The one error this surface must never make: attributing an unattributable
   * disclosure to a specific person, whom the owner may then revoke.
   */
  it('keeps unattributed rows out of every real counterparty', () => {
    const summaries = summarizeDisclosures([row({ askerUserId: 'sam' }), row(), row()], { now: NOW });

    expect(summaries.find((s) => s.counterparty.key === 'user:sam')?.total).toBe(1);
    expect(summaries.find((s) => s.counterparty.key === UNATTRIBUTED)?.total).toBe(2);
  });

  it('splits outcomes, because auto-answered is the one worth noticing', () => {
    const summaries = summarizeDisclosures(
      [
        row({ askerUserId: 'sam', outcome: 'auto_answered' }),
        row({ askerUserId: 'sam', outcome: 'auto_answered' }),
        row({ askerUserId: 'sam', outcome: 'answered' }),
        row({ askerUserId: 'sam', outcome: 'declined' }),
        row({ askerUserId: 'sam', outcome: 'expired' }),
      ],
      { now: NOW },
    );

    expect(summaries[0]).toMatchObject({
      total: 5,
      autoAnswered: 2,
      reviewed: 1,
      declined: 1,
      expired: 1,
    });
  });

  it('sums the MAGNITUDE disclosed, not the number of asks', () => {
    const summaries = summarizeDisclosures(
      [
        row({ askerUserId: 'sam', disclosedCount: 12 }),
        row({ askerUserId: 'sam', disclosedCount: 5 }),
        row({ askerUserId: 'sam', disclosedCount: 0, outcome: 'declined' }),
      ],
      { now: NOW },
    );

    expect(summaries[0].itemsDisclosed).toBe(17);
    expect(summaries[0].total).toBe(3);
  });

  describe('the recency window', () => {
    it('counts only rows inside it', () => {
      const summaries = summarizeDisclosures(
        [
          row({ askerUserId: 'sam', disclosedCount: 3, createdAt: daysAgo(1) }),
          row({ askerUserId: 'sam', disclosedCount: 4, createdAt: daysAgo(90) }),
        ],
        { now: NOW },
      );

      expect(summaries[0].itemsDisclosed).toBe(7);
      expect(summaries[0].itemsInWindow).toBe(3);
      expect(summaries[0].asksInWindow).toBe(1);
    });

    /**
     * Half-open at the bottom, INCLUSIVE on the boundary. Rows written in one
     * transaction share a timestamp to the microsecond, so an exclusive bound
     * loses whole batches rather than edge cases.
     */
    it('includes a row stamped exactly on the boundary', () => {
      const onBoundary = new Date(NOW.getTime() - DEFAULT_WINDOW_MS);
      const summaries = summarizeDisclosures(
        [row({ askerUserId: 'sam', disclosedCount: 2, createdAt: onBoundary })],
        { now: NOW },
      );

      expect(summaries[0].asksInWindow).toBe(1);
    });

    it('excludes a row one millisecond older than the boundary', () => {
      const justOutside = new Date(NOW.getTime() - DEFAULT_WINDOW_MS - 1);
      const summaries = summarizeDisclosures(
        [row({ askerUserId: 'sam', disclosedCount: 2, createdAt: justOutside })],
        { now: NOW },
      );

      expect(summaries[0].asksInWindow).toBe(0);
    });

    it('honours a caller-supplied window', () => {
      const summaries = summarizeDisclosures(
        [
          row({ askerUserId: 'sam', createdAt: daysAgo(3) }),
          row({ askerUserId: 'sam', createdAt: daysAgo(10) }),
        ],
        { now: NOW, windowMs: 7 * 24 * 60 * 60 * 1000 },
      );

      expect(summaries[0].asksInWindow).toBe(1);
    });
  });

  describe('first and last', () => {
    it('finds the extremes regardless of input order', () => {
      // Sorting is the caller's business; relying on it here would make the
      // totals depend on the SQL ORDER BY.
      const summaries = summarizeDisclosures(
        [
          row({ askerUserId: 'sam', createdAt: daysAgo(5) }),
          row({ askerUserId: 'sam', createdAt: daysAgo(50) }),
          row({ askerUserId: 'sam', createdAt: daysAgo(20) }),
        ],
        { now: NOW },
      );

      expect(summaries[0].firstAt).toEqual(daysAgo(50));
      expect(summaries[0].lastAt).toEqual(daysAgo(5));
    });

    it('shows the peer handle from the MOST RECENT row, so a rename reads correctly', () => {
      const summaries = summarizeDisclosures(
        [
          row({ peerLinkId: 'link-9', peerHandle: 'ana-old', createdAt: daysAgo(40) }),
          row({ peerLinkId: 'link-9', peerHandle: 'ana-new', createdAt: daysAgo(2) }),
        ],
        { now: NOW },
      );

      expect(summaries[0].counterparty.peerHandle).toBe('ana-new');
    });
  });

  describe('ordering', () => {
    it('puts the most recently active relationship first', () => {
      const summaries = summarizeDisclosures(
        [
          row({ askerUserId: 'quiet', createdAt: daysAgo(200) }),
          row({ askerUserId: 'busy', createdAt: daysAgo(1) }),
        ],
        { now: NOW },
      );

      expect(summaries.map((s) => s.counterparty.askerUserId)).toEqual(['busy', 'quiet']);
    });

    /**
     * Without the tiebreaks the order falls back to Map insertion — i.e. to
     * whatever the SQL happened to return, which is the `strictestOf` heap-order
     * defect in a different costume.
     */
    it('is a pure function of the rows when timestamps tie', () => {
      const sameMoment = daysAgo(3);
      const rows = [
        row({ askerUserId: 'bbb', createdAt: sameMoment }),
        row({ askerUserId: 'aaa', createdAt: sameMoment }),
      ];

      const forwards = summarizeDisclosures(rows, { now: NOW }).map((s) => s.counterparty.key);
      const backwards = summarizeDisclosures([...rows].reverse(), { now: NOW }).map(
        (s) => s.counterparty.key,
      );

      expect(forwards).toEqual(backwards);
      expect(forwards).toEqual(['user:aaa', 'user:bbb']);
    });

    it('breaks a recency tie by volume before falling back to the key', () => {
      const sameMoment = daysAgo(3);
      const summaries = summarizeDisclosures(
        [
          row({ askerUserId: 'zzz', createdAt: sameMoment }),
          row({ askerUserId: 'zzz', createdAt: daysAgo(4) }),
          row({ askerUserId: 'aaa', createdAt: sameMoment }),
        ],
        { now: NOW },
      );

      expect(summaries[0].counterparty.askerUserId).toBe('zzz');
    });
  });

  it('does not mutate the rows it was given', () => {
    const original = row({ askerUserId: 'sam', disclosedCount: 3 });
    const snapshot = { ...original };
    summarizeDisclosures([original], { now: NOW });

    expect(original).toEqual(snapshot);
  });
});

describe('recentShare', () => {
  function summaryWith(itemsDisclosed: number, itemsInWindow: number) {
    return summarizeDisclosures(
      [
        row({ askerUserId: 'sam', disclosedCount: itemsInWindow, createdAt: daysAgo(1) }),
        row({
          askerUserId: 'sam',
          disclosedCount: itemsDisclosed - itemsInWindow,
          createdAt: daysAgo(120),
        }),
      ],
      { now: NOW },
    )[0];
  }

  it('is the window share of everything ever disclosed', () => {
    expect(recentShare(summaryWith(100, 75))).toBeCloseTo(0.75);
  });

  /**
   * Null rather than 0, so a caller cannot render "0% recent" for a
   * relationship that has disclosed nothing at all — a different statement.
   */
  it('is null when nothing was ever disclosed', () => {
    expect(recentShare(summaryWith(0, 0))).toBeNull();
  });
});
