import type { ReactNode } from 'react';

import { Portal, useDeviceLayout } from '@ci/common';
import { cn } from '@ci/shadcn';
import { useLocation } from 'react-router-dom';

import { DropdownProvider } from '@/components/SearchBox/useDropdown';

import { MemoryEntityTypeNav } from './MemoryEntityTypeNav';
import { MEMORY_HUB_ACTIONS_SLOT } from './MemoryHubNav';
import { isMemoryExplorerPath } from './memoryHubSections';

/**
 * A Memory hub page's own part of the hub frame, under the section strip.
 *
 * The strip itself (MemoryHubNav) belongs to MemoryHubLayout, the layout route
 * around every section, so it stays put while the section under it changes.
 * What is left here is what differs by page: the explorer's What bar, and the
 * page's actions, which are portaled up into the strip.
 */
export function MemoryHubShell({
  children,
  actions,
  fillHeight = false,
}: {
  children: ReactNode;
  /**
   * Page-level actions (a "New …" button) pinned to the right of the section
   * nav. Lives on the shell rather than in each page body so every Memory
   * surface puts its create affordance in the same place, whichever of the two
   * navs that surface happens to render.
   */
  actions?: ReactNode;
  /** Fill the page content area — only for Events explorer views that split scroll panes. */
  fillHeight?: boolean;
}) {
  const { pathname } = useLocation();
  const { isMobile } = useDeviceLayout();
  const isExplorer = isMemoryExplorerPath(pathname);

  // `pt-2` stands in for the gap that used to sit between the strip and the
  // page when both lived in this column.
  const shellClass = cn('flex flex-col gap-2 pt-2', fillHeight && 'min-h-0 flex-1');

  if (isExplorer) {
    // Two distinct rows, not one: which Memory destination you're in
    // (MemoryHubNav, from the layout above — the same row every other hub
    // page shows), then which slice of it you're filtered to
    // (MemoryEntityTypeNav, the What bar).
    // The explorer used to render only the second row, landing exactly where
    // the rail points at with no sign People/Places/Things/etc. exist.
    return (
      <div className={shellClass}>
        <DropdownProvider args={[{ changeSearchParams: true }]}>
          <MemoryEntityTypeNav actions={actions} />
          {children}
        </DropdownProvider>
      </div>
    );
  }

  return (
    <div className={shellClass}>
      {/* The strip leaves page actions off on a phone (see MemoryHubNav). */}
      {actions != null && !isMobile && <Portal.Slot id={MEMORY_HUB_ACTIONS_SLOT}>{actions}</Portal.Slot>}
      {children}
    </div>
  );
}
