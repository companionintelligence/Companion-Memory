/** Tiny calendar-date helpers shared by the metrics service and the QA math. */

/** Format a Date as a YYYY-MM-DD calendar date (UTC). */
export function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Shift a YYYY-MM-DD date by whole days (UTC), returning YYYY-MM-DD. */
export function shiftIso(iso: string, deltaDays: number): string {
  const date = new Date(`${iso}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + deltaDays);

  return isoDate(date);
}

/** Today's calendar date (UTC) as YYYY-MM-DD. */
export function todayIso(): string {
  return isoDate(new Date());
}

/**
 * Today's calendar date in an IANA timezone as YYYY-MM-DD.
 * Falls back to UTC when the timezone string is invalid.
 */
export function todayIsoInTimezone(timezone: string): string {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
  } catch {
    return todayIso();
  }
}
