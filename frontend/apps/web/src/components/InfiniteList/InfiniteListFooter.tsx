import type { InfiniteConnection } from '@/hooks/useInfiniteConnection';

import { LoadMoreFailed } from './LoadMoreFailed';

/**
 * The tail of an infinitely-scrolled list: the scroll sentinel, a retry for a
 * failed page, and — always — a count of how much of the collection is actually
 * on screen. The count is not decoration; a list that renders 500 of 1,179 rows
 * and says nothing is the bug this component exists to prevent.
 */
export function InfiniteListFooter({
  pagination,
  noun,
  className,
}: {
  pagination: InfiniteConnection;
  /** Plural noun for the retry message, e.g. "places". */
  noun: string;
  className?: string;
}) {
  const { sentinelRef, showSentinel, loadMoreError, retry, statusLabel } = pagination;

  return (
    <div className={className}>
      {showSentinel && <div ref={sentinelRef} className="h-8" />}

      {loadMoreError != null && <LoadMoreFailed noun={noun} message={loadMoreError} onRetry={retry} />}

      <div className="py-3 text-center text-xs text-muted-foreground">{statusLabel}</div>
    </div>
  );
}
