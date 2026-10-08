import type { ScheduleEvent } from '@/api/useScheduleService';
import {
  axisPadEraFromRange,
  endOfLocalDay,
  partsOf,
  startOfLocalDay,
  TIMELINE_AXIS_PAD_DAYS,
} from '@/components/TimelineJs/dates';
import { plainSlideText } from '@/components/TimelineJs/escapeHtml';
import type { TimelineEra, TimelineJsData, TimelineSlide } from '@/components/TimelineJs/types';
import { HOUR_MINUTE, type DateTimeFormatter } from '@/lib/dateTimeFormat';
import { detectBrowserTimeZone } from '@/lib/timezone';

import { isBrowserCapture } from './scheduleClusters';
import { zonedDayKey } from './zonedClock';

export { TIMELINE_AXIS_PAD_DAYS };
export type {
  TimelineDateParts,
  TimelineEra,
  TimelineJsData,
  TimelineSlide,
} from '@/components/TimelineJs/types';

/**
 * TimelineJS3 JSON for "today as a story".
 *
 * TimelineJS is a storytelling slideshow, not a dense calendar: feeding it every
 * capture tick makes an unreadable novel. We keep calendar blocks, then sample
 * the best browser visits (longer / unique titles), capped at MAX_SLIDES.
 *
 * Keep the cap modest: TimelineJS mounts every slide and every axis tick in the
 * DOM. 48 slides over a 35-day range was a wide, expensive time-nav canvas.
 */

const MAX_SLIDES = 12;

/**
 * Hidden era that pulls the TimeNav axis through neighbouring days so minor
 * ticks exist wherever major day labels already appear when zoomed out.
 */
export function axisPadEra(events: readonly ScheduleEvent[], focusDay: Date): TimelineEra {
  let earliest = startOfLocalDay(focusDay);
  let latest = endOfLocalDay(focusDay);

  for (const event of events) {
    const start = new Date(event.startTime);
    const end = new Date(event.endTime ?? event.startTime);
    if (start.getTime() < earliest.getTime()) {
      earliest = start;
    }

    if (end.getTime() > latest.getTime()) {
      latest = end;
    }
  }

  return axisPadEraFromRange(earliest, latest);
}

function eventUrl(event: ScheduleEvent): string | null {
  const raw = event.metadata?.url;

  if (typeof raw !== 'string') {
    return null;
  }

  const url = raw.trim();

  return /^https?:\/\//i.test(url) ? url : null;
}

function durationMs(event: ScheduleEvent): number {
  if (!event.endTime) {
    return 0;
  }

  return Math.max(0, new Date(event.endTime).getTime() - new Date(event.startTime).getTime());
}

function toSlide(event: ScheduleEvent, fmt: DateTimeFormatter): TimelineSlide {
  const start = new Date(event.startTime);
  const end = event.endTime ? new Date(event.endTime) : null;
  const url = eventUrl(event);
  const when = fmt.time(start, HOUR_MINUTE);
  const bodyBits = [
    when,
    event.isAllDay ? 'All day' : null,
    event.locationName,
    event.description && event.description.trim() !== event.title.trim() ? event.description.trim() : null,
    url,
  ].filter(Boolean);

  const slide: TimelineSlide = {
    start_date: partsOf(start),
    text: plainSlideText(event.title || 'Untitled', bodyBits.join(' · ')),
    unique_id: event.id,
    autolink: false,
  };

  if (end && !event.isAllDay) {
    slide.end_date = partsOf(end);
  }

  // Do not attach media. TimelineJS iframes YouTube/Vimeo/Twitter and those
  // embeds keep a compositor thread busy on a page that already has a week grid.
  // The URL still appears in the slide text when present.

  return slide;
}

/** The calendar date an instant falls on, in the zone the surface draws in. */
export function localDayKey(date: Date, zone: string = detectBrowserTimeZone()): string {
  return zonedDayKey(date, zone);
}

