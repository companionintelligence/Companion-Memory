import { describe, expect, it } from 'vitest';

import {
  combineDateAndClock,
  emptyEventDraft,
  eventDraftAt,
  eventDraftToInput,
  pointFromLatLng,
  validateEventDraft,
  type EventDraft,
} from './eventDraft';

function draft(overrides: Partial<EventDraft> = {}): EventDraft {
  return {
    ...emptyEventDraft(new Date(2026, 7, 19, 10, 0, 0)),
    title: 'Dinner with Sam',
    ...overrides,
  };
}

describe('emptyEventDraft', () => {
  it('rounds the start up to the next quarter hour and defaults to a one-hour event', () => {
    const value = emptyEventDraft(new Date(2026, 7, 19, 10, 7, 30));

    expect(value.startDate).toBe('2026-08-19');
    expect(value.startClock).toBe('10:15');
    expect(value.endDate).toBe('2026-08-19');
    expect(value.endClock).toBe('11:15');
  });

  it('dates from local time, not UTC — a late-evening event keeps its own day', () => {
    // 23:00 local is the NEXT day in UTC anywhere west of Greenwich, so a
    // toISOString-based date would show tomorrow in the picker.
    const value = emptyEventDraft(new Date(2026, 7, 19, 23, 0, 0));

    expect(value.startDate).toBe('2026-08-19');
  });

  it('rolls the end past midnight when the start is late', () => {
    const value = emptyEventDraft(new Date(2026, 7, 19, 23, 30, 0));

    expect(value.startClock).toBe('23:30');
    expect(value.endDate).toBe('2026-08-20');
    expect(value.endClock).toBe('00:30');
  });

  it('starts blank apart from the dates', () => {
    expect(emptyEventDraft()).toMatchObject({
      title: '',
      description: '',
      eventType: '',
      category: '',
      locationName: '',
      latitude: '',
      longitude: '',
      isAllDay: false,
    });
  });
});

describe('eventDraftAt', () => {
  it('keeps the snapped slot time rather than rounding up', () => {
    const value = eventDraftAt(new Date(2026, 7, 6, 16, 15, 0));

    expect(value.startDate).toBe('2026-08-06');
    expect(value.startClock).toBe('16:15');
    expect(value.endClock).toBe('17:15');
    expect(value.isAllDay).toBe(false);
  });

  it('opens an all-day draft on that local date', () => {
    const value = eventDraftAt(new Date(2026, 7, 6, 16, 15, 0), true);

    expect(value.startDate).toBe('2026-08-06');
    expect(value.isAllDay).toBe(true);
    expect(value.startClock).toBe('00:00');
  });
});

describe('combineDateAndClock', () => {
  it('builds a local-time date from the two fields', () => {
    const value = combineDateAndClock('2026-08-19', '14:30', false);

    expect(value?.getFullYear()).toBe(2026);
    expect(value?.getMonth()).toBe(7);
    expect(value?.getDate()).toBe(19);
    expect(value?.getHours()).toBe(14);
    expect(value?.getMinutes()).toBe(30);
  });

  it('ignores the clock for an all-day event and starts at local midnight', () => {
    const value = combineDateAndClock('2026-08-19', '14:30', true);

    expect(value?.getHours()).toBe(0);
    expect(value?.getMinutes()).toBe(0);
  });

  it('falls back to midnight rather than refusing a date with no clock', () => {
    expect(combineDateAndClock('2026-08-19', '', false)?.getHours()).toBe(0);
  });

  it('is null without a date', () => {
    expect(combineDateAndClock('', '14:30', false)).toBeNull();
    expect(combineDateAndClock('   ', '14:30', false)).toBeNull();
  });
});

describe('pointFromLatLng', () => {
  it('emits GeoJSON longitude-first', () => {
    expect(pointFromLatLng('37.7749', '-122.4194')).toEqual({
      type: 'Point',
      coordinates: [-122.4194, 37.7749],
    });
  });

  it('is null unless both parts are given', () => {
    expect(pointFromLatLng('37.7749', '')).toBeNull();
    expect(pointFromLatLng('', '-122.4194')).toBeNull();
  });

  it('rejects values outside the coordinate range', () => {
    expect(pointFromLatLng('91', '0')).toBeNull();
    expect(pointFromLatLng('0', '181')).toBeNull();
    expect(pointFromLatLng('north', '0')).toBeNull();
  });

  it('accepts zero — the null island is a real coordinate, not a blank', () => {
    expect(pointFromLatLng('0', '0')).toEqual({ type: 'Point', coordinates: [0, 0] });
  });
});

