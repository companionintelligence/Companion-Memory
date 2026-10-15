import { describe, expect, it } from 'vitest';

import {
  addLocalMonths,
  calendarWindow,
  formatWindowTitle,
  monthGridDays,
  startOfLocalWeek,
  stepAnchor,
  weekStartsOn,
} from './calendarWindow';
import { zonedDayKey } from './zonedClock';

const LA = 'America/Los_Angeles';
const key = (date: Date) => zonedDayKey(date, LA);
// A Thursday.
const anchor = new Date('2026-10-15T19:00:00.000Z');

describe('weekStartsOn', () => {
  it('reads the locale and falls back to Sunday', () => {
    expect([0, 1, 5, 6]).toContain(weekStartsOn('en-US'));
    expect(weekStartsOn('not a locale')).toBe(0);
  });
});

describe('startOfLocalWeek', () => {
  it('backs up to the chosen first weekday on the zone calendar', () => {
    expect(key(startOfLocalWeek(anchor, LA, 0))).toBe('2026-10-11');
    expect(key(startOfLocalWeek(anchor, LA, 1))).toBe('2026-10-12');
    // A Sunday with Monday-first weeks belongs to the week before.
    expect(key(startOfLocalWeek(new Date('2026-10-11T19:00:00.000Z'), LA, 1))).toBe('2026-10-05');
  });
});

describe('addLocalMonths', () => {
  it('clamps to the shorter month and crosses the year', () => {
    expect(key(addLocalMonths(new Date('2026-01-31T19:00:00.000Z'), 1, LA))).toBe('2026-02-28');
    expect(key(addLocalMonths(new Date('2026-11-15T19:00:00.000Z'), 2, LA))).toBe('2027-01-15');
    expect(key(addLocalMonths(new Date('2026-01-15T19:00:00.000Z'), -1, LA))).toBe('2025-12-15');
  });
});

describe('calendarWindow', () => {
  it('a day is the anchor day', () => {
    const w = calendarWindow('day', anchor, LA);

    expect(key(w.span.start)).toBe('2026-10-15');
    expect(key(w.span.end)).toBe('2026-10-16');
    expect(w.fetch).toEqual(w.span);
  });

  it('a week is the calendar week holding the anchor, not seven days from it', () => {
    const w = calendarWindow('week', anchor, LA, 0);

    expect(key(w.span.start)).toBe('2026-10-11');
    expect(key(w.span.end)).toBe('2026-10-18');
  });

  it('a month grid runs from the week of the 1st to the week of the last day', () => {
    const w = calendarWindow('month', anchor, LA, 0);

    expect(key(w.month!)).toBe('2026-10-01');
    expect(key(w.span.start)).toBe('2026-09-27');
    expect(key(w.span.end)).toBe('2026-11-01');
    expect(w.weeks).toBe(5);
    expect(monthGridDays(w, LA)).toHaveLength(35);
    expect(w.fetch).toEqual(w.span);
  });

  it('a month that needs six rows gets them', () => {
    // May 2026 starts on a Friday and has 31 days: six Sunday-first rows.
    const w = calendarWindow('month', new Date('2026-05-10T19:00:00.000Z'), LA, 0);

    expect(w.weeks).toBe(6);
  });

  it('a year spans the year but fetches only the anchor day', () => {
    const w = calendarWindow('year', anchor, LA);

    expect(key(w.span.start)).toBe('2026-01-01');
    expect(key(w.span.end)).toBe('2027-01-01');
    expect(key(w.fetch.start)).toBe('2026-10-15');
    expect(key(w.fetch.end)).toBe('2026-10-16');
  });
});

describe('stepAnchor', () => {
  it('moves by one unit of the view', () => {
    expect(key(stepAnchor('day', anchor, 1, LA))).toBe('2026-10-16');
    expect(key(stepAnchor('week', anchor, -1, LA))).toBe('2026-10-08');
    expect(key(stepAnchor('month', anchor, 1, LA))).toBe('2026-11-15');
    expect(key(stepAnchor('year', anchor, 1, LA))).toBe('2027-10-15');
  });
});

describe('formatWindowTitle', () => {
  it('names the window at the grain of the view', () => {
    expect(formatWindowTitle('day', calendarWindow('day', anchor, LA), LA)).toMatch(/Oct(ober)? 15, 2026/);
    expect(formatWindowTitle('week', calendarWindow('week', anchor, LA, 0), LA)).toBe(
      'Oct 11 – Oct 17, 2026',
    );
    expect(
      formatWindowTitle('week', calendarWindow('week', new Date('2026-12-30T19:00:00.000Z'), LA, 0), LA),
    ).toBe('Dec 27, 2026 – Jan 2, 2027');
    expect(formatWindowTitle('month', calendarWindow('month', anchor, LA, 0), LA)).toBe('October 2026');
    expect(formatWindowTitle('year', calendarWindow('year', anchor, LA), LA)).toBe('2026');
  });
});
