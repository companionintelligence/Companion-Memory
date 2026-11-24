import { zonedAddDays, zonedParts, zonedStartOfDay, zonedWallTimeToInstant } from './zonedClock';

/**
 * The calendar's four timescales, as Google Calendar names them. Each is one
 * way of choosing a window around an anchor date and one way of stepping it.
 */
export const CALENDAR_VIEWS = ['day', 'week', 'month', 'year'] as const;
export type CalendarView = (typeof CALENDAR_VIEWS)[number];

export function isCalendarView(value: unknown): value is CalendarView {
  return typeof value === 'string' && (CALENDAR_VIEWS as readonly string[]).includes(value);
}

export const DAYS_IN_WEEK = 7;

/**
 * Which weekday a week starts on, 0 = Sunday … 6 = Saturday, from the locale's
 * own week rules where the engine exposes them (`Intl.Locale.weekInfo`, or
 * `getWeekInfo()` in newer engines). Sunday otherwise, which is the US rule.
 */
export function weekStartsOn(locale?: string): number {
  try {
    const tag = locale ?? (typeof navigator !== 'undefined' ? navigator.language : 'en-US');
    const info = new Intl.Locale(tag) as Intl.Locale & {
      weekInfo?: { firstDay: number };
      getWeekInfo?: () => { firstDay: number };
    };
    const firstDay = info.getWeekInfo?.().firstDay ?? info.weekInfo?.firstDay;

    // weekInfo counts 1 = Monday … 7 = Sunday.
    if (typeof firstDay === 'number' && firstDay >= 1 && firstDay <= 7) {
      return firstDay % 7;
    }
  } catch {
    // An unknown tag, or no Intl.Locale at all.
  }

  return 0;
}

/** 0 = Sunday … 6 = Saturday, read on `zone`'s calendar. */
export function zonedWeekday(instant: Date, zone: string): number {
  const p = zonedParts(instant, zone);

  return new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay();
}

export function startOfLocalWeek(instant: Date, zone: string, firstDay = 0): Date {
  const back = (zonedWeekday(instant, zone) - firstDay + DAYS_IN_WEEK) % DAYS_IN_WEEK;

  return zonedAddDays(zonedStartOfDay(instant, zone), -back, zone);
}

export function startOfLocalMonth(instant: Date, zone: string): Date {
  const p = zonedParts(instant, zone);

  return zonedWallTimeToInstant(p.year, p.month, 1, 0, 0, 0, zone);
}

export function startOfLocalYear(instant: Date, zone: string): Date {
  const p = zonedParts(instant, zone);

  return zonedWallTimeToInstant(p.year, 1, 1, 0, 0, 0, zone);
}

/**
 * The same day-of-month `months` later, clamped to the shorter month: the 31st
 * stepped one month from January lands on the last day of February.
 */
