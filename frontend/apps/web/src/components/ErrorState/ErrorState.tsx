import type { ReactNode } from 'react';

import { Button, cn } from '@ci/shadcn';
import { TriangleAlert, RotateCw } from '@ci/shadcn/icons';

export interface ErrorStateProps {
  title?: string;
  /**
   * What went wrong, in the owner's words.
   *
   * Say that the DATA is fine and the FETCH was not, wherever that is true. The
   * failure mode this component exists to end is a page rendering "you have
   * none" over a request that errored, and copy like "nothing here" reproduces
   * that in a nicer font.
   */
  description?: string;
  onRetry?: () => void;
  /**
   * An extra way out, beside Try again.
   *
   * Needed by surfaces rendered OUTSIDE the app shell — `/providers/:id` has no
   * rail on screen, so an error there with only a retry leaves browser Back as
   * the sole escape from a page that may never load.
   */
  children?: ReactNode;
  className?: string;
}

/**
 * Inline "we could not load this" with a retry — the shared alternative to a
 * confident empty state.
 *
 * Lived under `pages/MemoryPage/Components` and was cross-imported from
 * SharedSearchPage already; it is here because the audit found at least eight
 * surfaces that drop a query's `error` and render their empty state instead,
 * and the fix for every one of them is this component. A shared concern sitting
 * inside one page's folder is a concern the next page quietly reimplements or,
 * as happened here, simply omits.
 *
 * The Memory views keep their own memory-worded default by wrapping this — see
 * `pages/MemoryPage/Components/ErrorState.tsx`.
 */
export function ErrorState({
  title = 'Something went wrong',
  description = 'This could not be loaded. Check your connection and try again.',
  onRetry,
  children,
  className,
}: ErrorStateProps) {
  return (
    <div
      role="alert"
      className={cn('flex flex-col items-center justify-center px-6 py-12 text-center', className)}
    >
      <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-destructive/10">
        <TriangleAlert className="h-8 w-8 text-destructive" />
      </div>

      <h3 className="mb-1 text-lg font-medium text-foreground">{title}</h3>
      <p className="mb-4 max-w-sm text-sm text-muted-foreground">{description}</p>

      <div className="flex flex-wrap items-center justify-center gap-2">
        {onRetry && (
          <Button variant="outline" size="sm" onClick={onRetry}>
            <RotateCw className="h-4 w-4" />
            Try again
          </Button>
        )}
        {children}
      </div>
    </div>
  );
}
