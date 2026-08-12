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

/**
 * Rank events for the story strip: calendar / non-browser first, then longer
 * visits, then unique titles — truncated to MAX_SLIDES.
 */
export function selectTodayStoryEvents(events: readonly ScheduleEvent[], day: Date): ScheduleEvent[] {
  const start = new Date(day);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);

  const todays = events.filter((event) => {
    const t = new Date(event.startTime).getTime();

    return t >= start.getTime() && t < end.getTime();
  });

  const calendar = todays.filter((e) => !isBrowserCapture(e));
  const browsing = todays.filter((e) => isBrowserCapture(e));

  browsing.sort((a, b) => {
    const d = durationMs(b) - durationMs(a);
    if (d !== 0) {
      return d;
    }

    return a.title.localeCompare(b.title);
  });

  // Prefer distinct titles so 40 YouTube ticks don't monopolise the deck.
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

  const merged = [...calendar, ...uniqueBrowsing].sort(
    (a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime(),
  );

  return merged.slice(0, MAX_SLIDES);
}

export function buildTodayTimelineData(events: readonly ScheduleEvent[], day: Date): TimelineJsData {
  const selected = selectTodayStoryEvents(events, day);
  const label = day.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });

  return {
    scale: 'human',
    title: {
      unique_id: 'today-title',
      start_date: partsOf(day),
      text: {
        headline: 'Today',
        text: `${label} · ${selected.length} moment${selected.length === 1 ? '' : 's'} in focus${
          events.length > selected.length ? ` (of ${events.length} on the day)` : ''
        }`,
      },
    },
    events: selected.map(toSlide),
  };
}
