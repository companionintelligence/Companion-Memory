import { zonedParts } from '@/components/HorizonGrid/zonedClock';
import type { DateTimeFormatter } from '@/lib/dateTimeFormat';

/** The slice of a pending change the Plan card words. */
export interface PendingChangeCopy {
  kind: string;
  rationale: string | null;
  /** The ISO instant a `schedule` change would place at — its `patch.startTime`. */
  startTime?: string | null;
}

/**
 * A raw ISO-8601 instant: date, `T`, clock, and a zone designator. Only the
 * zoned shape is matched — a bare `YYYY-MM-DD` is a calendar date, not an
 * instant, and has no clock to put it on.
 *
 * A leading `at ` is captured with it because the legacy sentence was
 * "Place on the calendar at <instant>?", and the slot is itself worded
 * "Mon, Sep 28 at 9:00 AM" — splicing one into the other verbatim read
 * "at Mon, Sep 28 at 9:00 AM". It becomes `on `, as the server words it now.
 */
const ISO_INSTANT = /(\bat )?\b(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2}))/g;

function parseInstant(value: string | null | undefined): Date | null {
  if (!value) {
    return null;
  }

  const instant = new Date(value);

  return Number.isNaN(instant.getTime()) ? null : instant;
}

/**
 * `Mon, Sep 28 at 4:00 PM` on `zone`'s clock, with the year only when it is
 * not this year there. The weekday is there because a proposal lands inside a
 * one-week window, where "which day" is the question and the date alone makes
 * the reader count. The time is written in the person's hour cycle (`fmt`).
 *
 * `locale` is the viewer's by default, like every other clock on the schedule
 * surface; tests pin it.
 */
export function formatSlot(
  instant: Date,
  zone: string,
  fmt: DateTimeFormatter,
  now: Date = new Date(),
  locale?: string,
): string {
  const sameYear = zonedParts(instant, zone).year === zonedParts(now, zone).year;
  const day = new Intl.DateTimeFormat(locale, {
    timeZone: zone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(sameYear ? {} : { year: 'numeric' }),
  }).format(instant);
  const time = fmt.time(instant, { timeZone: zone, hour: 'numeric', minute: '2-digit' }, locale);

  return `${day} at ${time}`;
}

/**
 * The sentence a pending change shows on its Plan card, on the owner's clock.
 *
 * ═══ THIS USED TO PRINT A UTC ISO STRING ═══
 *
 * `PlannedBlockService.tryPlaceAfterOpen` wrote the rationale as
 * `Place on the calendar at ${start.toISOString()}?`, and the card rendered it
 * verbatim: "Place on the calendar at 2026-09-28T16:00:00.000Z?" — UTC, so
 * hours off for anyone west or east of Greenwich, and machine-shaped for
 * everyone. The server now writes a readable sentence, but rows written before
 * that are persisted with the ISO string and still pending.
 *
 * So a `schedule` change is worded from its structured `patch.startTime`, not
 * from the stored text: that is the instant Confirm replays, it reads the same
 * for old rows and new ones, and it follows the owner's CURRENT zone rather
 * than whichever zone was set when the suggestion was filed. Any other change
 * keeps the server's sentence, with any ISO instant inside it put on the same
 * clock — the stored text is the fallback, never a raw timestamp.
 */
export function describePendingChange(
  change: PendingChangeCopy,
  zone: string,
  fmt: DateTimeFormatter,
  now: Date = new Date(),
  locale?: string,
): string | null {
  const start = change.kind === 'schedule' ? parseInstant(change.startTime) : null;

  if (start) {
    return `Place on the calendar on ${formatSlot(start, zone, fmt, now, locale)}?`;
  }

  if (!change.rationale) {
    return null;
  }

  return change.rationale.replace(ISO_INSTANT, (match, at: string | undefined, iso: string) => {
    const instant = parseInstant(iso);

    return instant ? `${at ? 'on ' : ''}${formatSlot(instant, zone, fmt, now, locale)}` : match;
  });
}
