import type { DateTimeFormatter } from '@/lib/dateTimeFormat';

/** Title-case a snake/kebab identifier for display ('google_calendar' → 'Google Calendar'). */
export function formatEntityLabel(value?: string | null): string | null {
  if (!value) {
    return null;
  }

  return value
    .replace(/[_-]+/g, ' ')
    .trim()
    .replace(/\w\S*/g, (word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase());
}

/**
 * Render a stored timestamp for a detail view. Mirrors the memory drawer's
 * metadata rows so an entity reads the same on its full page as in the drawer.
 */
export function formatEntityTimestamp(
  value: string | null | undefined,
  fmt: DateTimeFormatter,
): string | null {
  if (!value) {
    return null;
  }

  const date = new Date(value);

  return isNaN(date.getTime())
    ? value
    : fmt.dateTime(date, { dateStyle: 'medium', timeStyle: 'short' }, 'en-US');
}
