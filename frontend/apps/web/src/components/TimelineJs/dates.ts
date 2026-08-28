import type { TimelineDateParts, TimelineEra } from './types';

/**
 * TimelineJS pads major ticks by `_scaled_padding * major.factor` and minor by
 * `* minor.factor`. Day labels therefore reach further left/right than hour
 * marks. An era expands earliest/latest so both axes share the same navigable
 * span (eras are hidden in CSS).
 */
export const TIMELINE_AXIS_PAD_DAYS = 2;

export function partsOf(date: Date): TimelineDateParts {
  return {
    year: String(date.getFullYear()),
    month: String(date.getMonth() + 1),
    day: String(date.getDate()),
    hour: String(date.getHours()),
    minute: String(date.getMinutes()),
    second: String(date.getSeconds()),
  };
}

export function startOfLocalDay(date: Date): Date {
  const day = new Date(date);
  day.setHours(0, 0, 0, 0);

  return day;
}

export function endOfLocalDay(date: Date): Date {
  const day = new Date(date);
  day.setHours(23, 59, 59, 0);

  return day;
}

export function addLocalDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);

  return next;
}

/**
 * Hidden era that pulls the TimeNav axis through neighbouring days so minor
 * ticks exist wherever major day labels already appear when zoomed out.
 */
export function axisPadEraFromRange(earliest: Date, latest: Date): TimelineEra {
  return {
    start_date: partsOf(startOfLocalDay(addLocalDays(earliest, -TIMELINE_AXIS_PAD_DAYS))),
    end_date: partsOf(endOfLocalDay(addLocalDays(latest, TIMELINE_AXIS_PAD_DAYS))),
    text: { headline: '' },
  };
}
