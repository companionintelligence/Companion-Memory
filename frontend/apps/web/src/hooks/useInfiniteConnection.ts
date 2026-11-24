import { useCallback, useRef, useState } from 'react';

import { useLoadMoreSentinel } from './useLoadMoreSentinel';

/**
 * Shape every Relay-style connection on this schema exposes. Pages hand the
 * hook the connection they just read out of their own query result, so the hook
 * never needs to know the query document or the field name.
 */
export interface ConnectionLike {
  totalCount: number;
  pageInfo: { hasNextPage: boolean; endCursor?: string | null };
}

interface Options {
  /**
   * The connection from the current render, or `undefined` while the first page
   * is still in flight.
   */
  connection: ConnectionLike | undefined;
  /** How many nodes the page has accumulated and is rendering right now. */
  loadedCount: number;
  /**
   * Fetch the page after `endCursor` and append it to the accumulated list.
   * Rejections are caught and latched by the hook, so callers may let them
   * propagate.
   */
  fetchNextPage: (endCursor: string) => Promise<unknown>;
}

export interface InfiniteConnection {
  /** Attach to the page's scroll container (the IntersectionObserver root). */
  scrollRef: React.RefObject<HTMLDivElement | null>;
  /**
   * Render at the end of the list to trigger the next page. Only render it when
   * `showSentinel` is true, otherwise a persistent failure spins a request loop.
   */
  sentinelRef: React.RefObject<HTMLDivElement | null>;
  showSentinel: boolean;
  loadingMore: boolean;
  /** Non-null once a page failed; loading stays gated until `retry()` clears it. */
  loadMoreError: string | null;
  retry: () => void;
  /** Clear a latched failure because the query variables changed underneath it. */
  reset: () => void;
  hasNextPage: boolean;
  totalCount: number;
  /** "12 of 1179 loaded · loading…" — the line that makes truncation visible. */
  statusLabel: string;
}

/**
 * Cursor pagination + "load the next page when the sentinel scrolls into view",
 * factored out of PeoplePage so a list page cannot accidentally ship with a
 * fixed `first:` and no way to reach the rest of the rows.
 *
 * The error handling is the load-bearing part. `fetchMore` rejects on
 * network/GraphQL errors, and simply clearing `loadingMore` is not enough: the
 * sentinel is still on screen, so the observer rebuilds, re-fires immediately on
 * observe(), and spins a request loop. The failure is latched instead — that
 * unmounts the sentinel and gates loading until the user retries.
 */
export function useInfiniteConnection({
  connection,
  loadedCount,
  fetchNextPage,
}: Options): InfiniteConnection {
  const [loadingMore, setLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const hasNextPage = connection?.pageInfo.hasNextPage ?? false;
  const endCursor = connection?.pageInfo.endCursor ?? null;
  const totalCount = connection?.totalCount ?? 0;

  const loadMore = useCallback(() => {
    if (!hasNextPage || loadingMore || loadMoreError != null || endCursor == null) {
      return;
    }

    setLoadingMore(true);

    Promise.resolve(fetchNextPage(endCursor))
      .catch((cause: unknown) => {
        setLoadMoreError(cause instanceof Error ? cause.message : 'Something went wrong.');
      })
      .finally(() => setLoadingMore(false));
  }, [endCursor, fetchNextPage, hasNextPage, loadMoreError, loadingMore]);

  // Unwatched once a page fails: `showSentinel` below unmounts the sentinel
  // then too, and the retry button is the only way to ask again.
  const sentinelRef = useLoadMoreSentinel({
    enabled: hasNextPage && loadMoreError == null,
    loadMore,
    root: scrollRef,
  });

  const reset = useCallback(() => setLoadMoreError(null), []);

  return {
    scrollRef,
    sentinelRef,
    showSentinel: hasNextPage && loadMoreError == null,
    loadingMore,
    loadMoreError,
    retry: reset,
    reset,
    hasNextPage,
    totalCount,
    statusLabel: `${loadedCount} of ${totalCount} loaded${
      loadingMore ? ' · loading…' : hasNextPage ? '' : ' · end'
    }`,
  };
}