export function eventFallsOnDay(
  event: ScheduleEvent,
  day: Date,
  zone: string = detectBrowserTimeZone(),
): boolean {
  return localDayKey(new Date(event.startTime), zone) === localDayKey(day, zone);
}

function sampleDay(eventsOnDay: ScheduleEvent[]): ScheduleEvent[] {
  const calendar = eventsOnDay.filter((event) => !isBrowserCapture(event));
  const browsing = eventsOnDay.filter((event) => isBrowserCapture(event));

  browsing.sort((a, b) => {
    const d = durationMs(b) - durationMs(a);
    if (d !== 0) {
      return d;
    }

    return a.title.localeCompare(b.title);
  });

  const seenTitles = new Set<string>();
  const uniqueBrowsing: ScheduleEvent[] = [];
  for (const event of browsing) {
    const key = event.title.trim().toLowerCase();
    if (seenTitles.has(key)) {
      continue;
    }

    seenTitles.add(key);
    uniqueBrowsing.push(event);
  }

  return [...calendar, ...uniqueBrowsing].sort(
    (a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime(),
  );
}

/**
 * Story slides around `focusDay`: that day's events are kept first (capped),
 * then neighbours fill remaining slots so TimelineJS can walk forward and back.
 */
export function selectStoryEvents(
  events: readonly ScheduleEvent[],
  focusDay: Date,
  max = MAX_SLIDES,
): { events: ScheduleEvent[]; startAtSlide: number } {
  const buckets = new Map<string, ScheduleEvent[]>();
  for (const event of events) {
    const key = localDayKey(new Date(event.startTime));
    const bucket = buckets.get(key) ?? [];
    bucket.push(event);
    buckets.set(key, bucket);
  }

  const days = [...buckets.keys()].sort();
  const sampled = days.map((key) => sampleDay(buckets.get(key) ?? []));
  const focusKey = localDayKey(focusDay);
  const focusIndex = days.indexOf(focusKey);
  if (focusIndex < 0 || sampled[focusIndex]?.length === 0) {
    return { events: [], startAtSlide: 0 };
  }

  const chosen: ScheduleEvent[] = [...sampled[focusIndex].slice(0, max)];
  let before = focusIndex - 1;
  let after = focusIndex + 1;
  while (chosen.length < max && (before >= 0 || after < sampled.length)) {
    if (before >= 0) {
      const extra = sampled[before];
      const room = max - chosen.length;
      chosen.unshift(...extra.slice(-room));
      before -= 1;
    }

    if (chosen.length >= max) {
      break;
    }

    if (after < sampled.length) {
      const extra = sampled[after];
      const room = max - chosen.length;
      chosen.push(...extra.slice(0, room));
      after += 1;
    }
  }

  const startAtSlide = Math.max(
    0,
    chosen.findIndex((event) => eventFallsOnDay(event, focusDay)),
  );

  return { events: chosen, startAtSlide };
}

/** @deprecated Use selectStoryEvents — kept for the one-day sample. */
export function selectTodayStoryEvents(events: readonly ScheduleEvent[], day: Date): ScheduleEvent[] {
  return selectStoryEvents(events, day).events.filter((event) => eventFallsOnDay(event, day));
}

export function buildTodayTimelineData(
  events: readonly ScheduleEvent[],
  day: Date,
  fmt: DateTimeFormatter,
): TimelineJsData {
  return buildTimelineData(events, day, fmt).data;
}

export function buildTimelineData(
  events: readonly ScheduleEvent[],
  day: Date,
  fmt: DateTimeFormatter,
): { data: TimelineJsData; startAtSlide: number } {
  const selected = selectStoryEvents(events, day);
  const label = day.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });

  return {
    startAtSlide: selected.startAtSlide,
    data: {
      scale: 'human',
      title: {
        unique_id: 'focus-title',
        start_date: partsOf(day),
        text: plainSlideText(label, 'Use the timeline to move forward or back through your schedule.'),
      },
      events: selected.events.map((event) => toSlide(event, fmt)),
      eras: [axisPadEra(selected.events, day)],
    },
  };
}
