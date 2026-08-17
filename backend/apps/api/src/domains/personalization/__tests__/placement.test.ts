import {
  flexWindow,
  isDayDeferral,
  placeForSource,
  resolveActualStart,
  resolvePlanStart,
  shortTitle,
  splitActivities,
  writerFor,
} from '../placement';

const LA = 'America/Los_Angeles';
const SUNDAY = new Date('2026-08-16T22:00:00.000Z');

describe('writerFor / placeForSource', () => {
  it('accepts a slate candidate onto this week', () => {
    expect(placeForSource({ kind: 'candidate', id: 'abc' })).toBe('future_this_week');
    expect(writerFor({ kind: 'candidate', id: 'abc' })).toBe('write_schedule_accept');
  });

  it('writes last-night and further-back as actuals', () => {
    expect(writerFor({ kind: 'event', id: 'last-night', place: 'last_night' })).toBe('write_event_actual');
    expect(writerFor({ kind: 'event', id: 'night-2', place: 'further_back' })).toBe('write_event_actual');
  });

  it('does not treat an upcoming calendar event as an actual to write', () => {
    expect(writerFor({ kind: 'event', id: '01a00c7f-2da6-77fd-b2fb-5fc52f280dde' })).toBe('write_answer');
  });
});

describe('isDayDeferral', () => {
  it('treats No on a named day as a deferral, not a decline', () => {
    expect(isDayDeferral('no', { kind: 'candidate', id: 'abc', day: '2026-08-20' })).toBe(true);
    expect(isDayDeferral('yes', { kind: 'candidate', id: 'abc', day: '2026-08-20' })).toBe(false);
  });
});

describe('flexWindow', () => {
  it('starts at local midnight, not the sync instant', () => {
    const { windowStart, windowEnd } = flexWindow(LA, SUNDAY);
    expect(windowStart.toISOString()).toBe('2026-08-16T07:00:00.000Z');
    expect(windowEnd.toISOString()).toBe('2026-08-23T07:00:00.000Z');
  });
});

describe('resolvePlanStart / resolveActualStart', () => {
  it('places an accepted plan on the offered day at 10:00', () => {
    const start = resolvePlanStart(LA, '2026-08-20', undefined, SUNDAY);
    expect(start.toISOString()).toBe('2026-08-20T17:00:00.000Z');
  });

  it('places last night at 20:00 local', () => {
    const start = resolveActualStart(LA, 'last_night', undefined, 1, SUNDAY);
    expect(start.toISOString()).toBe('2026-08-16T03:00:00.000Z');
  });

  it('walks further back when asked', () => {
    const start = resolveActualStart(LA, 'further_back', undefined, 3, SUNDAY);
    expect(start.toISOString()).toBe('2026-08-14T03:00:00.000Z');
  });
});

describe('splitActivities', () => {
  it('splits a multi-stop night into short titles', () => {
    expect(splitActivities('Went to Venice and then met Griffin and Wes for drinks')).toEqual([
      'Went to Venice',
      'met Griffin and Wes for drinks',
    ]);
  });

  it('keeps a single activity as one short title', () => {
    expect(splitActivities('Dinner with Liam')).toEqual(['Dinner with Liam']);
  });

  it('clips a long blob instead of using it as a title', () => {
    const title = shortTitle(
      'I went to Venice Beach for a long walk along the boardwalk and then I met Griffin and Wes',
    );
    expect(title.length).toBeLessThanOrEqual(61);
    expect(title.startsWith('I went to Venice')).toBe(true);
  });
});
