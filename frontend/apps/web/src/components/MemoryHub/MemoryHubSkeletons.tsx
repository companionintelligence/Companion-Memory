import type { ReactNode } from 'react';

import { cn } from '@ci/shadcn';

import { PageContent } from '@/components/layout';
import { ExplorerSkeleton, SkeletonBlock } from '@/pages/MemoryPage/Components/MemorySkeletons';

import { isMemoryExplorerPath } from './memoryHubSections';
import { MemoryHubShell } from './MemoryHubShell';

/**
 * Loading placeholders for the Memory hub sections, shaped like what each one
 * shows once it has loaded: bordered rows for People / Places / Receipts, a
 * card grid for Things, tiles for Content, and so on.
 *
 * Every section used to put up a full-screen spinner instead (or, for Content
 * and Tags, a line of text), so moving between tabs flickered between three
 * different loading styles. These all pulse the same way, from the shared
 * `Skeleton` (through SkeletonBlock, which gives it a shade that shows on a
 * card).
 */

/** What a screen reader hears while the shapes are on screen; the shapes themselves are hidden from it. */
export function LoadingRegion({
  label,
  className,
  children,
}: {
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div role="status" aria-busy="true" className={className}>
      <span className="sr-only">{label}</span>
      <div aria-hidden>{children}</div>
    </div>
  );
}

function repeat(count: number, render: (index: number) => ReactNode) {
  return Array.from({ length: count }, (_, index) => render(index));
}

