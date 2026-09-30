import { axisPadEraFromRange, partsOf } from '@/components/TimelineJs/dates';
import type { TimelineJsData, TimelineSlide } from '@/components/TimelineJs/types';
import { useFragment as readFragment } from '@/graphql';
import { HOUR_MINUTE, type DateTimeFormatter } from '@/lib/dateTimeFormat';

import { BROWSER_ACTIVITY_FRAGMENT } from '../Components/EntityCard/BrowserActivityCard';
import { COMMUNICATION_FRAGMENT } from '../Components/EntityCard/CommunicationCard';
import { EVENT_FRAGMENT } from '../Components/EntityCard/EventCard';
import { eventDisplayTitle, getEntityTimestamp } from '../Components/utils';
import { getEntityMedia } from '../GalleryView/media';
import type { EntityItem } from '../useEntityService';

/**
 * TimelineJS mounts every slide in the DOM. The explorer page is 30 rows; we
 * pull a couple of pages then cap so a long Memory does not become a novel.
 */
export const MEMORY_TIMELINE_MAX_SLIDES = 48;

/** Stop the *initial* unfiltered fetch once this many search rows are in hand. */
export const MEMORY_TIMELINE_FETCH_CAP = 90;

/** Load the next page when the focused slide is this close to the fetched edge. */
export const MEMORY_TIMELINE_PREFETCH_SLIDES = 12;

/**
 * Unfiltered browsing can keep paging as the user walks the axis. Hard stop so
 * a decade of memory cannot mount itself into TimelineJS.
 */
export const MEMORY_TIMELINE_BUFFER_FETCH_CAP = 400;

/** Date-filtered decks fetch the whole range, with this safety cap. */
export const MEMORY_TIMELINE_FILTERED_FETCH_CAP = 240;

interface DatedSlide {
  time: Date;
  slide: TimelineSlide;
}

function closestIndex(times: readonly Date[], now: Date): number {
  let best = 0;
  let bestDelta = Number.POSITIVE_INFINITY;

  for (let i = 0; i < times.length; i += 1) {
    const delta = Math.abs(times[i].getTime() - now.getTime());
    if (delta < bestDelta) {
      best = i;
      bestDelta = delta;
    }
  }

  return best;
}

function selectAroundTime(dated: readonly DatedSlide[], focus: Date, max: number): DatedSlide[] {
  if (dated.length <= max) {
    return [...dated];
  }

  const at = closestIndex(
    dated.map((item) => item.time),
    focus,
  );
  const half = Math.floor(max / 2);
  let start = Math.max(0, at - half);
  let end = start + max;
  if (end > dated.length) {
    end = dated.length;
    start = end - max;
  }

  return dated.slice(start, end);
}

function rangeHeadline(first: Date, last: Date): string {
  if (first.toDateString() === last.toDateString()) {
    return first.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  }

  const sameYear = first.getFullYear() === last.getFullYear();
  const from = first.toLocaleDateString([], {
    month: 'short',
    day: 'numeric',
    year: sameYear ? undefined : 'numeric',
  });
  const to = last.toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });

  return `${from} – ${to}`;
}

function imageMediaUrl(entity: EntityItem): string | undefined {
  const media = getEntityMedia(entity);
  if (media?.kind !== 'image') {
    return undefined;
  }

  return media.thumbUrl ?? media.fullUrl;
}

function slideFromEntity(entity: EntityItem, fmt: DateTimeFormatter): DatedSlide | null {
  const time = getEntityTimestamp(entity);
  if (!time) {
    return null;
  }

  switch (entity.__typename) {
    case 'EventType': {
      const data = readFragment(EVENT_FRAGMENT, entity);
      const headline = eventDisplayTitle({
        title: data.title,
        startTime: data.startTime,
        locationName: data.locationName,
        mediaContentType: data.mediaContentType,
      });
      const when = fmt.time(time, HOUR_MINUTE);
      const bodyBits = [
        when,
        data.locationName,
        data.description && data.description.trim() !== headline.trim() ? data.description.trim() : null,
      ].filter(Boolean);
      const end = data.endTime ? new Date(data.endTime) : null;
      const image = imageMediaUrl(entity);
      const slide: TimelineSlide = {
        start_date: partsOf(time),
        text: { headline: headline || 'Untitled', text: bodyBits.join(' · ') },
        unique_id: data.id,
        autolink: false,
      };

      if (end && !Number.isNaN(end.getTime()) && end.getTime() !== time.getTime()) {
        slide.end_date = partsOf(end);
      }

      if (image) {
        slide.media = { url: image, caption: headline };
      }

      return { time, slide };
    }

    case 'CommunicationType': {
      const data = readFragment(COMMUNICATION_FRAGMENT, entity);
      const fromName = data.from?.name?.trim();
      const headline = data.subject?.trim() || data.preview?.trim() || 'Message';
      const bodyBits = [
        fmt.time(time, HOUR_MINUTE),
        fromName ? `From ${fromName}` : null,
        data.subject?.trim() ? data.preview?.trim() : null,
      ].filter(Boolean);

      return {
        time,
        slide: {
          start_date: partsOf(time),
          text: { headline, text: bodyBits.join(' · ') },
          unique_id: data.id,
          autolink: false,
        },
      };
    }

    case 'BrowserActivityType': {
      const data = readFragment(BROWSER_ACTIVITY_FRAGMENT, entity);
      const headline = data.title?.trim() || 'Untitled page';
      const durationSeconds = typeof data.duration === 'number' ? data.duration : 0;
      const bodyBits = [fmt.time(time, HOUR_MINUTE), data.url].filter(Boolean);
      const slide: TimelineSlide = {
        start_date: partsOf(time),
        text: { headline, text: bodyBits.join(' · ') },
        unique_id: data.id,
        autolink: false,
      };

      if (durationSeconds > 0) {
        slide.end_date = partsOf(new Date(time.getTime() + durationSeconds * 1000));
      }

      return { time, slide };
    }

    default:
      return null;
  }
}

