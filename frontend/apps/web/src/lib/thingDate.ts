/**
 * Acquired, Made and Expires are days, stored as instants.
 *
 * Two generations of rows share the columns. Before the app wrote "the start of
 * the picked day where the person is", it wrote the picked day as UTC midnight
 * (`2024-03-02T00:00:00.000Z`), and importers still do for a date they only know
 * to the day. Read in the viewer's zone, that instant is the day before
 * everywhere west of UTC. An instant that falls exactly on a UTC midnight is
 * therefore read as the UTC day it names. A start-of-day written by the current
 * code never lands on one except where the writer's zone is UTC itself (offset
 * 0), and there the UTC day and the local day are the same day, so nothing
 * written today is misread. Every other instant is shown in the viewer's zone.
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