/** Bordered rows like PersonRow, PlaceRow and ReceiptRow: avatar or icon, title, a line under it, a meta column from `sm` up. */
export function RowsSkeleton({
  count = 8,
  avatar = 'square',
}: {
  count?: number;
  avatar?: 'circle' | 'square';
}) {
  return (
    <div className="flex flex-col gap-2">
      {repeat(count, (index) => (
        <div key={index} className="flex items-center gap-3 rounded-md border bg-card p-3">
          <SkeletonBlock
            className={cn('size-10 shrink-0', avatar === 'circle' ? 'rounded-full' : 'rounded-md')}
          />
          <div className="min-w-0 flex-1 space-y-2">
            {/* Varied widths, so the column reads as names rather than bars. */}
            <SkeletonBlock
              className={cn('h-4', index % 3 === 0 ? 'w-2/5' : index % 3 === 1 ? 'w-1/3' : 'w-1/2')}
            />
            <SkeletonBlock className="h-3 w-3/4" />
          </div>
          <div className="hidden shrink-0 space-y-2 sm:block">
            <SkeletonBlock className="ml-auto h-3 w-28" />
            <SkeletonBlock className="ml-auto h-3 w-20" />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Cards in the same grid as EntityGrid (Things). */
export function CardGridSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div className="grid w-full auto-rows-[260px] grid-cols-[repeat(auto-fill,minmax(min(100%,240px),1fr))] gap-4">
      {repeat(count, (index) => (
        <div key={index} className="flex flex-col gap-3 rounded-md border bg-card p-4">
          <div className="flex items-center gap-2">
            <SkeletonBlock className="size-6 shrink-0 rounded-md" />
            <SkeletonBlock className="h-4 w-1/2" />
          </div>
          <SkeletonBlock className="h-3 w-5/6" />
          <SkeletonBlock className="h-3 w-2/3" />
          <SkeletonBlock className="min-h-0 w-full grow" />
          <SkeletonBlock className="ml-auto h-3 w-12" />
        </div>
      ))}
    </div>
  );
}

/** Square tiles in the Content library's grid. */
export function TilesSkeleton({ count = 10 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 gap-2 device:gap-4 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
      {repeat(count, (index) => (
        <SkeletonBlock key={index} className="aspect-square w-full rounded-lg" />
      ))}
    </div>
  );
}

/** Note cards: one column on a phone, 300px cards from the device breakpoint up, like the Notes list. */
export function NoteCardsSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div className="grid w-full grid-cols-1 gap-1.5 device:auto-rows-[300px] device:grid-cols-[repeat(auto-fill,300px)] device:justify-center device:gap-4">
      {repeat(count, (index) => (
        <div key={index} className="flex flex-col gap-2 rounded-md border bg-card p-3 device:p-4">
          <SkeletonBlock className="h-4 w-1/2" />
          <SkeletonBlock className="h-3 w-full" />
          <SkeletonBlock className="h-3 w-4/5" />
          <SkeletonBlock className="hidden min-h-0 w-full grow device:block" />
        </div>
      ))}
    </div>
  );
}

/** The Tags list: one bordered column of tag chips with their description beside them from the device breakpoint up. */
export function TagRowsSkeleton({ count = 8 }: { count?: number }) {
  return (
    <div className="flex flex-col divide-y divide-border rounded-md border border-border">
      {repeat(count, (index) => (
        <div key={index} className="flex items-center gap-2 px-2 py-1.5 device:gap-3 device:px-3 device:py-2">
          <SkeletonBlock className={cn('h-6 rounded-full', index % 2 === 0 ? 'w-20' : 'w-28')} />
          <SkeletonBlock className="hidden h-3 w-1/3 device:block" />
          <SkeletonBlock className="ml-auto h-3 w-8" />
        </div>
      ))}
    </div>
  );
}

/** Chat threads, in the desktop sidebar and the phone's Chats sheet. */
export function ThreadRowsSkeleton({ count = 5 }: { count?: number }) {
  return (
    <div className="flex flex-col gap-2">
      {repeat(count, (index) => (
        <div key={index} className="flex items-center gap-3 rounded-xl px-3 py-3">
          <SkeletonBlock className="size-8 shrink-0 rounded-lg" />
          <div className="min-w-0 flex-1 space-y-2">
            <SkeletonBlock className={cn('h-4', index % 2 === 0 ? 'w-3/5' : 'w-2/5')} />
            <SkeletonBlock className="h-3 w-1/3" />
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * A whole section page while its first page of results is on its way: the
 * same frame and padding as the loaded page, a header line where its title
 * and count go, then the placeholders. It sits under the section strip, which
 * stays put (MemoryHubLayout).
 */
export function MemoryHubPageSkeleton({
  label,
  actions,
  children,
}: {
  label: string;
  /** The page's own strip actions ("New place"), so they do not pop in once it has loaded. */
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <PageContent className="gap-2 p-0">
      <MemoryHubShell actions={actions}>
        <LoadingRegion
          label={label}
          className="flex flex-col gap-3 px-2 pb-3 device:gap-4 device:px-4 device:pb-4"
        >
          <div className="flex flex-col gap-3 device:gap-4">
            <div className="flex items-baseline gap-2 px-1 device:px-0">
              <SkeletonBlock className="h-4 w-20" />
              <SkeletonBlock className="h-3 w-8" />
            </div>
            {children}
          </div>
        </LoadingRegion>
      </MemoryHubShell>
    </PageContent>
  );
}

/**
 * What MemoryHubLayout shows while a section's code is still downloading:
 * the same placeholder that section shows while its data loads, so the two
 * waits read as one.
 */
export function MemoryHubSectionSkeleton({ pathname }: { pathname: string }) {
  if (isMemoryExplorerPath(pathname)) {
    return <ExplorerSkeleton />;
  }

  if (pathname.startsWith('/memory/things')) {
    return (
      <MemoryHubPageSkeleton label="Loading things">
        <CardGridSkeleton />
      </MemoryHubPageSkeleton>
    );
  }

  if (pathname.startsWith('/memory/content')) {
    return (
      <MemoryHubPageSkeleton label="Loading content">
        <TilesSkeleton />
      </MemoryHubPageSkeleton>
    );
  }

  if (pathname.startsWith('/memory/notes')) {
    return (
      <MemoryHubPageSkeleton label="Loading notes">
        <NoteCardsSkeleton />
      </MemoryHubPageSkeleton>
    );
  }

  if (pathname.startsWith('/memory/tags')) {
    return (
      <MemoryHubPageSkeleton label="Loading tags">
        <TagRowsSkeleton />
      </MemoryHubPageSkeleton>
    );
  }

  if (pathname.startsWith('/memory/chat')) {
    return (
      <MemoryHubPageSkeleton label="Loading chats">
        <ThreadRowsSkeleton />
      </MemoryHubPageSkeleton>
    );
  }

  return (
    <MemoryHubPageSkeleton label="Loading">
      <RowsSkeleton avatar={pathname.startsWith('/memory/people') ? 'circle' : 'square'} />
    </MemoryHubPageSkeleton>
  );
}
