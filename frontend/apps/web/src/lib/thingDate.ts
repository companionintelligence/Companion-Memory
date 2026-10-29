/**
 * Acquired, Made and Expires are days, stored as instants.
 *
 * A picked day is stored as UTC midnight (`2024-03-02T00:00:00.000Z`), and
 * importers write the same for a date they only know to the day. An instant
 * that falls exactly on a UTC midnight is read as the UTC day it names, so every
 * zone shows the day that was picked. Read in the viewer's zone, it would be the
 * day before everywhere west of UTC.
 *
 * Every other instant is a real moment (an importer's order time) and is shown
 * in the viewer's zone. For a while the form wrote the start of the picked day
 * where the person was (`2024-03-01T15:00:00.000Z` from Tokyo). Those rows are
 * read the same way, so they show the picked day in the zone they were picked
 * in and can be a day off elsewhere. The server's daily stats split the two
 * kinds the same way (`dailyAggregateSql.ts`).
 */

const DAY_MS = 86_400_000;

/**
 * The day a stored Thing date names, as a Date that `toLocaleDateString()` and the
 * local getters (`getFullYear`, `getMonth`, `getDate`) read as that day. Null for
 * an empty or unparseable value.
 */
export function thingDate(value: string | Date | null | undefined): Date | null {
  if (value == null || value === '') {
    return null;
  }

  const date = new Date(value);
  const time = date.getTime();

  if (Number.isNaN(time)) {
    return null;
  }

  if (time % DAY_MS !== 0) {
    return date;
  }

  return new Date(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

/** A stored Thing date as the viewer's locale writes a day, or null when there is none. */
export function formatThingDate(value: string | Date | null | undefined): string | null {
  return thingDate(value)?.toLocaleDateString() ?? null;
}

/** The `YYYY-MM-DD` a date input needs for a stored Thing date, or '' when there is none. */
export function toThingDateInput(value: string | Date | null | undefined): string {
  const date = thingDate(value);

  if (!date) {
    return '';
  }

  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');

  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * What to store for a date input's `YYYY-MM-DD`: the picked day as UTC midnight,
 * or null when the input is empty. `new Date(y, m, d)` (the start of the day where
 * the person is) named a different day to everyone east or west of them: a day
 * picked as Oct 1 in Tokyo is 15:00 on Sep 30 in UTC. Throws for a value that is
 * not a day, so the form shows it instead of clearing the stored date.
 */
export function fromThingDateInput(value: string): string | null {
  const trimmed = value.trim();

  if (trimmed === '') {
    return null;
  }

  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    const stored = `${trimmed}T00:00:00.000Z`;
    const date = new Date(stored);

    // Parsed from the ISO string, not built with Date.UTC, which reads years
    // 0 to 99 as 1900 to 1999. A day that does not exist (Feb 30, month 13)
    // either fails to parse or comes back as a different day.
    if (Number.isNaN(date.getTime()) || date.toISOString() !== stored) {
      throw new RangeError(`${trimmed} is not a day.`);
    }

    return stored;
  }

  const date = new Date(trimmed);

  if (Number.isNaN(date.getTime())) {
    throw new RangeError(`${trimmed} is not a date.`);
  }

  return date.toISOString();
}
