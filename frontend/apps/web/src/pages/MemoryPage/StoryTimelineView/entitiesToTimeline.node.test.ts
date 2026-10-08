import { describe, expect, it } from 'vitest';

import { createDateTimeFormatter, DEVICE_DATE_TIME_FORMATTER } from '@/lib/dateTimeFormat';

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
      [
        entity({ __typename: 'PersonType', id: 'p1' }),
        entity({
          __typename: 'EventType',
          id: 'ingest',
          bucketTimeSource: 'ingest',
          bucketStartTime: now.toISOString(),
        }),
      ],
      DEVICE_DATE_TIME_FORMATTER,
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
      DEVICE_DATE_TIME_FORMATTER,
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

    const { data, startAtSlide } = buildMemoryTimelineData(flood, DEVICE_DATE_TIME_FORMATTER, now);

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
      DEVICE_DATE_TIME_FORMATTER,
      now,
    );

    expect(data.events.find((slide) => slide.unique_id === 'photo')?.media?.url).toContain('preview.jpg');
    expect(data.events.find((slide) => slide.unique_id === 'clip')?.media).toBeUndefined();
  });

  it('leaves out a media address that could break out of the markup TimelineJS builds from it', () => {
    // TimelineJS reads any URL containing `.pdf` as a PDF and writes it into
    // `<iframe src='…'>` by string concatenation.
    const { data } = buildMemoryTimelineData(
      [
        entity({
          __typename: 'EventType',
          id: 'planted',
          bucketStartTime: now.toISOString(),
          bucketTimeSource: 'source',
          title: 'A scan',
          startTime: now.toISOString(),
          galleryMediaContentType: 'image/jpeg',
          galleryPreviewUrl: "https://files.example/scan.pdf'onload='alert(1)",
          gallerySourceUrl: null,
        }),
      ],
      DEVICE_DATE_TIME_FORMATTER,
      now,
    );

    expect(data.events.find((slide) => slide.unique_id === 'planted')?.media).toBeUndefined();
  });

  it('leaves out a third-party media address even with no quote in it', () => {
    // TimelineJS's Wikipedia type takes the host from anything before `.wikipedia` and
    // appends a JSONP <script> from it to the document.
    const { data } = buildMemoryTimelineData(
      [
        entity({
          __typename: 'EventType',
          id: 'remote',
          bucketStartTime: now.toISOString(),
          bucketTimeSource: 'source',
          title: 'A picture',
          startTime: now.toISOString(),
          galleryMediaContentType: 'image/jpeg',
          galleryPreviewUrl: 'https://files.example/x.wikipedia.org/wiki/a.png',
          gallerySourceUrl: null,
        }),
      ],
      DEVICE_DATE_TIME_FORMATTER,
      now,
    );

    const slide = data.events.find((event) => event.unique_id === 'remote');
    expect(slide).toBeDefined();
    expect(slide?.media).toBeUndefined();
  });

  it("leaves out a link signed as a download, whose query carries the file's name", () => {
    // TimelineJS matches `spotify` anywhere in the address, query included.
    const download =
      '/ci-files/0b3f7c1e-0d2a-4c55-9a43-6a2d5f0e9c11?response-content-disposition=attachment%3B%20filename%3D%22spotify.svg%22&response-content-type=image%2Fsvg%2Bxml&X-Amz-Signature=abc';
    const inline =
      '/ci-files/6f1c2d3e-4b5a-4c69-8d7e-9f0a1b2c3d4e?response-content-type=image%2Fjpeg&X-Amz-Signature=def';
    const { data } = buildMemoryTimelineData(
      [
        entity({
          __typename: 'EventType',
          id: 'svg',
          bucketStartTime: now.toISOString(),
          bucketTimeSource: 'source',
          title: 'A drawing',
          startTime: now.toISOString(),
          galleryMediaContentType: 'image/svg+xml',
          galleryPreviewUrl: download,
          gallerySourceUrl: null,
        }),
        entity({
          __typename: 'EventType',
          id: 'photo',
          bucketStartTime: new Date(now.getTime() - 60_000).toISOString(),
          bucketTimeSource: 'source',
          title: 'A photo',
          startTime: new Date(now.getTime() - 60_000).toISOString(),
          galleryMediaContentType: 'image/jpeg',
          galleryPreviewUrl: inline,
          gallerySourceUrl: null,
        }),
      ],
      DEVICE_DATE_TIME_FORMATTER,
      now,
    );

    expect(data.events.find((event) => event.unique_id === 'svg')?.media).toBeUndefined();
    expect(data.events.find((event) => event.unique_id === 'photo')?.media?.url).toBe(`/static${inline}`);
  });

  it('keeps the full range and lands on the first slide when anchored at range-start', () => {
    const flood = Array.from({ length: 80 }, (_, index) =>
      eventAt(`e-${index}`, new Date(2026, 6, 1 + index, 10), `Item ${index}`),
    );

    const { data, startAtSlide, datedCount } = buildMemoryTimelineData(
      flood,
      DEVICE_DATE_TIME_FORMATTER,
      now,
      {
        anchor: 'range-start',
      },
    );

    expect(datedCount).toBe(80);
    expect(data.events).toHaveLength(80);
    expect(startAtSlide).toBe(0);
    expect(data.events[0]?.unique_id).toBe('e-0');
  });

  it('windows around a focused slide so the unfiltered buffer can follow navigation', () => {
    const flood = Array.from({ length: 80 }, (_, index) =>
      eventAt(`e-${index}`, new Date(2026, 6, 1 + index, 10), `Item ${index}`),
    );

    const { data, startAtSlide, focusIndex } = buildMemoryTimelineData(
      flood,
      DEVICE_DATE_TIME_FORMATTER,
      now,
      {
        focusId: 'e-10',
      },
    );

    expect(focusIndex).toBe(10);
    expect(data.events).toHaveLength(MEMORY_TIMELINE_MAX_SLIDES);
    expect(data.events[startAtSlide]?.unique_id).toBe('e-10');
    expect(data.events[0]?.unique_id).toBe('e-0');
  });

  it("writes each slide's time in the person's time format and zone", () => {
    const at = new Date('2026-08-18T22:43:00Z'); // 15:43 in Los Angeles
    const deck = (timeFormat: 'h12' | 'h23') =>
      buildMemoryTimelineData(
        [
          eventAt('walk', at, 'Walk'),
          entity({
            __typename: 'CommunicationType',
            id: 'mail',
            bucketTime: at.toISOString(),
            subject: 'Hello',
          }),
          entity({
            __typename: 'BrowserActivityType',
            id: 'page',
            bucketTime: at.toISOString(),
            title: 'Docs',
          }),
        ],
        createDateTimeFormatter({ timeFormat, timeZone: 'America/Los_Angeles' }),
        at,
      ).data.events.map((slide) => slide.text.text);

    expect(deck('h23')).toEqual([
      expect.stringMatching(/^15:43/),
      expect.stringMatching(/^15:43/),
      expect.stringMatching(/^15:43/),
    ]);
    expect(deck('h12')).toEqual([
      expect.stringMatching(/^3:43\sPM/),
      expect.stringMatching(/^3:43\sPM/),
      expect.stringMatching(/^3:43\sPM/),
    ]);
  });
});

