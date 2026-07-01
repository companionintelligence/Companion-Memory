import { describe, expect, it } from 'vitest';

import { formatBytes, formatDateTime, formatDuration, formatEventTimeRange, formatRowTime } from './utils';

// Date formatters are tested with local-time inputs (no trailing Z) so the
// rendered value matches the literal regardless of the runner's timezone.

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
    expect(formatEventTimeRange('')).toBe('');
  });

  it('shows a single time when there is no end', () => {
    expect(formatEventTimeRange('2026-01-15T08:00:00')).toBe('8 AM');
    expect(formatEventTimeRange('2026-01-15T08:30:00')).toBe('8:30 AM');
  });

  it('shows a same-day range', () => {
    expect(formatEventTimeRange('2026-01-15T08:00:00', '2026-01-15T17:00:00')).toMatch(
      /^8 AM\s*[–-]\s*5 PM$/,
    );
  });

  it('includes short dates for a multi-day range', () => {
    expect(formatEventTimeRange('2026-01-15T08:00:00', '2026-01-16T09:00:00')).toMatch(
      /^Jan 15, 8 AM\s*[–-]\s*Jan 16, 9 AM$/,
    );
  });

  it('falls back to the start time when the end is invalid', () => {
    expect(formatEventTimeRange('2026-01-15T08:00:00', 'nope')).toBe('8 AM');
  });
});

describe('formatRowTime', () => {
  const now = new Date(2026, 0, 15, 9, 0);

  it('returns empty for null', () => {
    expect(formatRowTime(null, now)).toBe('');
  });

  it('shows the time of day for today', () => {
    expect(formatRowTime(new Date(2026, 0, 15, 14, 30), now)).toBe('2:30 PM');
  });

  it('shows a short date within the same year', () => {
    expect(formatRowTime(new Date(2026, 2, 3), now)).toBe('Mar 3');
  });

  it('includes the year for other years', () => {
    expect(formatRowTime(new Date(2025, 11, 20), now)).toBe('Dec 20, 2025');
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
