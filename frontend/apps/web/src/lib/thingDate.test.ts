import { afterEach, describe, expect, it } from 'vitest';

import { formatThingDate, fromThingDateInput, thingDate, toThingDateInput } from './thingDate';

/**
 * A stored Thing date is a day kept as an instant. A picked day (and an
 * importer's date-only value) is UTC midnight, which is the day before in every
 * zone west of UTC when read as a moment. So every case runs in a named zone: CI
 * is UTC, where a local day is a UTC day and the bug cannot show.
 */
const ZONES = [
  'UTC',
  'Pacific/Honolulu', // UTC-10
  'America/Los_Angeles', // UTC-7/-8
  'Europe/London', // UTC+0/+1
  'Asia/Tokyo', // UTC+9
  'Pacific/Kiritimati', // UTC+14
];

const ORIGINAL_TZ = process.env.TZ;
const SYSTEM_TIME_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

afterEach(() => {
  // Restore by assignment: deleting TZ leaves Node on the last zone set.
  process.env.TZ = ORIGINAL_TZ ?? SYSTEM_TIME_ZONE;
});

describe.each(ZONES)('thing dates in %s', (zone) => {
  it('reads a UTC-midnight value as the day it names', () => {
    process.env.TZ = zone;

    expect(toThingDateInput('2024-03-02T00:00:00.000Z')).toBe('2024-03-02');
    expect(toThingDateInput('2024-03-02T00:00:00Z')).toBe('2024-03-02');
    expect(toThingDateInput(new Date('2024-03-02T00:00:00.000Z'))).toBe('2024-03-02');
    expect(formatThingDate('2024-03-02T00:00:00.000Z')).toBe(new Date(2024, 2, 2).toLocaleDateString());
  });

  it('stores a picked day as UTC midnight and reads it back as that day', () => {
    process.env.TZ = zone;

    for (const picked of ['2026-10-01', '2026-01-01', '2026-12-31', '2026-03-08', '2024-02-29']) {
      const stored = fromThingDateInput(picked);
      const [year, month, day] = picked.split('-').map(Number);

      expect(stored).toBe(`${picked}T00:00:00.000Z`);
      expect(toThingDateInput(stored)).toBe(picked);
      expect(formatThingDate(stored)).toBe(new Date(year, month - 1, day).toLocaleDateString());
    }
  });

  it('reads the start of a local day, as the form wrote it for a while, as that day', () => {
    process.env.TZ = zone;

    for (const [year, month, day] of [
      [2026, 9, 1],
      [2026, 0, 1],
      [2026, 11, 31],
      [2026, 2, 8], // a US spring-forward day
    ] as const) {
      const stored = new Date(year, month, day).toISOString();
      const expected = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

      expect(toThingDateInput(stored)).toBe(expected);
      expect(formatThingDate(stored)).toBe(new Date(year, month, day).toLocaleDateString());
    }
  });

  it('keeps showing a real timestamp on the viewer’s own day', () => {
    process.env.TZ = zone;

    // An importer's order time, not a midnight.
    const stored = '2026-10-01T03:00:00.000Z';
    const local = new Date(stored);
    const expected = `${local.getFullYear()}-${String(local.getMonth() + 1).padStart(2, '0')}-${String(local.getDate()).padStart(2, '0')}`;

    expect(toThingDateInput(stored)).toBe(expected);
    expect(formatThingDate(stored)).toBe(local.toLocaleDateString());
  });
});

describe('a date input with nothing to store', () => {
  it.each(['', '   '])('stores nothing for %j', (value) => {
    expect(fromThingDateInput(value)).toBeNull();
  });

  // Thrown, not null: null would clear the date already stored.
  it.each(['not a date', '2026-02-30', '2026-13-01'])('refuses %j', (value) => {
    expect(() => fromThingDateInput(value)).toThrow(RangeError);
  });

  // Date.UTC reads years 0 to 99 as 1900 to 1999; a date input can still send one.
  it('stores a day in the first century as that day', () => {
    expect(fromThingDateInput('0099-05-04')).toBe('0099-05-04T00:00:00.000Z');
  });
});

describe('thing dates with nothing to show', () => {
  it.each([null, undefined, '', 'not a date'])('gives nothing for %s', (value) => {
    expect(thingDate(value)).toBeNull();
    expect(formatThingDate(value)).toBeNull();
    expect(toThingDateInput(value)).toBe('');
  });
});