describe('buildMemoryTimelineData: third-party text', () => {
  const at = new Date(2026, 7, 18, 12);
  const markup = '<b>x</b><style>body{display:none}</style>';
  const escaped = '&lt;b&gt;x&lt;/b&gt;&lt;style&gt;body{display:none}&lt;/style&gt;';

  /** Every string the deck hands TimelineJS, which writes them as HTML. */
  function htmlFields(slide: { text: { headline: string; text: string }; media?: { caption?: string } }) {
    return [slide.text.headline, slide.text.text, slide.media?.caption ?? ''];
  }

  it('escapes an email subject, preview and sender before TimelineJS sees them', () => {
    const { data } = buildMemoryTimelineData(
      [
        entity({
          __typename: 'CommunicationType',
          id: 'mail',
          bucketTime: at.toISOString(),
          subject: `Invoice ${markup}`,
          preview: `Preview ${markup}`,
          from: { name: `Sender ${markup}` },
        }),
      ],
      DEVICE_DATE_TIME_FORMATTER,
      at,
    );

    const [slide] = data.events;
    expect(slide.text.headline).toBe(`Invoice ${escaped}`);
    expect(slide.text.text).toContain(`From Sender ${escaped}`);
    expect(slide.text.text).toContain(`Preview ${escaped}`);
    expect(htmlFields(slide).join('')).not.toContain('<');
  });

  it('escapes a page title and its URL', () => {
    const { data } = buildMemoryTimelineData(
      [
        entity({
          __typename: 'BrowserActivityType',
          id: 'page',
          bucketTime: at.toISOString(),
          title: `Title ${markup}`,
          url: 'https://example.com/?q=<i>',
        }),
      ],
      DEVICE_DATE_TIME_FORMATTER,
      at,
    );

    expect(data.events[0].text.headline).toBe(`Title ${escaped}`);
    expect(htmlFields(data.events[0]).join('')).not.toContain('<');
  });

  it('escapes an event title, place and description, and the image caption', () => {
    const { data } = buildMemoryTimelineData(
      [
        entity({
          __typename: 'EventType',
          id: 'invite',
          bucketStartTime: at.toISOString(),
          bucketTimeSource: 'source',
          title: `Party ${markup}`,
          startTime: at.toISOString(),
          locationName: `Hall ${markup}`,
          description: `Bring ${markup}`,
          galleryMediaContentType: 'image/jpeg',
          galleryPreviewUrl: '/files/preview.jpg',
          gallerySourceUrl: '/files/full.jpg',
        }),
      ],
      DEVICE_DATE_TIME_FORMATTER,
      at,
    );

    const [slide] = data.events;
    expect(slide.media?.caption).toContain(escaped);
    expect(slide.text.text).toContain(`Hall ${escaped}`);
    expect(slide.text.text).toContain(`Bring ${escaped}`);
    expect(htmlFields(slide).join('')).not.toContain('<');
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
