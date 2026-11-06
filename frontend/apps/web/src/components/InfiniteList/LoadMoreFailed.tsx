import { Button } from '@ci/shadcn';

/**
 * A page that would not load, at the tail of a list that still has its earlier
 * pages: what went wrong and one way to ask again. `InfiniteListFooter` renders
 * it for the connection-paged lists; the explorer's views render it themselves,
 * since their paging lives in `useEntityService`.
 */
export function LoadMoreFailed({
  noun,
  message,
  onRetry,
}: {
  /** Plural noun for the message, e.g. "places". */
  noun: string;
  message?: string | null;
  onRetry: () => void;
}) {
  return (
    <div className="flex flex-col items-center gap-2 py-3">
      <div className="text-sm text-muted-foreground">
        Couldn&apos;t load more {noun}
        {message ? `: ${message}` : ''}
      </div>
      <Button variant="outline" size="sm" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}
