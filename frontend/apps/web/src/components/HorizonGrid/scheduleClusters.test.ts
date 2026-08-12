import { describe, expect, it } from 'vitest';

import type { ScheduleEvent } from '@/api/useScheduleService';

import {
  CLUSTER_CHIP_WIDTH_PCT,
  MICRO_CHIP_MAX_WIDTH_PCT,
  foldMicroClusters,
  isBrowserCapture,
  isMicroSpan,
  packItemLanes,
  unpackToSingles,
  type EventSpan,
} from './scheduleClusters';

function event(overrides: Partial<ScheduleEvent> = {}): ScheduleEvent {
  return {
    id: 'e1',
    title: 'Visit',
    description: null,
    startTime: new Date(2026, 7, 11, 0, 0).toISOString(),
    endTime: new Date(2026, 7, 11, 0, 1).toISOString(),
    isAllDay: false,
    status: 'confirmed',
    category: null,
    locationName: null,
    sourceSystem: 'ci-browser-extension',
    metadata: { url: 'https://example.com' },
    ...overrides,
  };
}

function span(overrides: Partial<EventSpan> & { event?: ScheduleEvent }): EventSpan {
  return {
    event: overrides.event ?? event(),
    leftPct: 0,
    widthPct: 2,
    continuesFrom: false,
    continuesTo: false,
    ...overrides,
  };
}

describe('isBrowserCapture', () => {
  it('recognises extension sources', () => {
    expect(isBrowserCapture(event())).toBe(true);
    expect(isBrowserCapture(event({ sourceSystem: 'google_calendar' }))).toBe(false);
  });
});

describe('foldMicroClusters', () => {
  it('merges browser ticks in the same half-hour into one stack', () => {
    const piled = Array.from({ length: 40 }, (_, i) =>
      span({
        event: event({ id: `b-${i}`, title: `Tab ${i}` }),
        leftPct: 1 + i * 0.01,
        widthPct: 1.4,
      }),
    );

    const packed = foldMicroClusters(piled);

    expect(packed).toHaveLength(1);
    expect(packed[0]?.kind).toBe('cluster');
    if (packed[0]?.kind === 'cluster') {
      expect(packed[0].spans).toHaveLength(40);
      expect(packed[0].widthPct).toBe(CLUSTER_CHIP_WIDTH_PCT);
    }
  });

  it('does not fuse a day-long chain of browser ticks into one bar', () => {
    const chain = Array.from({ length: 48 }, (_, i) =>
      span({
        event: event({ id: `h-${i}` }),
        leftPct: (i / 48) * 100,
        widthPct: 3,
      }),
    );

    const packed = foldMicroClusters(chain);

    expect(packed.length).toBeGreaterThan(10);
    for (const item of packed) {
      expect(item.widthPct).toBeLessThanOrEqual(MICRO_CHIP_MAX_WIDTH_PCT + 0.01);
    }
  });

  it('caps a lone browser event with a huge painted width', () => {
    const packed = foldMicroClusters([
      span({
        leftPct: 10,
        widthPct: 80,
        event: event({ id: 'wide-capture' }),
      }),
    ]);

    expect(packed).toHaveLength(1);
    expect(packed[0]?.widthPct).toBeLessThanOrEqual(MICRO_CHIP_MAX_WIDTH_PCT);
  });

  it('keeps a wide meeting solo next to a browser pile', () => {
    const packed = foldMicroClusters([
      span({ leftPct: 10, widthPct: 2, event: event({ id: 'b1' }) }),
      span({
        leftPct: 10.5,
        widthPct: 2,
        event: event({ id: 'b2', title: 'Other' }),
      }),
      span({
        leftPct: 37.5,
        widthPct: 12,
        event: event({
          id: 'm1',
          title: 'Standup',
          sourceSystem: 'google_calendar',
          endTime: new Date(2026, 7, 11, 10, 0).toISOString(),
        }),
      }),
    ]);

    expect(packed.map((p) => p.kind)).toEqual(['cluster', 'single']);
    expect(isMicroSpan(span({ widthPct: 12, event: event({ sourceSystem: 'google_calendar' }) }))).toBe(
      false,
    );
  });

  it('packs a folded midnight pile into a single lane', () => {
    const piled = Array.from({ length: 90 }, (_, i) =>
      span({
        event: event({ id: `n-${i}` }),
        leftPct: 0.5,
        widthPct: 1.5,
      }),
    );
    const packed = foldMicroClusters(piled);
    const lanes = packItemLanes(packed);

    expect(packed).toHaveLength(1);
    expect(lanes).toEqual([0]);
  });
});

describe('unpackToSingles', () => {
  it('turns a folded pile back into one chip per visit', () => {
    const piled = Array.from({ length: 12 }, (_, i) =>
      span({
        event: event({ id: `u-${i}` }),
        leftPct: 2 + i * 0.05,
        widthPct: 1.5,
      }),
    );

    expect(foldMicroClusters(piled)).toHaveLength(1);
    expect(unpackToSingles(piled)).toHaveLength(12);
  });
});
