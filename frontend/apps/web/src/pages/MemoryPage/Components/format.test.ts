import { describe, expect, it } from 'vitest';

import { createDateTimeFormatter, DEVICE_DATE_TIME_FORMATTER } from '@/lib/dateTimeFormat';

import { formatBytes, formatDateTime, formatDuration, formatEventTimeRange, formatRowTime } from './utils';

// Date formatters are tested with local-time inputs (no trailing Z) so the
// rendered value matches the literal regardless of the runner's timezone —
// which is also why the formatters here name no zone: they read the runner's.
const AUTO = DEVICE_DATE_TIME_FORMATTER;
const H23 = createDateTimeFormatter({ timeFormat: 'h23' });

describe('formatDuration', () => {
  it('returns an empty string for zero', () => {
    expect(formatDuration(0)).toBe('');
  });

  it('formats minutes, hours and days with pluralisation', () => {
    expect(formatDuration(1)).toBe('1 minute');
    expect(formatDuration(2)).toBe('2 minutes');
    expect(formatDuration(90)).toBe('1 hour, 30 minutes');
    expect(formatDuration(1500)).toBe('1 day, 1 hour');
  });
});

describe('formatBytes', () => {
  it('returns "0 Bytes" for zero', () => {
    expect(formatBytes(0)).toBe('0 Bytes');
  });

  it('scales to binary units', () => {
    expect(formatBytes(1024)).toBe('1 KiB');
    expect(formatBytes(1536)).toBe('1.5 KiB');
    expect(formatBytes(1048576)).toBe('1 MiB');
  });

  it('accepts a numeric string and a decimals override', () => {
    expect(formatBytes('2048')).toBe('2 KiB');
    expect(formatBytes(1234, 0)).toBe('1 KiB');
  });
});

describe('formatEventTimeRange', () => {
  it('returns empty for an invalid start', () => {
    expect(formatEventTimeRange('', null, AUTO)).toBe('');
  });

  it('shows a single time when there is no end', () => {
    expect(formatEventTimeRange('2026-01-15T08:00:00', null, AUTO)).toBe('8 AM');
    expect(formatEventTimeRange('2026-01-15T08:30:00', null, AUTO)).toBe('8:30 AM');
  });

  it('shows a same-day range', () => {
    expect(formatEventTimeRange('2026-01-15T08:00:00', '2026-01-15T17:00:00', AUTO)).toMatch(
      /^8 AM\s*[–-]\s*5 PM$/,
    );
  });

  it('includes short dates for a multi-day range', () => {
    expect(formatEventTimeRange('2026-01-15T08:00:00', '2026-01-16T09:00:00', AUTO)).toMatch(
      /^Jan 15, 8 AM\s*[–-]\s*Jan 16, 9 AM$/,
    );
  });

  it('falls back to the start time when the end is invalid', () => {
    expect(formatEventTimeRange('2026-01-15T08:00:00', 'nope', AUTO)).toBe('8 AM');
  });

  it('writes the times in a forced hour cycle', () => {
    expect(formatEventTimeRange('2026-01-15T08:30:00', null, H23)).toBe('08:30');
    // On the hour it keeps its minutes: a bare "08" does not read as a time.
    expect(formatEventTimeRange('2026-01-15T08:00:00', '2026-01-15T17:00:00', H23)).toMatch(
      /^08:00\s*[–-]\s*17:00$/,
    );
    expect(formatEventTimeRange('2026-01-15T08:00:00', '2026-01-16T21:15:00', H23)).toMatch(
      /^Jan 15, 08:00\s*[–-]\s*Jan 16, 21:15$/,
    );
    const h12 = createDateTimeFormatter({ timeFormat: 'h12' });
    expect(formatEventTimeRange('2026-01-15T08:00:00', '2026-01-15T17:30:00', h12)).toMatch(
      /^8 AM\s*[–-]\s*5:30 PM$/,
    );
  });
});

describe('formatRowTime', () => {
  const now = new Date(2026, 0, 15, 9, 0);

  it('returns empty for null', () => {
    expect(formatRowTime(null, AUTO, now)).toBe('');
  });

  it('shows the time of day for today', () => {
    expect(formatRowTime(new Date(2026, 0, 15, 14, 30), AUTO, now)).toBe('2:30 PM');
  });

  it('shows the time of day for today in a forced hour cycle', () => {
    expect(formatRowTime(new Date(2026, 0, 15, 14, 30), H23, now)).toBe('14:30');
  });

  it('shows a short date within the same year', () => {
    expect(formatRowTime(new Date(2026, 2, 3), AUTO, now)).toBe('Mar 3');
  });

  it('includes the year for other years', () => {
    expect(formatRowTime(new Date(2025, 11, 20), AUTO, now)).toBe('Dec 20, 2025');
  });
});

describe('formatDateTime', () => {
  it('returns the raw string when it is not a date', () => {
    expect(formatDateTime('not-a-date')).toBe('not-a-date');
  });

  it('formats a valid date without a time', () => {
    expect(formatDateTime('2026-01-15T12:00:00')).toBe('Jan 15, 2026');
  });
});
