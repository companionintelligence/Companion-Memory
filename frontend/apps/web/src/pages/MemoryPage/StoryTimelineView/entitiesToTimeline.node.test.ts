import { describe, expect, it } from 'vitest';

import type { EntityItem } from '../useEntityService';

import {
  buildMemoryTimelineData,
  isTimelineFilling,
  MEMORY_TIMELINE_MAX_SLIDES,
  shouldPrefetchBuffer,
} from './entitiesToTimeline';

const entity = (shape: Record<string, unknown>) => shape as unknown as EntityItem;

function eventAt(id: string, start: Date, title = id): EntityItem {
  return entity({
    __typename: 'EventType',
    id,
    bucketStartTime: start.toISOString(),
    bucketTimeSource: 'source',
    title,
    startTime: start.toISOString(),
    locationName: null,
    description: null,
    mediaContentType: null,
  });
}

describe('buildMemoryTimelineData', () => {
  const now = new Date(2026, 7, 18, 12);

  it('returns no slides when nothing is dated', () => {
    const { data } = buildMemoryTimelineData(
      [entity({ __typename: 'PersonType', id: 'p1' }), entity({ __typename: 'EventType', id: 'ingest', bucketTimeSource: 'ingest', bucketStartTime: now.toISOString() })],
      now,
    );

    expect(data.events).toEqual([]);
  });

  it('orders slides in time and lands nearest to now', () => {
    const { data, startAtSlide } = buildMemoryTimelineData(
      [
        eventAt('later', new Date(2026, 7, 20, 10), 'Later'),
        eventAt('earlier', new Date(2026, 7, 16, 10), 'Earlier'),
        eventAt('today', new Date(2026, 7, 18, 9), 'Today item'),
      ],
      now,
    );

    expect(data.events.map((slide) => slide.unique_id)).toEqual(['earlier', 'today', 'later']);
    expect(data.events[startAtSlide].unique_id).toBe('today');
    expect(data.title.text.headline).toMatch(/Aug/);
  });

  it('windows a long result set around now', () => {
    const flood = Array.from({ length: 80 }, (_, index) =>
      eventAt(`e-${index}`, new Date(2026, 6, 1 + index, 10), `Item ${index}`),
    );

    const { data, startAtSlide } = buildMemoryTimelineData(flood, now);

    expect(data.events).toHaveLength(MEMORY_TIMELINE_MAX_SLIDES);
    expect(data.events[startAtSlide].text.headline).toBe('Item 48');
  });

  it('attaches image previews and skips video embeds', () => {
    const { data } = buildMemoryTimelineData(
      [
        entity({
          __typename: 'EventType',
          id: 'photo',
          bucketStartTime: now.toISOString(),
          bucketTimeSource: 'source',
          title: 'A walk',
          startTime: now.toISOString(),
          galleryMediaContentType: 'image/jpeg',
          galleryPreviewUrl: '/files/preview.jpg',
          gallerySourceUrl: '/files/full.jpg',
        }),
        entity({
          __typename: 'EventType',
          id: 'clip',
          bucketStartTime: new Date(2026, 7, 18, 13).toISOString(),
          bucketTimeSource: 'source',
          title: 'A clip',
          startTime: new Date(2026, 7, 18, 13).toISOString(),
          galleryMediaContentType: 'video/mp4',
          galleryPreviewUrl: '/files/clip-preview.jpg',
          gallerySourceUrl: '/files/clip.mp4',
        }),
      ],
      now,
    );

    expect(data.events.find((slide) => slide.unique_id === 'photo')?.media?.url).toContain('preview.jpg');
    expect(data.events.find((slide) => slide.unique_id === 'clip')?.media).toBeUndefined();
  });

  it('keeps the full range and lands on the first slide when anchored at range-start', () => {
    const flood = Array.from({ length: 80 }, (_, index) =>
      eventAt(`e-${index}`, new Date(2026, 6, 1 + index, 10), `Item ${index}`),
    );

    const { data, startAtSlide, datedCount } = buildMemoryTimelineData(flood, now, {
      anchor: 'range-start',
    });

    expect(datedCount).toBe(80);
    expect(data.events).toHaveLength(80);
    expect(startAtSlide).toBe(0);
    expect(data.events[0]?.unique_id).toBe('e-0');
  });

  it('windows around a focused slide so the unfiltered buffer can follow navigation', () => {
    const flood = Array.from({ length: 80 }, (_, index) =>
      eventAt(`e-${index}`, new Date(2026, 6, 1 + index, 10), `Item ${index}`),
    );

    const { data, startAtSlide, focusIndex } = buildMemoryTimelineData(flood, now, {
      focusId: 'e-10',
    });

    expect(focusIndex).toBe(10);
    expect(data.events).toHaveLength(MEMORY_TIMELINE_MAX_SLIDES);
    expect(data.events[startAtSlide]?.unique_id).toBe('e-10');
    expect(data.events[0]?.unique_id).toBe('e-0');
  });
});

describe('shouldPrefetchBuffer', () => {
  it('prefetches older pages when the focus is near the start of the fetched set', () => {
    expect(
      shouldPrefetchBuffer({
        focusIndex: 2,
        datedCount: 48,
        hasNextPage: true,
        nextPageDirection: 'older',
      }),
    ).toBe(true);
    expect(
      shouldPrefetchBuffer({
        focusIndex: 40,
        datedCount: 48,
        hasNextPage: true,
        nextPageDirection: 'older',
      }),
    ).toBe(false);
  });

  it('prefetches newer pages when search is walking forward in time', () => {
    expect(
      shouldPrefetchBuffer({
        focusIndex: 45,
        datedCount: 48,
        hasNextPage: true,
        nextPageDirection: 'newer',
      }),
    ).toBe(true);
    expect(
      shouldPrefetchBuffer({
        focusIndex: 2,
        datedCount: 48,
        hasNextPage: true,
        nextPageDirection: 'newer',
      }),
    ).toBe(false);
  });
});

describe('isTimelineFilling', () => {
  const filling = {
    error: false,
    loading: false,
    hasNextPage: true,
    dataLength: 30,
    datedCount: 10,
    dateFiltered: false,
    fetchCap: 90,
  };

  it('keeps the skeleton up while the first unfiltered window is still short', () => {
    expect(isTimelineFilling(filling)).toBe(true);
  });

  it('stops filling when a page failed, even if more results remain', () => {
    expect(isTimelineFilling({ ...filling, error: true })).toBe(false);
  });

  it('does not treat a completed first page as still filling', () => {
    expect(isTimelineFilling({ ...filling, hasNextPage: false })).toBe(false);
    expect(isTimelineFilling({ ...filling, datedCount: MEMORY_TIMELINE_MAX_SLIDES })).toBe(false);
  });
});