export function addLocalMonths(instant: Date, months: number, zone: string): Date {
  const p = zonedParts(instant, zone);
  const index = p.month - 1 + months;
  const year = p.year + Math.floor(index / 12);
  const month = ((index % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();

  return zonedWallTimeToInstant(year, month + 1, Math.min(p.day, lastDay), p.hour, p.minute, p.second, zone);
}

export function addLocalYears(instant: Date, years: number, zone: string): Date {
  return addLocalMonths(instant, years * 12, zone);
}

export function sameLocalMonth(a: Date, b: Date, zone: string): boolean {
  const pa = zonedParts(a, zone);
  const pb = zonedParts(b, zone);

  return pa.year === pb.year && pa.month === pb.month;
}

export interface CalendarWindow {
  /** What is on screen: the day, the week, the month's grid, the year. */
  span: { start: Date; end: Date };
  /**
   * What to ask the server for. The same as `span` except for the year, which
   * draws no events and would otherwise ask for 365 days against a 92-day cap.
   */
  fetch: { start: Date; end: Date };
  /** Month view only: the first day of the month the grid is about. */
  month: Date | null;
  /** Month view only: how many 7-day rows the grid needs for this month. */
  weeks: number;
}

/**
 * The window a view draws around `anchor`.
 *
 * The week is the calendar week holding the anchor — not seven days from
 * today, which is what the page did before it had views: paging then moved in
 * rolling steps that lined up with nothing on a wall calendar.
 */
export function calendarWindow(view: CalendarView, anchor: Date, zone: string, firstDay = 0): CalendarWindow {
  const day = zonedStartOfDay(anchor, zone);

  switch (view) {
    case 'day': {
      const span = { start: day, end: zonedAddDays(day, 1, zone) };

      return { span, fetch: span, month: null, weeks: 0 };
    }

    case 'week': {
      const start = startOfLocalWeek(day, zone, firstDay);
      const span = { start, end: zonedAddDays(start, DAYS_IN_WEEK, zone) };

      return { span, fetch: span, month: null, weeks: 1 };
    }

    case 'month': {
      const month = startOfLocalMonth(day, zone);
      const start = startOfLocalWeek(month, zone, firstDay);
      const nextMonth = addLocalMonths(month, 1, zone);
      // Rows until the week holding the month's last day is complete.
      const lastWeekStart = startOfLocalWeek(zonedAddDays(nextMonth, -1, zone), zone, firstDay);
      const end = zonedAddDays(lastWeekStart, DAYS_IN_WEEK, zone);
      const weeks = Math.round((end.getTime() - start.getTime()) / (DAYS_IN_WEEK * 86_400_000));
      const span = { start, end };

      return { span, fetch: span, month, weeks };
    }

    case 'year': {
      const start = startOfLocalYear(day, zone);
      const span = { start, end: addLocalYears(start, 1, zone) };

      return { span, fetch: { start: day, end: zonedAddDays(day, 1, zone) }, month: null, weeks: 0 };
    }
  }
}

/** The anchor one view-unit before or after. */
export function stepAnchor(view: CalendarView, anchor: Date, delta: number, zone: string): Date {
  switch (view) {
    case 'day':
      return zonedAddDays(anchor, delta, zone);
    case 'week':
      return zonedAddDays(anchor, delta * DAYS_IN_WEEK, zone);
    case 'month':
      return addLocalMonths(anchor, delta, zone);
    case 'year':
      return addLocalYears(anchor, delta, zone);
  }
}

/** What the heading between the arrows says. */
export function formatWindowTitle(view: CalendarView, window: CalendarWindow, zone: string): string {
  const { start, end } = window.span;

  switch (view) {
    case 'day':
      return start.toLocaleDateString([], {
        weekday: 'short',
        month: 'long',
        day: 'numeric',
        year: 'numeric',
        timeZone: zone,
      });
    case 'week': {
      const opts: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', timeZone: zone };
      const withYear: Intl.DateTimeFormatOptions = { ...opts, year: 'numeric' };
      const last = zonedAddDays(end, -1, zone);

      // The year once, at the end, unless the week straddles two of them.
      return zonedParts(start, zone).year === zonedParts(last, zone).year
        ? `${start.toLocaleDateString([], opts)} – ${last.toLocaleDateString([], withYear)}`
        : `${start.toLocaleDateString([], withYear)} – ${last.toLocaleDateString([], withYear)}`;
    }

    case 'month':
      return (window.month ?? start).toLocaleDateString([], {
        month: 'long',
        year: 'numeric',
        timeZone: zone,
      });
    case 'year':
      return start.toLocaleDateString([], { year: 'numeric', timeZone: zone });
  }
}

/** The day starts a month grid draws, row-major: `weeks` rows of seven. */
export function monthGridDays(window: CalendarWindow, zone: string): Date[] {
  return Array.from({ length: window.weeks * DAYS_IN_WEEK }, (_, index) =>
    zonedAddDays(window.span.start, index, zone),
  );
}