describe('validateEventDraft', () => {
  it('passes a filled-in draft', () => {
    expect(validateEventDraft(draft())).toBeNull();
  });

  it('requires a title', () => {
    expect(validateEventDraft(draft({ title: '   ' }))).toBe('title');
  });

  it('requires a start date', () => {
    expect(validateEventDraft(draft({ startDate: '' }))).toBe('startDate');
  });

  it('rejects an end before the start', () => {
    expect(validateEventDraft(draft({ startClock: '10:00', endClock: '09:00' }))).toBe('endBeforeStart');
  });

  it('allows a zero-length event', () => {
    expect(validateEventDraft(draft({ startClock: '10:00', endClock: '10:00' }))).toBeNull();
  });

  it('allows no end at all', () => {
    expect(validateEventDraft(draft({ endDate: '', endClock: '' }))).toBeNull();
  });

  it('rejects half a coordinate pair rather than dropping it silently', () => {
    expect(validateEventDraft(draft({ latitude: '37.7749' }))).toBe('coordinates');
    expect(validateEventDraft(draft({ longitude: '-122.4194' }))).toBe('coordinates');
  });

  it('rejects an out-of-range coordinate', () => {
    expect(validateEventDraft(draft({ latitude: '120', longitude: '0' }))).toBe('coordinates');
  });
});

describe('eventDraftToInput', () => {
  it('sends the times as ISO strings and derives the duration', () => {
    const input = eventDraftToInput(
      draft({ startDate: '2026-08-19', startClock: '10:00', endDate: '2026-08-19', endClock: '11:30' }),
    );

    expect(input.startTime).toBe(new Date(2026, 7, 19, 10, 0).toISOString());
    expect(input.endTime).toBe(new Date(2026, 7, 19, 11, 30).toISOString());
    expect(input.durationMinutes).toBe(90);
  });

  it('omits blank optional fields instead of sending empty strings', () => {
    const input = eventDraftToInput(draft());

    expect(input.description).toBeUndefined();
    expect(input.category).toBeUndefined();
    expect(input.locationName).toBeUndefined();
    expect(input.locationCoordinates).toBeUndefined();
  });

  it('leaves eventType unset when blank — that is what puts it on the schedule', () => {
    expect(eventDraftToInput(draft()).eventType).toBeUndefined();
    expect(eventDraftToInput(draft({ eventType: 'meeting' })).eventType).toBe('meeting');
  });

  it('trims what it does send', () => {
    const input = eventDraftToInput(draft({ title: '  Dinner  ', locationName: '  Zuni  ' }));

    expect(input.title).toBe('Dinner');
    expect(input.locationName).toBe('Zuni');
  });

  it('drops the end and the duration when there is no end date', () => {
    const input = eventDraftToInput(draft({ endDate: '', endClock: '' }));

    expect(input.endTime).toBeUndefined();
    expect(input.durationMinutes).toBeUndefined();
  });

  it('starts an all-day event at local midnight and flags it', () => {
    const input = eventDraftToInput(draft({ isAllDay: true, startDate: '2026-08-19', startClock: '14:30' }));

    expect(input.isAllDay).toBe(true);
    expect(input.startTime).toBe(new Date(2026, 7, 19, 0, 0).toISOString());
  });

  it('attaches coordinates as a GeoJSON point', () => {
    const input = eventDraftToInput(draft({ latitude: '37.7749', longitude: '-122.4194' }));

    expect(input.locationCoordinates).toEqual({ type: 'Point', coordinates: [-122.4194, 37.7749] });
  });

  it('throws rather than posting an undated event', () => {
    expect(() => eventDraftToInput(draft({ startDate: '' }))).toThrow(/start date/i);
  });
});
