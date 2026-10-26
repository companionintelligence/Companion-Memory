import { afterEach, describe, expect, it } from 'vitest';

import { formatThingDate, thingDate, toThingDateInput } from './thingDate';

/**
 * A stored Thing date is a day kept as an instant. Rows from before the app wrote
 * "the start of the picked day where the person is" (and an importer's date-only
 * values) are UTC midnight, which is the day before in every zone west of UTC. So
 * every case runs in a named zone: CI is UTC, where a local day is a UTC day and
 * the bug cannot show.
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

  it('reads the start of a local day, as the form now writes it, as that day', () => {
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

describe('thing dates with nothing to show', () => {
  it.each([null, undefined, '', 'not a date'])('gives nothing for %s', (value) => {
    expect(thingDate(value)).toBeNull();
    expect(formatThingDate(value)).toBeNull();
    expect(toThingDateInput(value)).toBe('');
  });
});
