import { type ComponentType, Suspense, lazy, useState } from 'react';

import { Button } from '@ci/shadcn';

import { isChunkLoadError } from '@/lib/telemetry';

import { ErrorState } from './ErrorState';
import { ListSkeleton } from './MemorySkeletons';
import { ViewCrashBoundary } from './ViewCrashBoundary';

/**
 * Loads one view's chunk. Must be a module-scope function so its identity is
 * stable across renders — a loader rebuilt inline would mint a new lazy
 * component every render and remount (and re-Suspend) the view each time.
 *
 * A view that needs props binds them here, in a named wrapper, because the
 * lazy component this produces is rendered with no props.
 */
export type ViewLoader = () => Promise<{ default: ComponentType }>;

interface Props {
  /** Clears a captured error when the same slot is reused for another view. */
  viewKey: string;
  load: ViewLoader;
}

/**
 * Wraps one lazily-chunked Memory view. The crash boundary sits OUTSIDE
 * Suspense on purpose: a failed chunk fetch (offline, or a deploy that rotated
 * the hashed filenames) throws from the lazy element, so only a boundary above
 * it turns that into a retryable error instead of a blank pane.
 *
 * Shared by DesktopMemoryPage and MobileMemoryPage — the wrapper used to be
 * duplicated verbatim in both, so the retry bug fixed below existed twice.
 */
export function LazyView({ viewKey, load }: Props) {
  // The lazy component lives in state rather than at module scope because
  // React.lazy memoizes the REJECTION as well as the resolved module: once a
  // chunk fetch fails, that payload re-throws the same error on every later
  // render, so "Try again" against the original component can never succeed.
  // Retry mints a fresh payload, which re-runs import().
  const [View, setView] = useState<ComponentType>(() => lazy(load));

  return (
    <ViewCrashBoundary
      resetKey={viewKey}
      fallback={(retry, error) => (
        <ErrorState
          description="This view could not be loaded. Check your connection and try again."
          onRetry={() => {
            // A chunk that failed to download stays failed for the life of the
            // document. Chromium keeps the failed fetch in its module map, so a
            // fresh import() of the same URL rejects at once without a request.
            // The dependencies Vite had already tried to preload stay failed too.
            // Once the connection is back only a reload fetches them again. The
            // view is in the URL, so the reload lands on the same view.
            // Still offline, the in-place retry below fails again and keeps
            // this message, which is better than the browser's offline page.
            if (isChunkLoadError(error) && navigator.onLine) {
              window.location.reload();

              return;
            }

            // A fresh payload, for a browser that does not keep failed fetches
            // (Firefox, Safari) when the device reports itself offline; `retry`
            // to clear the boundary so the new one actually gets rendered. Both
            // land in one batch. For a plain render crash the module is already
            // loaded, so this is just a remount. That is the right recovery for
            // a component that threw mid-render anyway.
            setView(() => lazy(load));
            retry();
          }}
        >
          {/* A deploy that rotated the hashed chunk filenames leaves the old
              URL 404ing for the life of the document: the browser caches the
              failed module specifier, so no number of fresh import()s recovers
              it. Only a reload picks up the new index.html. */}
          <Button variant="ghost" size="sm" onClick={() => window.location.reload()}>
            Reload the page
          </Button>
        </ErrorState>
      )}
    >
      <Suspense fallback={<ListSkeleton count={6} className="px-2" />}>
        <View />
      </Suspense>
    </ViewCrashBoundary>
  );
}
