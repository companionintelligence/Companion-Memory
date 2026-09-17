/**
 * The grid's clock, pinned against a browser that disagrees with the profile.
 *
 * Every case here runs with `process.env.TZ` set to a zone that is NOT the one
 * being asked about — that separation is the whole point of the module, and a
 * test that let the two coincide would pass just as happily against the
 * `getHours()` arithmetic this replaced.
 */

import { describe, expect, it } from 'vitest';

import {
  instantAtDayMinutes,
  resolveTimeZone,
  zonedAddDays,
  zonedDayKey,
  zonedDayOfMonth,
  zonedMinutesOfDay,
  zonedSameDay,
  zonedStartOfDay,
  zonedWallTimeToInstant,
} from './zonedClock';

const SYSTEM_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Same contract as `scheduleGeometry.test.ts` — restore by assignment, never by delete. */
function withTimeZone<T>(timeZone: string, fn: () => T): T {
  const previous = process.env.TZ;
  process.env.TZ = timeZone;

  try {
    return fn();
  } finally {
    process.env.TZ = previous ?? SYSTEM_TIME_ZONE;
  }
}

describe('zonedClock — reading an instant in a zone the browser is not in', () => {
  it('reads the day and minute a block was placed at, not the browser’s', () => {
    withTimeZone('UTC', () => {
      // 09:00 in New York is 13:00 UTC. A UTC browser drew this at 13:00.
      const placed = new Date('2026-08-03T13:00:00Z');

      expect(zonedMinutesOfDay(placed, 'America/New_York')).toBe(9 * 60);
      expect(zonedDayKey(placed, 'America/New_York')).toBe('2026-08-03');
    });
  });

  it('puts a late-evening instant on the profile day, not the UTC one', () => {
    withTimeZone('UTC', () => {
      // 22:00 Monday in New York is already Tuesday 02:00 UTC.
      const placed = new Date('2026-08-04T02:00:00Z');

      expect(zonedDayKey(placed, 'America/New_York')).toBe('2026-08-03');
      expect(zonedDayOfMonth(placed, 'America/New_York')).toBe(3);
      expect(zonedMinutesOfDay(placed, 'America/New_York')).toBe(22 * 60);
    });
  });

  it('honours a zone whose offset is not a whole number of hours', () => {
    withTimeZone('UTC', () => {
      const placed = new Date('2026-08-03T03:30:00Z');

      expect(zonedMinutesOfDay(placed, 'Asia/Kolkata')).toBe(9 * 60);
    });
  });

  it('agrees with two instants on the same profile day even across UTC midnight', () => {
    withTimeZone('UTC', () => {
      const evening = new Date('2026-08-04T02:00:00Z');
      const morning = new Date('2026-08-03T13:00:00Z');

      expect(zonedSameDay(morning, evening, 'America/New_York')).toBe(true);
      expect(zonedSameDay(morning, evening, 'UTC')).toBe(false);
    });
  });
});

describe('zonedClock — writing a wall time back to an instant', () => {
  it('books 09:00 in the profile zone whatever the browser is set to', () => {
    withTimeZone('Asia/Tokyo', () => {
      const at = zonedWallTimeToInstant(2026, 8, 3, 9, 0, 0, 'America/New_York');

      expect(at.toISOString()).toBe('2026-08-03T13:00:00.000Z');
    });
  });

  it('resolves midnight of a profile day, not of the browser day', () => {
    withTimeZone('UTC', () => {
      const at = zonedStartOfDay(new Date('2026-08-04T02:00:00Z'), 'America/New_York');

      expect(at.toISOString()).toBe('2026-08-03T04:00:00.000Z');
    });
  });

  it('places a drop by wall clock on a 23-hour day rather than by elapsed time', () => {
    withTimeZone('UTC', () => {
      // New York springs forward on Sun 08 Mar 2026: 05:00Z is local midnight,
      // and noon is 11 hours later, not 12.
      const dayStart = zonedStartOfDay(new Date('2026-03-08T12:00:00Z'), 'America/New_York');
      const noon = instantAtDayMinutes(dayStart, 12 * 60, 'America/New_York');

      expect(dayStart.toISOString()).toBe('2026-03-08T05:00:00.000Z');
      expect(zonedMinutesOfDay(noon, 'America/New_York')).toBe(12 * 60);
      expect(noon.getTime() - dayStart.getTime()).toBe(11 * 60 * 60_000);
    });
  });

  it('walks to the next calendar day across a 25-hour one', () => {
    withTimeZone('UTC', () => {
      // New York falls back on Sun 01 Nov 2026.
      const fallBack = zonedStartOfDay(new Date('2026-11-01T12:00:00Z'), 'America/New_York');
      const next = zonedAddDays(fallBack, 1, 'America/New_York');

      expect(zonedDayKey(next, 'America/New_York')).toBe('2026-11-02');
      expect(zonedMinutesOfDay(next, 'America/New_York')).toBe(0);
      expect(next.getTime() - fallBack.getTime()).toBe(25 * 60 * 60_000);
    });
  });

  it('crosses a month boundary rather than minting a 32nd', () => {
    withTimeZone('UTC', () => {
      const at = zonedAddDays(new Date('2026-08-31T13:00:00Z'), 1, 'America/New_York');

      expect(zonedDayKey(at, 'America/New_York')).toBe('2026-09-01');
    });
  });
});

describe('resolveTimeZone — which clock the surface draws on', () => {
  it('prefers the profile zone', () => {
    withTimeZone('UTC', () => {
      expect(resolveTimeZone('America/New_York')).toBe('America/New_York');
    });
  });

  it('falls back to the browser zone when the profile has none', () => {
    withTimeZone('America/New_York', () => {
      expect(resolveTimeZone(null)).toBe('America/New_York');
      expect(resolveTimeZone(undefined)).toBe('America/New_York');
    });
  });

  it('falls back rather than throwing on a zone Intl does not know', () => {
    withTimeZone('America/New_York', () => {
      expect(resolveTimeZone('Mars/Olympus_Mons')).toBe('America/New_York');
    });
  });
});
