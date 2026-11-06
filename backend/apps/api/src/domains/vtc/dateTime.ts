/**
 * `xsd:dateTimeStamp` as the Verifiable Credentials Data Model 2.0 uses it for `validFrom`,
 * `validUntil` and `created`: a full date, a time, and a time zone.
 *
 * `Date.parse` alone is not enough. V8 rolls an impossible calendar date forward instead of
 * refusing it (`2026-02-30T00:00:00Z` parses as 2 March, since February 2026 has 28 days), and
 * accepts hour 24. A validity window whose edge moves depending on who parses it is not a window,
 * so the fields are range-checked here before the string is handed to `Date.parse`.
 */

const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-](\d{2}):(\d{2}))$/;

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** Proleptic Gregorian, so year 0 (which `Date.UTC` would read as 1900) is a leap year. */
function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  return month === 2 && isLeapYear(year) ? 29 : DAYS_IN_MONTH[month - 1];
}

/** `date` as `YYYY-MM-DDTHH:MM:SSZ`, the form the specifications' examples use. */
export function toDateTimeStamp(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** The instant `value` names, or null when it is not a valid `xsd:dateTimeStamp`. */
export function parseDateTime(value: unknown): Date | null {
  if (typeof value !== 'string') {
    return null;
  }

  const match = DATE_TIME.exec(value);
  if (!match) {
    return null;
  }

  const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    return null;
  }

  if (hour > 23 || minute > 59 || second > 59) {
    return null;
  }

  if (match[7] !== undefined && (Number(match[7]) > 23 || Number(match[8]) > 59)) {
    return null;
  }

  const parsed = Date.parse(value);

  return Number.isNaN(parsed) ? null : new Date(parsed);
}
