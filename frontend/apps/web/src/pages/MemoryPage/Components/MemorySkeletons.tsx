import { Skeleton, cn } from '@ci/shadcn';

import { PageContent } from '@/components/layout';

/**
 * The shared Skeleton in a shade that shows on a card as well as on the page.
 * Its own `bg-accent` all but matches `bg-card` in both themes, so a
 * placeholder inside a bordered row came out as an empty box.
 */
export function SkeletonBlock({ className }: { className?: string }) {
  return <Skeleton className={cn('bg-foreground/10', className)} />;
}

/** A single dense list-row placeholder mirroring EntityRow's glyph / title / subtitle / time layout. */
function ListRowSkeleton() {
  return (
    <div className="flex items-center gap-3 px-2 py-2">
      <SkeletonBlock className="h-9 w-9 shrink-0 rounded-md" />
      <div className="min-w-0 flex-1 space-y-2">
        <SkeletonBlock className="h-3.5 w-1/3" />
        <SkeletonBlock className="h-3 w-2/3" />
      </div>
      <SkeletonBlock className="h-3 w-10 shrink-0" />
    </div>
  );
}

interface SkeletonProps {
  /** Number of placeholder rows to render. */
  count?: number;
  className?: string;
}

interface ListSkeletonProps extends SkeletonProps {
  /** Show a date-group-header placeholder above the rows (first load only). */
  showHeader?: boolean;
}

/** First-load / load-more placeholder for the List view. */
export function ListSkeleton({ count = 8, showHeader = true, className }: ListSkeletonProps) {
  return (
    <div className={cn('flex flex-col', className)} aria-hidden>
      {showHeader && <SkeletonBlock className="my-2 h-3 w-20" />}
      {Array.from({ length: count }).map((_, i) => (
        <ListRowSkeleton key={i} />
      ))}
    </div>
  );
}

/** A single timeline card placeholder, aligned to the timeline rail. */
function TimelineCardSkeleton() {
  return (
    <div className="relative">
      <div className="absolute top-6 -left-4.25 h-4 w-4 -translate-x-1/2 rounded-full bg-[#58ebbf] shadow-glow-ci" />
      <div className="space-y-3 rounded-xl border border-border bg-card p-4">
        <div className="flex items-center gap-3">
          <SkeletonBlock className="h-6 w-6 rounded-md" />
          <SkeletonBlock className="h-4 w-1/2" />
        </div>
        <SkeletonBlock className="h-3 w-2/3" />
        <SkeletonBlock className="h-3 w-1/3" />
      </div>
    </div>
  );
}

/** First-load / load-more placeholder for the Timeline view. */
export function TimelineSkeleton({ count = 4, className }: SkeletonProps) {
  return (
    <div className={cn('relative pl-8', className)} aria-hidden>
      <div className="absolute top-0 bottom-0 left-[14px] w-0.5 bg-border" />
      <div className="space-y-4">
        {Array.from({ length: count }).map((_, i) => (
          <TimelineCardSkeleton key={i} />
        ))}
      </div>
    </div>
  );
}

/**
 * The explorer (`/memory`, `/memory/events`) while its own code is still
 * downloading: the filter bar, the List / Map / … row on a phone, then the
 * list placeholder its List view shows while the first page loads.
 */
export function ExplorerSkeleton() {
  return (
    <PageContent className="gap-2 p-0">
      <div role="status" aria-busy="true" className="flex min-h-0 flex-1 flex-col gap-2 px-2 pt-2">
        <span className="sr-only">Loading</span>
        <div aria-hidden className="flex flex-col gap-2">
          <SkeletonBlock className="h-10 w-full rounded-lg" />
          <SkeletonBlock className="h-11 w-full rounded-xl device:hidden" />
        </div>
        <ListSkeleton count={10} />
      </div>
    </PageContent>
  );
}
