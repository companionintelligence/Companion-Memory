import { useEffect, useMemo, useRef } from 'react';

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

// Only these entity types render as timeline cards (EntityCard returns null for
// the rest), and all of them carry a domain timestamp — so filtering here keeps
// the timeline free of empty cards and undated groups.
const TIMELINE_TYPES: ReadonlySet<string> = new Set([
  'BrowserActivityType',
  'EventType',
  'CommunicationType',
]);

export function TimelineView() {
  const sentinelRef = useRef<HTMLDivElement>(null);

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

    return (
      <Empty
        title="No memories yet"
        description="Your timeline will fill in as memories are created."
        icon="🧠"
      />
    );
  }

  // One timeline segment: the vertical rail plus a dotted card per entity.
  const renderTimeline = (entities: EntityItem[]) => (
    <div className="relative pl-8 pt-2">
      <div className="absolute top-0 bottom-0 left-[14px] w-0.5 bg-border" />

      <div className="space-y-4">
        {entities.map((entity) => (
          <div key={entity.id} className="relative">
            <div className="absolute top-6 -left-4.25 h-4 w-4 -translate-x-1/2 rounded-full bg-[#179298]" />
            <EntityCard entity={entity} />
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <div className="space-y-6 py-2">
      {groups
        ? groups.map((group) => (
            <section key={group.key}>
              <DateGroupHeader label={group.label} count={group.entities.length} />
              {renderTimeline(group.entities)}
            </section>
          ))
        : renderTimeline(timelineData)}

      {loadingMore && <TimelineSkeleton count={2} className="pt-2" />}

      {hasNextPage && <div ref={sentinelRef} className="h-8" />}
    </div>
  );
}