export type MemoryTimelineAnchor = 'now' | 'range-start';

export interface MemoryTimelineOptions {
  /**
   * `range-start` keeps every dated slide and lands on the first — a When
   * filter is a closed range, not a window around today.
   */
  anchor?: MemoryTimelineAnchor;
  /** Window around this slide so the unfiltered buffer can follow navigation. */
  focusId?: string | null;
  maxSlides?: number;
}

export interface MemoryTimelineDeck {
  data: TimelineJsData;
  startAtSlide: number;
  datedCount: number;
  /** Index of the focused slide in the full dated set (oldest = 0). */
  focusIndex: number;
}

/**
 * Whether the next explorer page should be pulled to keep the unfiltered
 * buffer ahead of the playhead. Search pages in one direction (older when
 * newest-first, newer when oldest-first).
 */
export function shouldPrefetchBuffer({
  focusIndex,
  datedCount,
  hasNextPage,
  nextPageDirection,
  prefetchWithin = MEMORY_TIMELINE_PREFETCH_SLIDES,
}: {
  focusIndex: number;
  datedCount: number;
  hasNextPage: boolean;
  nextPageDirection: 'older' | 'newer';
  prefetchWithin?: number;
}): boolean {
  if (!hasNextPage || focusIndex < 0 || datedCount === 0) {
    return false;
  }

  if (nextPageDirection === 'older') {
    return focusIndex < prefetchWithin;
  }

  return focusIndex >= datedCount - prefetchWithin;
}

/**
 * Whether the Timeline tab should keep the skeleton up while it fills an
 * initial deck. A failed page must not count as "still filling" — that hid
 * ErrorState behind an endless placeholder after the first page succeeded.
 */
export function isTimelineFilling({
  error,
  loading,
  hasNextPage,
  dataLength,
  datedCount,
  dateFiltered,
  fetchCap,
  maxSlides = MEMORY_TIMELINE_MAX_SLIDES,
}: {
  error: boolean;
  loading: boolean;
  hasNextPage: boolean;
  dataLength: number;
  datedCount: number;
  dateFiltered: boolean;
  fetchCap: number;
  maxSlides?: number;
}): boolean {
  if (error) {
    return false;
  }

  if (loading && dataLength === 0) {
    return true;
  }

  if (!hasNextPage || dataLength >= fetchCap) {
    return false;
  }

  return dateFiltered || datedCount < maxSlides;
}

/**
 * TimelineJS deck from the explorer's current result page(s).
 *
 * Dated Event / Communication / BrowserActivity rows become slides, sorted in
 * time. Unfiltered decks window around `now` (or `focusId`) when there are more
 * than {@link MEMORY_TIMELINE_MAX_SLIDES}. A date-filtered deck (`anchor:
 * 'range-start'`) keeps the whole range and lands on its first slide.
 */
export function buildMemoryTimelineData(
  entities: readonly EntityItem[],
  fmt: DateTimeFormatter,
  now = new Date(),
  options: MemoryTimelineOptions = {},
): MemoryTimelineDeck {
  const { anchor = 'now', focusId = null, maxSlides = MEMORY_TIMELINE_MAX_SLIDES } = options;
  const dated = entities
    .map((entity) => slideFromEntity(entity, fmt))
    .filter((item): item is DatedSlide => item != null)
    .sort((a, b) => a.time.getTime() - b.time.getTime());

  const empty: MemoryTimelineDeck = {
    startAtSlide: 0,
    datedCount: 0,
    focusIndex: -1,
    data: {
      scale: 'human',
      title: {
        unique_id: 'memory-title',
        start_date: partsOf(now),
        text: { headline: 'Timeline', text: '' },
      },
      events: [],
    },
  };

  if (dated.length === 0) {
    return empty;
  }

  const focused = (focusId && dated.find((item) => item.slide.unique_id === focusId)) || null;
  const focusTime = focused?.time ?? now;
  const focusIndex = closestIndex(
    dated.map((item) => item.time),
    focusTime,
  );

  const selected =
    anchor === 'range-start' || dated.length <= maxSlides
      ? [...dated]
      : selectAroundTime(dated, focusTime, maxSlides);

  const startAtSlide =
    anchor === 'range-start'
      ? 0
      : closestIndex(
          selected.map((item) => item.time),
          focusTime,
        );
  const first = selected[0].time;
  const last = selected[selected.length - 1].time;

  return {
    startAtSlide,
    datedCount: dated.length,
    focusIndex,
    data: {
      scale: 'human',
      title: {
        unique_id: 'memory-title',
        start_date: partsOf(first),
        text: {
          headline: rangeHeadline(first, last),
          text: 'Move along the timeline to walk through these memories.',
        },
      },
      events: selected.map((item) => item.slide),
      eras: [axisPadEraFromRange(first, last)],
    },
  };
}
