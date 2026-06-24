import { Skeleton, cn } from '@ci/shadcn';

/** A single dense list-row placeholder mirroring EntityRow's glyph / title / subtitle / time layout. */
function ListRowSkeleton() {
  return (
    <div className="flex items-center gap-3 px-3 py-2">
      <Skeleton className="h-9 w-9 shrink-0 rounded-md" />
      <div className="min-w-0 flex-1 space-y-2">
        <Skeleton className="h-3.5 w-1/3" />
        <Skeleton className="h-3 w-2/3" />
      </div>
      <Skeleton className="h-3 w-10 shrink-0" />
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
      {showHeader && <Skeleton className="my-2 h-3 w-20" />}
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
          <Skeleton className="h-6 w-6 rounded-md" />
          <Skeleton className="h-4 w-1/2" />
        </div>
        <Skeleton className="h-3 w-2/3" />
        <Skeleton className="h-3 w-1/3" />
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
