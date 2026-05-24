import { useEffect, useRef } from 'react';

import { useEntityService } from '../../MemoryPage/useEntityService';
import { Empty, EntityCard } from '../Components';
import { groupEntitiesByDate, formatDateForDisplay } from '../Components/utils';

export function TimelineView() {
  const timelineRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const hasInitialScrolledRef = useRef(false);
  const previousScrollHeightRef = useRef<number>(0);

  const [{ data, loading }] = useEntityService();

  const groupedEntitiesRaw = groupEntitiesByDate(data);

  // Ensure "today" appears first by explicitly sorting dates with today first
  const now = new Date();
  const todayLocal = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const groupedEntities = groupedEntitiesRaw.sort((a, b) => {
    // If one is today, it should come first
    if (a.date === todayLocal) {
      return -1;
    }

    if (b.date === todayLocal) {
      return 1;
    }

    // Otherwise, sort newest first (reverse chronological)
    return b.date.localeCompare(a.date);
  });

  useEffect(() => {
    if (!scrollContainerRef.current) {
      scrollContainerRef.current = timelineRef.current?.closest(
        '[data-slot="scroll-area-viewport"]',
      ) as HTMLDivElement | null;
    }
  }, []);

  useEffect(() => {
    const container = scrollContainerRef.current;

    // Only scroll to "today" on initial load, not when loading more memories
    if (container && data.length > 0 && !hasInitialScrolledRef.current) {
      setTimeout(() => {
        // First try to find the current day's date header
        const currentDayHeader = container.querySelector('[data-current-day="true"]');

        if (currentDayHeader) {
          const headerRect = currentDayHeader.getBoundingClientRect();
          const containerRect = container.getBoundingClientRect();
          const scrollOffset = headerRect.top - containerRect.top + container.scrollTop - 8; // Small offset for padding
          container.scrollTo({ top: scrollOffset, behavior: 'smooth' });
        } else {
          // Fallback to scrolling to top
          container.scrollTop = 0;
        }

        hasInitialScrolledRef.current = true;
        previousScrollHeightRef.current = container.scrollHeight;
      }, 200);
    }
  }, [data.length]);

  useEffect(() => {
    const container = scrollContainerRef.current;

    if (!container || !hasInitialScrolledRef.current) {
      if (container && data.length > 0) {
        // Store initial scroll height
        previousScrollHeightRef.current = container.scrollHeight;
      }

      return;
    }

    // Maintain scroll position when new items are loaded
    const currentScrollTop = container.scrollTop;
    const currentScrollHeight = container.scrollHeight;
    const previousScrollHeight = previousScrollHeightRef.current;

    if (currentScrollHeight !== previousScrollHeight && currentScrollTop > 0) {
      // Use requestAnimationFrame to ensure DOM has updated
      requestAnimationFrame(() => {
        if (!container) {
          return;
        }

        // Calculate the difference in height (new content added)
        const heightDifference = container.scrollHeight - previousScrollHeight;

        // If we're near the bottom (loading past events), maintain scroll position
        // If we're at the top (loading future events), adjust scroll to account for new content at top
        const { clientHeight } = container;
        const wasNearBottom = currentScrollTop + clientHeight > previousScrollHeight - 100;

        if (wasNearBottom) {
          // When loading past events at bottom, maintain scroll position
          container.scrollTop = currentScrollTop;
        } else {
          // When loading future events at top, adjust scroll position by the height difference
          container.scrollTop = currentScrollTop + heightDifference;
        }

        previousScrollHeightRef.current = container.scrollHeight;
      });
    } else {
      previousScrollHeightRef.current = currentScrollHeight;
    }
  }, [data.length]);

  useEffect(() => {
    const container = scrollContainerRef.current;

    if (!container) {
      return;
    }

    let scrollTimeout: NodeJS.Timeout;

    const handleScroll = () => {
      clearTimeout(scrollTimeout);
      scrollTimeout = setTimeout(() => {
        if (loading) {
          return;
        }

        // const { scrollTop, scrollHeight, clientHeight } = container;

        // After reversing: scrolling down (toward bottom) loads past events (older memories)
        // Scrolling up (toward top) loads future events (newer memories)
        // if (scrollTop + clientHeight > scrollHeight - 100) {
        //   loadPastEvents();
        // }

        // if (scrollTop < 100) {
        //   loadFutureEvents();
        // }
      }, 50);
    };

    container.addEventListener('scroll', handleScroll, { passive: true });

    return () => {
      container.removeEventListener('scroll', handleScroll);
      clearTimeout(scrollTimeout);
    };
  }, [loading]);

  if (groupedEntities.length === 0 && !loading) {
    return (
      <Empty
        title="No memories yet"
        description="Your memories will appear here as they're created."
        icon="🧠"
      />
    );
  }

  return (
    <div ref={timelineRef} className="space-y-6 h-full py-2">
      {groupedEntities.map(({ date, entities: dayEntities }) => {
        // Compare using local date to match user's timezone
        const now = new Date();
        const todayLocal = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
        const isCurrentDay = date === todayLocal;

        return (
          <div key={date} className="relative">
            <div
              data-current-day={isCurrentDay}
              className="flex font-semibold text-lg border-border py-3 mb-4 bg-[#74c5c4] dark:bg-accent pl-3 rounded-r-lg relative z-1"
            >
              {formatDateForDisplay(date)}
            </div>

            <div className="absolute left-[14px] top-0 bottom-0 w-0.5 bg-[#0b5969]" />

            <div className="space-y-4 pl-8">
              {[...dayEntities].reverse().map((entity) => {
                const entityDate =
                  'time' in entity
                    ? new Date(entity.time as string)
                    : 'startTime' in entity
                      ? new Date(entity.startTime as string)
                      : new Date();
                const now = new Date();
                const timeDiff = Math.abs(entityDate.getTime() - now.getTime());
                const isCurrentTime =
                  isCurrentDay && !isNaN(entityDate.getTime()) && timeDiff < 24 * 60 * 60 * 1000;

                return (
                  <div key={entity.id} data-current-time={isCurrentTime} className="relative">
                    <div className="absolute top-1/2 -left-4.25 transform -translate-x-1/2 -translate-y-1/2 w-4 h-4 rounded-full bg-[#179298] border-2 border-[#179298]" />

                    <EntityCard entity={entity} />
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}

      {loading && (
        <div className="flex justify-center py-8">
          <div className="flex items-center gap-3 text-muted-foreground">
            <div className="w-5 h-5 border-2 border-muted border-t-primary rounded-full animate-spin" />
            <span>Loading memories...</span>
          </div>
        </div>
      )}
    </div>
  );
}
