import type { ScheduleEvent } from '@/api/useScheduleService';
import { detectBrowserTimeZone } from '@/lib/timezone';

import { isBrowserCapture } from './scheduleClusters';
import { eventFallsOnDay } from './scheduleToTimeline';
import { zonedAddDays, zonedSameDay, zonedStartOfDay } from './zonedClock';

export type NowNextStatus = 'now' | 'next' | 'later';

export interface NowNextItem {
  event: ScheduleEvent;
  status: NowNextStatus;
}

export interface NowNextPick {
  items: NowNextItem[];
  remaining: number;
  /** True when the day had events, but every timed one has already ended. */
  done: boolean;
}

/**
 * Day boundaries and clock reading, in the zone the surface draws in.
 *
 * `zone` defaults to the browser's so a caller with no profile zone to hand
 * (TaskSlate's slot label) keeps the reading it always had; the schedule
 * surface passes the owner's profile zone — see {@link ./zonedClock} for why
 * that is the source of truth.
 */
export function startOfLocalDay(date: Date, zone: string = detectBrowserTimeZone()): Date {
  return zonedStartOfDay(date, zone);
}

export function addDays(date: Date, days: number, zone: string = detectBrowserTimeZone()): Date {
  return zonedAddDays(date, days, zone);
}

export function sameLocalDay(a: Date, b: Date, zone: string = detectBrowserTimeZone()): boolean {
  return zonedSameDay(a, b, zone);
}

export function formatClock(date: Date, zone: string = detectBrowserTimeZone()): string {
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', timeZone: zone });
}

function eventEnd(event: ScheduleEvent): Date {
  if (event.endTime) {
    return new Date(event.endTime);
  }

  return new Date(new Date(event.startTime).getTime() + 30 * 60_000);
}

/**
 * Calendar blocks for a local day, oldest first. Browser-capture ticks stay
 * out — they belong in the week grid, not in a three-line "what's next".
 */
export function eventsOnDay(
  events: readonly ScheduleEvent[],
  day: Date,
  zone: string = detectBrowserTimeZone(),
): ScheduleEvent[] {
  return events
    .filter((event) => eventFallsOnDay(event, day, zone) && !isBrowserCapture(event))
    .sort((a, b) => {
      if (a.isAllDay !== b.isAllDay) {
        return a.isAllDay ? -1 : 1;
      }

      return new Date(a.startTime).getTime() - new Date(b.startTime).getTime();
    });
}

/**
 * What a phone needs from the day: anything in progress, then what comes next.
 *
 * Other days skip the "already ended" filter and just show the first `limit`
 * blocks — you are looking ahead or back, not asking "what do I do now".
 */
export function pickNowNext(
  events: readonly ScheduleEvent[],
  day: Date,
  now: Date,
  limit = 3,
  zone: string = detectBrowserTimeZone(),
): NowNextPick {
  const dayEvents = eventsOnDay(events, day, zone);

  if (dayEvents.length === 0) {
    return { items: [], remaining: 0, done: false };
  }

  const lookingAtToday = sameLocalDay(day, now, zone);
  const relevant = lookingAtToday
    ? dayEvents.filter((event) => event.isAllDay || eventEnd(event).getTime() > now.getTime())
    : dayEvents;

  if (relevant.length === 0) {
    return { items: [], remaining: 0, done: true };
  }

  const items: NowNextItem[] = [];
  let assignedNext = false;

  for (const event of relevant.slice(0, limit)) {
    const start = new Date(event.startTime);
    const inProgress =
      lookingAtToday &&
      !event.isAllDay &&
      start.getTime() <= now.getTime() &&
      now.getTime() < eventEnd(event).getTime();

    if (inProgress) {
      items.push({ event, status: 'now' });
      continue;
    }

    if (!assignedNext) {
      items.push({ event, status: 'next' });
      assignedNext = true;
      continue;
    }

    items.push({ event, status: 'later' });
  }

  return {
    items,
    remaining: Math.max(0, relevant.length - items.length),
    done: false,
  };
}
