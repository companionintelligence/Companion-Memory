import { useEffect, useRef, type RefObject } from 'react';

interface Options {
  /**
   * Watch the sentinel at all. Pass false once there is no next page, and
   * after a page has failed: the failure latch is the load-bearing part. A
   * sentinel that stays visible after a rejected fetch is re-observed on the
   * next render, fires at once, and loops on the same cursor until the server
   * answers.
   */
  enabled: boolean;
  loadMore: () => void;
  /** The scrolling box, when the list scrolls inside one; the viewport otherwise. */
  root?: RefObject<Element | null>;
  /** How far ahead of the visible edge the next page is asked for. */
  rootMargin?: string;
}

/**
 * The "load the next page when the sentinel scrolls into view" half of an
 * infinitely-scrolled list: an IntersectionObserver on one trailing element.
 * `useInfiniteConnection` builds on it for lists that page a connection
 * themselves; the explorer's views, whose paging lives in `useEntityService`,
 * use it directly. Render the returned ref on the trailing element only while
 * `enabled` — an unobserved sentinel is just an empty box.
 */
export function useLoadMoreSentinel({
  enabled,
  loadMore,
  root,
  rootMargin = '400px',
}: Options): RefObject<HTMLDivElement | null> {
  const sentinelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const sentinel = sentinelRef.current;

    if (!sentinel || !enabled) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          loadMore();
        }
      },
      { root: root?.current ?? null, rootMargin },
    );

    observer.observe(sentinel);

    return () => observer.disconnect();
  }, [enabled, loadMore, root, rootMargin]);

  return sentinelRef;
}
