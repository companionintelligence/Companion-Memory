import { describe, expect, it } from 'vitest';

import type { ScheduleEvent } from '@/api/useScheduleService';

import { eventFallsOnDay, selectStoryEvents } from './scheduleToTimeline';

function event(id: string, start: Date, title = id): ScheduleEvent {
  return {
    id,
    title,
    description: null,
    startTime: start.toISOString(),
    endTime: new Date(start.getTime() + 3_600_000).toISOString(),
    isAllDay: false,
    status: 'confirmed',
    category: 'WORK',
    locationName: null,
  };
}

describe('selectStoryEvents', () => {
  const sunday = new Date(2026, 7, 16);
  const monday = new Date(2026, 7, 17);
  const friday = new Date(2026, 7, 21);

  const events = [
    event('sun', new Date(2026, 7, 16, 9)),
    event('mon-1', new Date(2026, 7, 17, 10)),
    event('mon-2', new Date(2026, 7, 17, 14)),
    event('fri', new Date(2026, 7, 21, 11)),
  ];

  it('returns nothing when the focused day is empty', () => {
    expect(
      selectStoryEvents(
        events.filter((item) => item.id !== 'sun'),
        sunday,
      ).events,
    ).toEqual([]);
  });

  it('starts on the focused day and keeps neighbours for TimelineJS nav', () => {
    const { events: slides, startAtSlide } = selectStoryEvents(events, monday);

    expect(slides.map((item) => item.id)).toEqual(['sun', 'mon-1', 'mon-2', 'fri']);
    expect(eventFallsOnDay(slides[startAtSlide], monday)).toBe(true);
    expect(slides[startAtSlide].id).toBe('mon-1');
  });

  it('keeps a later focus day reachable after earlier neighbours', () => {
    const { events: slides, startAtSlide } = selectStoryEvents(events, friday);

    expect(slides[startAtSlide].id).toBe('fri');
  });
});
