import { useCallback, useEffect, useMemo, useState } from 'react';

import { useSearchParams } from 'react-router-dom';

import { TimelineJsHost } from '@/components/TimelineJs';
import { useDateTimeFormat } from '@/hooks/useDateTimeFormat';

import {
  Empty,
  ErrorState,
  MemoryEmptyState,
  TimelineSkeleton,
  ViewCrashBoundary,
  formatLoadedCount,
  getEntityTimestamp,
  isChronologicalSort,
} from '../Components';
import { countActiveFilters } from '../Components/ExplorerToolbar/filterParams';
import { isDimensionActive } from '../Components/ExplorerToolbar/viewFilterSupport';
import { useEntityService } from '../useEntityService';

import {
  buildMemoryTimelineData,
  isTimelineFilling,
  MEMORY_TIMELINE_BUFFER_FETCH_CAP,
  MEMORY_TIMELINE_FETCH_CAP,
  MEMORY_TIMELINE_FILTERED_FETCH_CAP,
  MEMORY_TIMELINE_MAX_SLIDES,
  shouldPrefetchBuffer,
} from './entitiesToTimeline';

const TITLE_SLIDE_ID = 'memory-title';

export function StoryTimelineView() {
  const [searchParams] = useSearchParams();
  const filteredBrowse = countActiveFilters(searchParams) > 0 || Boolean(searchParams.get('search')?.trim());
  const dateFiltered = isDimensionActive(searchParams, 'date');
  const chronological = isChronologicalSort(
    searchParams.get('sortBy'),
    Boolean(searchParams.get('search')?.trim()),
  );
  const nextPageDirection: 'older' | 'newer' = searchParams.get('sortOrder') === 'asc' ? 'newer' : 'older';
  const sessionKey = searchParams.toString();

  const [{ data, loading, loadingMore, hasNextPage, loadMore, error, refetch }, { setActiveEntity }] =
    useEntityService();
  const fmt = useDateTimeFormat();
  const [focusId, setFocusId] = useState<string | null>(null);

  useEffect(() => {
    setFocusId(null);
  }, [sessionKey]);

  const datedCount = useMemo(
    () => data.filter((entity) => getEntityTimestamp(entity) != null).length,
    [data],
  );

  const fetchCap = dateFiltered ? MEMORY_TIMELINE_FILTERED_FETCH_CAP : MEMORY_TIMELINE_FETCH_CAP;

  // Date filter: pull every page in the closed range so the deck can start at
  // the beginning. Unfiltered: fill an initial window around now, then keep a
  // moving buffer as the user walks the axis.
  useEffect(() => {
    if (error || loading || loadingMore || !hasNextPage) {
      return;
    }

    if (dateFiltered) {
      if (data.length >= fetchCap) {
        return;
      }

      loadMore();

      return;
    }

    if (datedCount >= MEMORY_TIMELINE_MAX_SLIDES || data.length >= fetchCap) {
      return;
    }

    loadMore();
  }, [data.length, dateFiltered, datedCount, error, fetchCap, hasNextPage, loadMore, loading, loadingMore]);

  const {
    data: deck,
    startAtSlide,
    datedCount: datedInDeck,
    focusIndex,
  } = useMemo(
    () =>
      buildMemoryTimelineData(data, fmt, new Date(), {
        anchor: dateFiltered ? 'range-start' : 'now',
        focusId: dateFiltered ? null : focusId,
      }),
    [data, fmt, dateFiltered, focusId],
  );

  const filling = isTimelineFilling({
    error: Boolean(error),
    loading,
    hasNextPage,
    dataLength: data.length,
    datedCount,
    dateFiltered,
    fetchCap,
  });

  useEffect(() => {
    if (error || dateFiltered || filling || !chronological) {
      return;
    }

    if (loading || loadingMore || !hasNextPage) {
      return;
    }

    if (data.length >= MEMORY_TIMELINE_BUFFER_FETCH_CAP) {
      return;
    }

    if (
      shouldPrefetchBuffer({
        focusIndex,
        datedCount: datedInDeck,
        hasNextPage,
        nextPageDirection,
      })
    ) {
      loadMore();
    }
  }, [
    chronological,
    data.length,
    dateFiltered,
    datedInDeck,
    error,
    filling,
    focusIndex,
    hasNextPage,
    loadMore,
    loading,
    loadingMore,
    nextPageDirection,
  ]);

  const slideEntityId = useCallback(
    (uniqueId: string) => {
      if (uniqueId === TITLE_SLIDE_ID || uniqueId === deck.title.unique_id) {
        return deck.events[0]?.unique_id ?? null;
      }

      return uniqueId;
    },
    [deck.events, deck.title.unique_id],
  );

  const focusEntity = useCallback(
    (entityId: string) => {
      const entity = data.find((item) => item.id === entityId);
      if (entity) {
        setActiveEntity(entity);
      }
    },
    [data, setActiveEntity],
  );

  // Next/previous and keyboard only move the axis. Opening the shared detail
  // drawer is a separate gesture (click the slide or a time-axis marker).
  const handleSlideChange = useCallback(
    (uniqueId: string) => {
      const entityId = slideEntityId(uniqueId);
      if (entityId) {
        setFocusId(entityId);
      }
    },
    [slideEntityId],
  );

  const handleSlideOpen = useCallback(
    (uniqueId: string) => {
      const entityId = slideEntityId(uniqueId);
      if (!entityId) {
        return;
      }

      setFocusId(entityId);
      focusEntity(entityId);
    },
    [focusEntity, slideEntityId],
  );

  if (filling) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2" data-list-scroll="">
        <TimelineSkeleton count={5} />
      </div>
    );
  }

  if (error && (data.length === 0 || deck.events.length === 0)) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2" data-list-scroll="">
        <ErrorState onRetry={refetch} />
      </div>
    );
  }

  if (data.length === 0) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2" data-list-scroll="">
        <MemoryEmptyState filtered={filteredBrowse} />
      </div>
    );
  }

  if (deck.events.length === 0) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2" data-list-scroll="">
        <Empty
          title="No dated memories match this search"
          description="These results aren't time-based. Switch to List to see them."
          icon="🗂️"
        />
      </div>
    );
  }

  return (
    <div
      className="relative flex h-full min-h-[16rem] flex-1 flex-col overflow-hidden rounded-lg border bg-card/40 px-2 pb-2"
      data-testid="memory-timeline"
    >
      <ViewCrashBoundary
        resetKey={sessionKey}
        fallback={(retry) => (
          <ErrorState description="The timeline could not stay open. Try again." onRetry={retry} />
        )}
      >
        <TimelineJsHost
          data={deck}
          startAtSlide={startAtSlide}
          sessionKey={sessionKey}
          onSlideChange={handleSlideChange}
          onSlideOpen={handleSlideOpen}
          className="min-h-[16rem] flex-1"
        />
      </ViewCrashBoundary>

      <div className="z-20 flex shrink-0 justify-center px-2 py-1.5 device:pointer-events-none device:absolute device:bottom-4 device:left-1/2 device:-translate-x-1/2 device:px-0 device:py-0">
        <div className="pointer-events-auto flex items-center gap-2 rounded-md border border-border bg-card/90 px-3 py-1.5 text-xs text-muted-foreground shadow-md">
          <span>
            {formatLoadedCount({
              loaded: deck.events.length,
              totalCount: datedInDeck,
              loadingMore: error ? false : loadingMore,
              hasNextPage: error ? false : hasNextPage,
            })}
          </span>
          {error && (
            <button
              type="button"
              className="font-medium text-primary hover:underline"
              onClick={() => refetch()}
            >
              Retry
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
