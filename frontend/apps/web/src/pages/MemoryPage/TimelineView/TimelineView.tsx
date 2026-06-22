import { useEffect, useMemo, useRef } from 'react';

import { useEntityService } from '../../MemoryPage/useEntityService';
import {
  DateGroupHeader,
  Empty,
  EntityCard,
  ErrorState,
  TimelineSkeleton,
  groupEntitiesByBucket,
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
  // identical to the List view.
  const groups = useMemo(() => groupEntitiesByBucket(timelineData), [timelineData]);

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

  if (groups.length === 0) {
    return (
      <Empty
        title="No memories yet"
        description="Your timeline will fill in as memories are created."
        icon="🧠"
      />
    );
  }

  return (
    <div className="space-y-6 py-2">
      {groups.map((group) => (
        <section key={group.key}>
          <DateGroupHeader label={group.label} count={group.entities.length} />

          <div className="relative pl-8 pt-2">
            <div className="absolute top-0 bottom-0 left-[14px] w-0.5 bg-border" />

            <div className="space-y-4">
              {group.entities.map((entity) => (
                <div key={entity.id} className="relative">
                  <div className="absolute top-6 -left-4.25 h-4 w-4 -translate-x-1/2 rounded-full bg-[#179298]" />
                  <EntityCard entity={entity} />
                </div>
              ))}
            </div>
          </div>
        </section>
      ))}

      {loadingMore && <TimelineSkeleton count={2} className="pt-2" />}

      {hasNextPage && <div ref={sentinelRef} className="h-8" />}
    </div>
  );
}
