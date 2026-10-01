import { describe, expect, it } from 'vitest';

import type { ScheduleEvent } from '@/api/useScheduleService';
import { createDateTimeFormatter, DEVICE_DATE_TIME_FORMATTER } from '@/lib/dateTimeFormat';

import {
  TIMELINE_AXIS_PAD_DAYS,
  axisPadEra,
  buildTimelineData,
  eventFallsOnDay,
  selectStoryEvents,
} from './scheduleToTimeline';

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

describe('axisPadEra', () => {
  it('reaches back before the focus day even when every slide is that day', () => {
    const focus = new Date(2026, 7, 18, 12);
    const slides = [event('only', new Date(2026, 7, 18, 15))];

    const era = axisPadEra(slides, focus);

    expect(era.start_date).toEqual({
      year: '2026',
      month: '8',
      day: '16',
      hour: '0',
      minute: '0',
      second: '0',
    });
    expect(era.end_date.day).toBe(String(18 + TIMELINE_AXIS_PAD_DAYS));
    expect(era.end_date.hour).toBe('23');
  });

  it('expands around the earliest and latest slides, not only the focus day', () => {
    const focus = new Date(2026, 7, 18);
    const era = axisPadEra(
      [event('early', new Date(2026, 7, 17, 9)), event('late', new Date(2026, 7, 19, 18))],
      focus,
    );

    expect(era.start_date.day).toBe('15');
    expect(era.end_date.day).toBe('21');
  });
});

describe('buildTimelineData', () => {
  it('does not attach TimelineJS media embeds', () => {
    const monday = new Date(2026, 7, 17);
    const visit = event('yt', new Date(2026, 7, 17, 10), 'A video');
    visit.metadata = { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' };

    const { data } = buildTimelineData([visit], monday, DEVICE_DATE_TIME_FORMATTER);

    expect(data.events).toHaveLength(1);
    expect(data.events[0].media).toBeUndefined();
    expect(data.events[0].group).toBeUndefined();
    expect(data.events[0].autolink).toBe(false);
    expect(data.events[0].text.text).toContain('https://www.youtube.com/watch?v=dQw4w9WgXcQ');
  });

  it('caps the deck so TimelineJS does not mount a novel of slides', () => {
    const monday = new Date(2026, 7, 17);
    const flood = Array.from({ length: 40 }, (_, index) =>
      event(`e-${index}`, new Date(2026, 7, 17, 8, index), `Item ${index}`),
    );

    expect(buildTimelineData(flood, monday, DEVICE_DATE_TIME_FORMATTER).data.events).toHaveLength(12);
  });

  it('includes a hidden axis-pad era so minor ticks cover zoomed-out neighbours', () => {
    const monday = new Date(2026, 7, 17);
    const { data } = buildTimelineData(
      [event('only', new Date(2026, 7, 17, 10))],
      monday,
      DEVICE_DATE_TIME_FORMATTER,
    );

    expect(data.eras).toHaveLength(1);
    expect(data.eras?.[0].start_date.day).toBe('15');
    expect(data.eras?.[0].end_date.day).toBe('19');
  });

  it("writes each slide's time in the chosen hour cycle", () => {
    const monday = new Date(2026, 7, 17);
    const slideText = (timeFormat: 'h12' | 'h23') =>
      buildTimelineData(
        [event('late', new Date(2026, 7, 17, 15, 43))],
        monday,
        // No zone: this test builds its instants on the runner's clock, so it reads them there.
        createDateTimeFormatter({ timeFormat }),
      ).data.events[0].text.text;

    expect(slideText('h23')).toMatch(/^15:43/);
    expect(slideText('h12')).toMatch(/^3:43\sPM/i);
  });
});
