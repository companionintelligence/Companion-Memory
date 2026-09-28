import { describe, expect, it } from 'vitest';

import { describePendingChange, formatSlot } from './pendingRationale';

const LA = 'America/Los_Angeles';
const NY = 'America/New_York';
const SYDNEY = 'Australia/Sydney';
const NOW = new Date('2026-09-27T12:00:00.000Z');
const START = '2026-09-28T16:00:00.000Z';
const ISO_INSTANT = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

// ICU puts a narrow no-break space before AM/PM; `\s` matches it, so these
// patterns hold on either side of that ICU change.
describe('formatSlot', () => {
  it('reads the instant on the given zone’s clock', () => {
    const start = new Date(START);

    expect(formatSlot(start, 'UTC', NOW, 'en-US')).toMatch(/^Mon, Sep 28 at 4:00\sPM$/);
    expect(formatSlot(start, NY, NOW, 'en-US')).toMatch(/^Mon, Sep 28 at 12:00\sPM$/);
    expect(formatSlot(start, LA, NOW, 'en-US')).toMatch(/^Mon, Sep 28 at 9:00\sAM$/);
  });

  it('names the zone-local day across midnight', () => {
    const start = new Date('2026-09-29T02:30:00.000Z');

    expect(formatSlot(start, LA, NOW, 'en-US')).toMatch(/^Mon, Sep 28 at 7:30\sPM$/);
    expect(formatSlot(start, SYDNEY, NOW, 'en-US')).toMatch(/^Tue, Sep 29 at 12:30\sPM$/);
  });

  it('adds the year only when it is not this year in that zone', () => {
    const start = new Date('2027-01-04T17:00:00.000Z');

    expect(formatSlot(start, LA, new Date('2026-12-30T12:00:00.000Z'), 'en-US')).toMatch(
      /^Mon, Jan 4, 2027 at 9:00\sAM$/,
    );
    expect(formatSlot(start, LA, new Date('2027-01-02T12:00:00.000Z'), 'en-US')).toMatch(
      /^Mon, Jan 4 at 9:00\sAM$/,
    );
  });
});

describe('describePendingChange', () => {
  // The exact row the Plan card used to print verbatim.
  const legacy = {
    kind: 'schedule',
    rationale: `Place on the calendar at ${START}?`,
    startTime: START,
  };

  it('words a schedule suggestion from its start instant, in the owner’s zone', () => {
    const text = describePendingChange(legacy, LA, NOW, 'en-US');

    expect(text).toMatch(/^Place on the calendar on Mon, Sep 28 at 9:00\sAM\?$/);
    expect(text).not.toMatch(ISO_INSTANT);
  });

  it('follows the zone it is given, not the one the row was filed in', () => {
    expect(describePendingChange(legacy, NY, NOW, 'en-US')).toMatch(/at 12:00\sPM\?$/);
  });

  it('reads a row the server already worded the same way', () => {
    const current = { ...legacy, rationale: 'Place on the calendar on Mon, Sep 28 at 9:00 AM?' };

    expect(describePendingChange(current, LA, NOW, 'en-US')).toMatch(
      /^Place on the calendar on Mon, Sep 28 at 9:00\sAM\?$/,
    );
  });

  it('never shows a raw ISO instant even when the patch carries no start', () => {
    const text = describePendingChange({ ...legacy, startTime: null }, LA, NOW, 'en-US');

    expect(text).not.toMatch(ISO_INSTANT);
    // "on", not "at Mon, Sep 28 at 9:00 AM": the legacy "at " goes with the instant.
    expect(text).toMatch(/^Place on the calendar on Mon, Sep 28 at 9:00\sAM\?$/);
  });

  it('puts every instant in free text on the owner’s clock, keeping the words around it', () => {
    expect(
      describePendingChange(
        { kind: 'mutate', rationale: 'Moved from 2026-09-28T16:00:00Z after a conflict.' },
        NY,
        NOW,
        'en-US',
      ),
    ).toMatch(/^Moved from Mon, Sep 28 at 12:00\sPM after a conflict\.$/);
  });

  it('ignores a start instant it cannot parse', () => {
    const text = describePendingChange({ ...legacy, startTime: 'not a time' }, LA, NOW, 'en-US');

    expect(text).toMatch(/Mon, Sep 28 at 9:00\sAM/);
  });

  it('keeps any other change’s own sentence', () => {
    expect(
      describePendingChange(
        { kind: 'complete', rationale: 'Looks like this may be done.' },
        LA,
        NOW,
        'en-US',
      ),
    ).toBe('Looks like this may be done.');
  });

  it('leaves a bare calendar date alone — it has no clock to put it on', () => {
    expect(
      describePendingChange(
        { kind: 'mutate', rationale: 'Move the due date to 2026-10-02?' },
        LA,
        NOW,
        'en-US',
      ),
    ).toBe('Move the due date to 2026-10-02?');
  });

  it('shows nothing when there is nothing to say', () => {
    expect(describePendingChange({ kind: 'complete', rationale: null }, LA, NOW, 'en-US')).toBeNull();
  });
});
