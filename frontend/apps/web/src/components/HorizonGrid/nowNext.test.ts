import { describe, expect, it } from 'vitest';

import type { ScheduleEvent } from '@/api/useScheduleService';

import { eventsOnDay, pickNowNext } from './nowNext';

function event(overrides: Partial<ScheduleEvent> = {}): ScheduleEvent {
  return {
    id: overrides.id ?? 'e1',
    title: overrides.title ?? 'Standup',
    description: null,
    startTime: overrides.startTime ?? new Date(2026, 7, 19, 10).toISOString(),
    endTime: overrides.endTime ?? new Date(2026, 7, 19, 11).toISOString(),
    isAllDay: overrides.isAllDay ?? false,
    status: 'confirmed',
    category: null,
    locationName: null,
    sourceSystem: overrides.sourceSystem ?? 'google_calendar',
    ...overrides,
  };
}

const wednesday = new Date(2026, 7, 19, 10, 30);

describe('pickNowNext', () => {
  it('returns an empty list when the day has no calendar blocks', () => {
    expect(
      pickNowNext([event({ startTime: new Date(2026, 7, 20, 10).toISOString() })], wednesday, wednesday),
    ).toEqual({
      items: [],
      remaining: 0,
      done: false,
    });
  });

  it('marks the in-progress event as now and the following as next', () => {
    const events = [
      event({
        id: 'now',
        title: 'Standup',
        startTime: new Date(2026, 7, 19, 10).toISOString(),
        endTime: new Date(2026, 7, 19, 11).toISOString(),
      }),
      event({
        id: 'next',
        title: 'Review',
        startTime: new Date(2026, 7, 19, 14).toISOString(),
        endTime: new Date(2026, 7, 19, 15).toISOString(),
      }),
      event({
        id: 'later',
        title: '1:1',
        startTime: new Date(2026, 7, 19, 16).toISOString(),
        endTime: new Date(2026, 7, 19, 16, 30).toISOString(),
      }),
    ];

    const pick = pickNowNext(events, wednesday, wednesday);

    expect(pick.items.map((item) => [item.event.id, item.status])).toEqual([
      ['now', 'now'],
      ['next', 'next'],
      ['later', 'later'],
    ]);
    expect(pick.remaining).toBe(0);
    expect(pick.done).toBe(false);
  });

  it('drops events that have already ended when looking at today', () => {
    const events = [
      event({
        id: 'past',
        startTime: new Date(2026, 7, 19, 8).toISOString(),
        endTime: new Date(2026, 7, 19, 9).toISOString(),
      }),
      event({
        id: 'next',
        title: 'Review',
        startTime: new Date(2026, 7, 19, 14).toISOString(),
        endTime: new Date(2026, 7, 19, 15).toISOString(),
      }),
    ];

    const pick = pickNowNext(events, wednesday, wednesday);

    expect(pick.items.map((item) => item.event.id)).toEqual(['next']);
    expect(pick.items[0]?.status).toBe('next');
  });

  it('says the day is done when every timed event has ended', () => {
    const pick = pickNowNext(
      [
        event({
          startTime: new Date(2026, 7, 19, 8).toISOString(),
          endTime: new Date(2026, 7, 19, 9).toISOString(),
        }),
      ],
      wednesday,
      wednesday,
    );

    expect(pick).toEqual({ items: [], remaining: 0, done: true });
  });

  it('keeps earlier events when looking at another day', () => {
    const thursday = new Date(2026, 7, 20, 18);
    const events = [
      event({
        id: 'morning',
        startTime: new Date(2026, 7, 20, 9).toISOString(),
        endTime: new Date(2026, 7, 20, 10).toISOString(),
      }),
    ];

    const pick = pickNowNext(events, thursday, wednesday);

    expect(pick.items.map((item) => item.event.id)).toEqual(['morning']);
    expect(pick.done).toBe(false);
  });

  it('caps at three and reports the rest', () => {
    const events = [9, 11, 13, 15, 17].map((hour, index) =>
      event({
        id: `e${index}`,
        startTime: new Date(2026, 7, 19, hour).toISOString(),
        endTime: new Date(2026, 7, 19, hour + 1).toISOString(),
      }),
    );

    const pick = pickNowNext(events, new Date(2026, 7, 19, 8), new Date(2026, 7, 19, 8));

    expect(pick.items).toHaveLength(3);
    expect(pick.remaining).toBe(2);
  });

  it('leaves browser-capture ticks out of the list', () => {
    const events = [
      event({ id: 'visit', title: 'Docs', sourceSystem: 'browser_extension' }),
      event({ id: 'meet', title: 'Standup' }),
    ];

    expect(eventsOnDay(events, wednesday).map((item) => item.id)).toEqual(['meet']);
    expect(pickNowNext(events, wednesday, wednesday).items.map((item) => item.event.id)).toEqual(['meet']);
  });
});
