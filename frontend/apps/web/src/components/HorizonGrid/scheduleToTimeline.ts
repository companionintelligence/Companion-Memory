import type { ScheduleEvent } from '@/api/useScheduleService';

import { isBrowserCapture } from './scheduleClusters';

/**
 * TimelineJS3 JSON for "today as a story".
 *
 * TimelineJS is a storytelling slideshow, not a dense calendar: feeding it every
 * capture tick makes an unreadable novel. We keep calendar blocks, then sample
 * the best browser visits (longer / unique titles), capped at MAX_SLIDES.
 */

const MAX_SLIDES = 48;

export interface TimelineDateParts {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
  second?: string;
}

export interface TimelineSlide {
  start_date: TimelineDateParts;
  end_date?: TimelineDateParts;
  text: { headline: string; text: string };
  media?: { url: string; link?: string; caption?: string };
  group?: string;
  unique_id: string;
  autolink?: boolean;
}

export interface TimelineJsData {
  title: TimelineSlide;
  events: TimelineSlide[];
  scale: 'human';
}

function partsOf(date: Date): TimelineDateParts {
  return {
    year: String(date.getFullYear()),
    month: String(date.getMonth() + 1),
    day: String(date.getDate()),
    hour: String(date.getHours()),
    minute: String(date.getMinutes()),
    second: String(date.getSeconds()),
  };
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

function toSlide(event: ScheduleEvent): TimelineSlide {
  const start = new Date(event.startTime);
  const end = event.endTime ? new Date(event.endTime) : null;
  const url = eventUrl(event);
  const group = isBrowserCapture(event) ? 'Browsing' : (event.sourceSystem ?? event.category ?? 'Schedule');
  const when = start.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const bodyBits = [
    when,
    event.isAllDay ? 'All day' : null,
    event.locationName,
    event.description && event.description.trim() !== event.title.trim() ? event.description.trim() : null,
    url,
  ].filter(Boolean);

  const slide: TimelineSlide = {
    start_date: partsOf(start),
    text: {
      headline: event.title || 'Untitled',
      text: bodyBits.join(' · '),
    },
    group: String(group),
    unique_id: event.id,
    autolink: true,
  };

  if (end && !event.isAllDay) {
    slide.end_date = partsOf(end);
  }

  // Only hand TimelineJS media it can embed. Arbitrary page URLs make it try
  // (and often fail) to iframe random sites, which blanks the story panel.
  if (url && isEmbeddableMedia(url)) {
    slide.media = { url, link: url, caption: event.title };
  }

  return slide;
}

function isEmbeddableMedia(url: string): boolean {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '').toLowerCase();

    return (
      host === 'youtube.com' ||
      host === 'youtu.be' ||
      host === 'vimeo.com' ||
      host === 'twitter.com' ||
      host === 'x.com' ||
      host === 'wikipedia.org' ||
      /\.(jpe?g|png|gif|webp|svg)(\?|$)/i.test(url)
    );
  } catch {
    return false;
  }
}

export function localDayKey(date: Date): string {
  const day = new Date(date);
  day.setHours(0, 0, 0, 0);

  return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
}

export function eventFallsOnDay(event: ScheduleEvent, day: Date): boolean {
  return localDayKey(new Date(event.startTime)) === localDayKey(day);
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
 * Story slides around `focusDay`: that day's events stay complete, then
 * neighbours fill in so TimelineJS can walk forward and back.
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

  const chosen: ScheduleEvent[] = [...sampled[focusIndex]];
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

export function buildTodayTimelineData(events: readonly ScheduleEvent[], day: Date): TimelineJsData {
  return buildTimelineData(events, day).data;
}

export function buildTimelineData(
  events: readonly ScheduleEvent[],
  day: Date,
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
        text: {
          headline: label,
          text: 'Use the timeline to move forward or back through your schedule.',
        },
      },
      events: selected.events.map(toSlide),
    },
  };
}
