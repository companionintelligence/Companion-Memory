import { describe, expect, it } from 'vitest';

import {
  accelerationNote,
  activityLine,
  isUnattributed,
  lastActiveLine,
  magnitudeLine,
  relationshipLabel,
  truncationNote,
  UNATTRIBUTED_KEY,
  type RelationshipSummary,
} from './relationshipPresentation';

const NOW = new Date('2026-08-26T12:00:00.000Z');

function iso(daysAgo: number): string {
  return new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString();
}

function summary(overrides: Partial<RelationshipSummary> = {}): RelationshipSummary {
  return {
    key: 'peer:link-9',
    askerId: null,
    peerLinkId: 'link-9',
    peerHandle: 'ana',
    total: 10,
    autoAnswered: 7,
    reviewed: 2,
    declined: 1,
    expired: 0,
    itemsDisclosed: 213,
    asksInWindow: 4,
    itemsInWindow: 46,
    firstAt: iso(200),
    lastAt: iso(2),
    ...overrides,
  };
}

describe('relationshipLabel', () => {
  it('uses a peer handle when there is one', () => {
    expect(relationshipLabel(summary())).toBe('ana');
  });

  /**
   * A local asker has only an opaque id on this wire. Dressing it up as a name
   * would be a confident, wrong claim about who received a disclosure — and the
   * owner may act on it by revoking the wrong person.
   */
  it('never invents a name for a local asker', () => {
    const label = relationshipLabel(
      summary({ key: 'user:abc123def456', askerId: 'abc123def456', peerLinkId: null, peerHandle: null }),
    );

    expect(label).toContain('Someone on this box');
    expect(label).toContain('123def456'.slice(-6));
  });

  it('degrades without an id rather than rendering an empty suffix', () => {
    expect(
      relationshipLabel(summary({ key: 'user:', askerId: null, peerLinkId: null, peerHandle: null })),
    ).toBe('Someone on this box');
  });

  it('ignores a blank handle rather than rendering whitespace', () => {
    expect(relationshipLabel(summary({ peerHandle: '   ' }))).toContain('Someone on this box');
  });

  /**
   * Not "Unknown person": there may be several, and naming the bucket as a
   * person would imply these all went to one.
   */
  it('labels the unattributed bucket as a bucket, not a person', () => {
    const row = summary({ key: UNATTRIBUTED_KEY, peerHandle: null, peerLinkId: null });

    expect(relationshipLabel(row)).toBe('Unattributed disclosures');
    expect(isUnattributed(row)).toBe(true);
    expect(isUnattributed(summary())).toBe(false);
  });
});

describe('activityLine', () => {
  it('leads with what happened WITHOUT the owner', () => {
    const line = activityLine(summary());

    expect(line.startsWith('7 answered automatically')).toBe(true);
    expect(line).toContain('2 you reviewed');
    expect(line).toContain('1 declined');
  });

  /**
   * The one simplification this line must not make. The two counts differ by
   * whether a human was in the loop, which is the whole question.
   */
  it('never sums auto-answered into reviewed', () => {
    const line = activityLine(summary({ autoAnswered: 7, reviewed: 2 }));

    expect(line).not.toContain('9');
  });

  it('drops zero-valued parts so the non-zero one is readable', () => {
    const line = activityLine(summary({ autoAnswered: 3, reviewed: 0, declined: 0, expired: 0 }));

    expect(line).toBe('3 answered automatically');
  });

  it('says so plainly when there is nothing at all', () => {
    expect(activityLine(summary({ autoAnswered: 0, reviewed: 0, declined: 0, expired: 0 }))).toMatch(
      /No terminal outcomes/,
    );
  });

  it('names expiries, which are neither a disclosure nor a refusal', () => {
    expect(activityLine(summary({ expired: 2 }))).toContain('2 expired unanswered');
  });
});

describe('magnitudeLine', () => {
  it('reports items, not ask count', () => {
    // "14 asks" and "213 items" are different facts; only the second describes
    // what the other person now holds.
    expect(magnitudeLine(summary(), 30)).toBe('213 items shared · 46 in the last 30 days');
  });

  it('singularizes one item', () => {
    expect(magnitudeLine(summary({ itemsDisclosed: 1, itemsInWindow: 1 }), 30)).toBe(
      '1 item shared · 1 in the last 30 days',
    );
  });

  it('says "none" rather than "0" for a quiet window', () => {
    expect(magnitudeLine(summary({ itemsInWindow: 0 }), 30)).toBe(
      '213 items shared · none in the last 30 days',
    );
  });
});

describe('accelerationNote', () => {
  it('is silent when recent activity is a small share', () => {
    expect(accelerationNote(summary({ itemsDisclosed: 200, itemsInWindow: 20 }))).toBeNull();
  });

  it('speaks when most of the relationship happened lately', () => {
    const note = accelerationNote(summary({ itemsDisclosed: 100, itemsInWindow: 80 }));

    expect(note).toContain('80%');
  });

  it('has a distinct wording for the everything case', () => {
    expect(accelerationNote(summary({ itemsDisclosed: 50, itemsInWindow: 50 }))).toMatch(
      /Everything they have ever received/,
    );
  });

  it('is silent when nothing was ever disclosed', () => {
    expect(accelerationNote(summary({ itemsDisclosed: 0, itemsInWindow: 0 }))).toBeNull();
  });

  /**
   * There is no enforced budget behind this yet (#2364), so it must state a
   * fact and never a verdict — a threshold rendered here would be a number with
   * nothing behind it.
   */
  it('never renders a judgement word', () => {
    const note = accelerationNote(summary({ itemsDisclosed: 100, itemsInWindow: 95 })) ?? '';

    expect(note).not.toMatch(/too much|excessive|limit|exceeded|warning|suspicious/i);
  });
});

describe('lastActiveLine', () => {
  it.each([
    [0, 'Last shared today'],
    [1, 'Last shared yesterday'],
    [5, 'Last shared 5 days ago'],
    [60, 'Last shared 2 months ago'],
    [400, 'Last shared 1 year ago'],
  ])('renders %s days ago as %s', (days, expected) => {
    expect(lastActiveLine(iso(days), NOW)).toBe(expected);
  });

  it('singularizes one month', () => {
    expect(lastActiveLine(iso(35), NOW)).toBe('Last shared 1 month ago');
  });

  it('shows a date rather than a negative duration for a future timestamp', () => {
    // A future stamp is a clock problem, not a duration.
    const future = new Date(NOW.getTime() + 86_400_000).toISOString();

    expect(lastActiveLine(future, NOW)).not.toMatch(/ago/);
  });

  it('falls back to the raw value rather than printing Invalid Date', () => {
    expect(lastActiveLine('not a date', NOW)).toBe('not a date');
  });
});

describe('truncationNote', () => {
  it('is silent for a complete read', () => {
    expect(truncationNote(false, 5000)).toBeNull();
  });

  /**
   * The totals beside this note are FLOORS. A completeness surface presenting a
   * floor as a total is the failure the flag exists to prevent.
   */
  it('says the totals are minimums when the read was capped', () => {
    const note = truncationNote(true, 5000) ?? '';

    expect(note).toContain('5,000');
    expect(note).toMatch(/minimums/);
  });
});
