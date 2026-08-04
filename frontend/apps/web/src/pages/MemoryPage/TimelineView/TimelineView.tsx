import { useCallback, useEffect, useMemo, useRef } from 'react';

import { cn } from '@ci/shadcn';
import { useSearchParams } from 'react-router-dom';

import { useEntityService, type EntityItem } from '../../MemoryPage/useEntityService';
import {
  DateGroupHeader,
  Empty,
  EntityCard,
  ErrorState,
  TimelineSkeleton,
  groupEntitiesByBucket,
  isChronologicalSort,
} from '../Components';
import { countActiveFilters } from '../Components/ExplorerToolbar/filterParams';

// Only these entity types render as timeline cards (EntityCard returns null for
// the rest), and all of them carry a domain timestamp — so filtering here keeps
// the timeline free of empty cards and undated groups.
const TIMELINE_TYPES: ReadonlySet<string> = new Set([
  'BrowserActivityType',
  'EventType',
  'CommunicationType',
]);

interface TimelineViewProps {
  activeEntityId?: string | null;
  onEntityHover?: (entity: EntityItem | null) => void;
  onEntitySelect?: (entity: EntityItem) => void;
  registerTimelineRow?: (entityId: string, element: HTMLDivElement | null) => void;
}

export function TimelineView({
  activeEntityId,
  onEntityHover,
  onEntitySelect,
  registerTimelineRow,
}: TimelineViewProps = {}) {
  const sentinelRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef(new globalThis.Map<string, HTMLDivElement>());

  const [{ data, loading, loadingMore, hasNextPage, loadMore, error, refetch }] = useEntityService();

  const timelineData = useMemo(() => data.filter((entity) => TIMELINE_TYPES.has(entity.__typename)), [data]);

  // Shared bucketing keeps the Today / Yesterday / This Week / … headers
  // identical to the List view — but only while results stay in chronological
  // order. Relevance/name sorts interleave dates, so we render one continuous,
  // header-less timeline there instead of repeated, out-of-order headers.
  const [searchParams] = useSearchParams();
  const grouped = isChronologicalSort(
    searchParams.get('sortBy'),
    Boolean(searchParams.get('search')?.trim()),
  );
  const groups = useMemo(
    () => (grouped ? groupEntitiesByBucket(timelineData) : null),
    [grouped, timelineData],
  );

  // Load the next server page when the sentinel nears the viewport. Using the
  // viewport as root keeps this working regardless of which ancestor scrolls.
  useEffect(() => {
    const sentinel = sentinelRef.current;

    if (!sentinel || !hasNextPage) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          loadMore();
        }
      },
      { rootMargin: '400px' },
    );

    observer.observe(sentinel);

    return () => observer.disconnect();
  }, [hasNextPage, loadMore]);

  useEffect(() => {
    if (!activeEntityId) {
      return;
    }

    rowRefs.current.get(activeEntityId)?.scrollIntoView({
      behavior: 'smooth',
      block: 'nearest',
    });
  }, [activeEntityId]);

  const setRowRef = useCallback(
    (entityId: string) => (element: HTMLDivElement | null) => {
      if (element) {
        rowRefs.current.set(entityId, element);
      } else {
        rowRefs.current.delete(entityId);
      }

      registerTimelineRow?.(entityId, element);
    },
    [registerTimelineRow],
  );

  if (loading && timelineData.length === 0) {
    return (
      <div className="py-2">
        <TimelineSkeleton count={5} />
      </div>
    );
  }

  if (error && timelineData.length === 0) {
    return <ErrorState onRetry={refetch} />;
  }

  if (timelineData.length === 0) {
    const isMapView = searchParams.get('view') === 'map';

    // Results exist but none are timeline-renderable types — distinguish this
    // from a truly empty result so the user knows to switch to the List view.
    if (data.length > 0) {
      return (
        <Empty
          title="No timeline events match this search"
          description="These results aren't time-based. Switch to List to see them."
          icon="🗂️"
        />
      );
    }

    // Distinguish a genuinely empty memory from one the user has filtered down to
    // nothing — on the map, the auto-applied "Located" filter is a common cause.
    const hasFilters = countActiveFilters(searchParams) > 0 || Boolean(searchParams.get('search')?.trim());

    if (hasFilters) {
      return (
        <Empty
          title="No memories match these filters"
          description={
            isMapView
              ? 'Try removing a filter, or clear Located, to see more.'
              : 'Try removing a filter (or the Located filter on the map) to see more.'
          }
          icon="🔍"
        />
      );
    }

    return (
      <Empty
        title="No memories yet"
        description="Your timeline will fill in as memories are created."
        icon="🧠"
      />
    );
  }

  const renderTimelineRows = (entities: EntityItem[]) => (
    <div className="space-y-4">
      {entities.map((entity) => {
        const active = activeEntityId === entity.id;

        return (
          <div
            key={entity.id}
            ref={setRowRef(entity.id)}
            className={cn(
              'relative rounded-md transition-shadow duration-150',
              active && 'ring-2 ring-[#58ebbf]/80 ring-offset-0',
            )}
            onClickCapture={() => onEntitySelect?.(entity)}
            onMouseEnter={() => onEntityHover?.(entity)}
            onMouseLeave={() => onEntityHover?.(null)}
          >
            <div
              className={cn(
                'absolute left-[-18px] top-1/2 h-4 w-4 -translate-x-1/2 -translate-y-1/2 rounded-full',
                active
                  ? 'bg-[#82ffe1] ring-2 ring-[#58ebbf]/60 shadow-glow-ci'
                  : 'bg-[#58ebbf] shadow-glow-ci',
              )}
            />
            <EntityCard entity={entity} />
          </div>
        );
      })}
    </div>
  );

  return (
    <div className="relative py-2">
      <div className="relative">
        <div className="absolute bottom-0 left-[14px] top-0 w-0.5 bg-border" />

        <div className="space-y-6">
          {groups ? (
            groups.map((group) => (
              <section key={group.key}>
                <DateGroupHeader label={group.label} count={group.entities.length} align="right" />
                <div className="pl-8 pt-2">{renderTimelineRows(group.entities)}</div>
              </section>
            ))
          ) : (
            <div className="pl-8 pt-2">{renderTimelineRows(timelineData)}</div>
          )}
        </div>

        {loadingMore && <TimelineSkeleton count={2} className="pl-8 pt-2" />}

        {hasNextPage && <div ref={sentinelRef} className="h-8" />}
      </div>
    </div>
  );
}
