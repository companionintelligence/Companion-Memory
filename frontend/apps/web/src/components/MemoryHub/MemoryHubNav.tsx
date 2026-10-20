import { useLayoutEffect, useRef } from 'react';

import { Portal, useDeviceLayout } from '@ci/common';
import { cn } from '@ci/shadcn';
import { Link, useLocation, useSearchParams } from 'react-router-dom';

import { useFeatures } from '@/common/feature';

import { MEMORY_HUB_SECTIONS } from './memoryHubSections';

/**
 * The address a section chip opens: the section, plus the current `?search=`
 * and nothing else. The header search box writes the query into whichever
 * memory list is open, so switching lists keeps what was typed — but the
 * page's filters and sort stay behind, since the next page has its own and
 * may not understand these.
 */
export function sectionHref(to: string, params: URLSearchParams): string {
  const search = params.get('search')?.trim();

  return search ? `${to}?${new URLSearchParams({ search }).toString()}` : to;
}

const ACTIVE_TAB_GUTTER = 8;

/**
 * Where a section page's own actions ("New place", "New thing") land, at the
 * strip's right end. The strip belongs to MemoryHubLayout and outlives every
 * page, so a page reaches it through this slot (see MemoryHubShell) rather
 * than as a prop.
 */
export const MEMORY_HUB_ACTIONS_SLOT = 'memory-hub-actions';

interface HorizontalScrollBounds {
  scrollLeft: number;
  clientWidth: number;
  scrollWidth: number;
  itemLeft: number;
  itemRight: number;
}

/** Nearest bounded horizontal position that fully reveals one tab. */
export function nearestHorizontalScroll({
  scrollLeft,
  clientWidth,
  scrollWidth,
  itemLeft,
  itemRight,
}: HorizontalScrollBounds): number {
  const maxScroll = Math.max(0, scrollWidth - clientWidth);
  const visibleLeft = scrollLeft + ACTIVE_TAB_GUTTER;
  const visibleRight = scrollLeft + clientWidth - ACTIVE_TAB_GUTTER;
  let next = scrollLeft;

  if (itemLeft < visibleLeft) {
    next = itemLeft - ACTIVE_TAB_GUTTER;
  } else if (itemRight > visibleRight) {
    next = itemRight - clientWidth + ACTIVE_TAB_GUTTER;
  }

  return Math.min(maxScroll, Math.max(0, next));
}

export function MemoryHubNav() {
  const { pathname } = useLocation();
  const [searchParams] = useSearchParams();
  const { isMobile } = useDeviceLayout();
  const { isFeatureEnabled } = useFeatures();

  const visible = MEMORY_HUB_SECTIONS.filter((section) => !section.flag || isFeatureEnabled(section.flag));
  const visibleKey = visible.map((section) => section.to).join('|');
  const scrollerRef = useRef<HTMLDivElement>(null);
  const activeLinkRef = useRef<HTMLAnchorElement>(null);

  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    const activeLink = activeLinkRef.current;

    if (!scroller || !activeLink || scroller.clientWidth === 0) {
      return;
    }

    // Rects account for the wrapper around the links. Convert them back into
    // scroll-content coordinates, then move only this horizontal scroller.
    // `scrollIntoView` is intentionally avoided because it can also move the
    // page vertically.
    const scrollerRect = scroller.getBoundingClientRect();
    const activeRect = activeLink.getBoundingClientRect();
    const itemLeft = scroller.scrollLeft + activeRect.left - scrollerRect.left;
    const itemRight = scroller.scrollLeft + activeRect.right - scrollerRect.left;
    const next = nearestHorizontalScroll({
      scrollLeft: scroller.scrollLeft,
      clientWidth: scroller.clientWidth,
      scrollWidth: scroller.scrollWidth,
      itemLeft,
      itemRight,
    });

    if (next !== scroller.scrollLeft) {
      scroller.scrollLeft = next;
    }
  }, [pathname, visibleKey]);

  return (
    <nav
      aria-label="Memory sections"
      className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-2 md:gap-2 md:px-3"
    >
      <div
        ref={scrollerRef}
        data-testid="memory-section-scroller"
        className="scrollbar-none min-w-0 flex-1 overflow-x-auto overscroll-x-contain md:overflow-visible"
      >
        <div className="flex w-max items-center gap-1 md:w-auto md:flex-wrap md:gap-2">
          {visible.map((section) => {
            const active = section.match(pathname);

            return (
              <Link
                key={section.to}
                ref={active ? activeLinkRef : undefined}
                to={sectionHref(section.to, searchParams)}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'shrink-0 rounded-md px-2.5 py-1 text-sm font-medium transition-colors',
                  active
                    ? 'bg-primary text-primary-foreground shadow-sm'
                    : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                )}
              >
                {section.label}
              </Link>
            );
          })}
        </div>
      </div>

      {/* Create lives in the top-bar Add menu on a phone, so page actions
          (a "New place" / "New thing" button) are omitted there — rendering
          them here would duplicate it. The scrolling section strip above
          stays: the phone's only nav surface is the left drawer, and its own
          Memory row doesn't expose People/Places/Things individually unless
          its chevron is opened, so this strip is the fast path to them.
          `empty:hidden` so a page without actions leaves no gap. */}
      {!isMobile && (
        <Portal id={MEMORY_HUB_ACTIONS_SLOT} className="flex shrink-0 items-center gap-2 empty:hidden" />
      )}
    </nav>
  );
}
