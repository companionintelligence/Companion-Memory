import { useCallback, useEffect, useRef, useState } from 'react';

import { Portal } from '@ci/common';
import { Separator } from '@ci/shadcn';
import { useLocation } from 'react-router-dom';

import { ConnectionModeIndicator, OutboxQueueIndicator } from '@/components/ConnectionModeIndicator';
import { GlobalSearchBox } from '@/components/SearchBox';

import { AddMenu } from '../AddMenu';

export function PrimaryNavigation() {
  const location = useLocation();
  // The global search box searches the VIEWER's own memory. On a shared-search
  // page the body shows someone else's results, so the prominent search would be
  // misleading (and navigate the viewer away). Hide it there; the page's own view
  // tabs (nav-views) still render.
  const isSharedView = location.pathname.startsWith('/shared/');
  const isMemoryExplorer = location.pathname === '/memory/events' || location.pathname === '/memory';

  const [hasActions, setHasActions] = useState(false);
  const observer = useRef<MutationObserver | null>(null);

  const actionsRef = useCallback((node: HTMLDivElement | null) => {
    if (observer.current) {
      observer.current.disconnect();
      observer.current = null;
    }

    if (node) {
      observer.current = new MutationObserver(() => {
        setHasActions(node.childElementCount > 0);
      });

      observer.current.observe(node, { childList: true });

      setHasActions(node.childElementCount > 0);
    }
  }, []);

  useEffect(() => {
    return () => {
      observer.current?.disconnect();
    };
  }, []);

  return (
    <header className="flex flex-row items-center gap-2 p-2 px-4">
      {/* Memory explorer: search left, view tabs after it.
          Other pages: nav-views, then search fills the remaining width.
          There are no breadcrumbs anywhere — the Power Rail is the only
          location indicator.

          A <nav>, not a plain box — and the element that was already here
          rather than a new one, so the flex geometry is unchanged. The view
          tabs and the search that moves between them are the navigable half of
          this header, and they now sit in a landmark a screen reader can jump
          to; "Primary" keeps it distinct from the rail's "Main navigation".
          The <header> stays the banner landmark, and keeps the chips and Add,
          which are not navigation. */}
      <nav
        aria-label="Primary"
        className="relative flex min-w-0 flex-1 flex-col gap-2 md:flex-row md:items-center md:gap-3"
      >
        {isMemoryExplorer ? (
          <>
            {!isSharedView && (
              <div className="w-full min-w-0 flex-1">
                <GlobalSearchBox />
              </div>
            )}
            <Portal id="nav-views" className="flex shrink-0 flex-row items-center empty:hidden" />
          </>
        ) : (
          <>
            <div className="flex min-w-0 shrink-0 flex-row flex-wrap items-center gap-2">
              <Portal id="nav-views" className="flex flex-row items-center empty:hidden" />
            </div>
            {!isSharedView && (
              <div className="w-full min-w-0 flex-1">
                <GlobalSearchBox />
              </div>
            )}
          </>
        )}
      </nav>

      {/* Right: status chips, page actions, and the primary Add control.
          Account/settings live in the left rail now. The chips sit in the
          header's flow rather than in a viewport-pinned overlay. */}
      <div className="flex shrink-0 flex-row items-center gap-2">
        <div className="flex flex-row items-center gap-1.5 empty:hidden">
          <ConnectionModeIndicator />
          <OutboxQueueIndicator />
        </div>

        <Portal ref={actionsRef} id="actions" className="flex flex-row items-center empty:hidden" />

        {hasActions && <Separator orientation="vertical" className="data-[orientation=vertical]:h-6" />}

        <AddMenu />
      </div>
    </header>
  );
}
