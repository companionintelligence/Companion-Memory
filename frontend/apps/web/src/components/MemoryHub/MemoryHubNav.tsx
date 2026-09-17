import type { ReactNode } from 'react';

import { useDeviceLayout } from '@ci/common';
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

export function MemoryHubNav({ actions }: { actions?: ReactNode }) {
  const { pathname } = useLocation();
  const [searchParams] = useSearchParams();
  const { isMobile } = useDeviceLayout();
  const { isFeatureEnabled } = useFeatures();

  const visible = MEMORY_HUB_SECTIONS.filter((section) => !section.flag || isFeatureEnabled(section.flag));

  return (
    <nav
      aria-label="Memory sections"
      className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-2 md:gap-2 md:px-3"
    >
      <div className="scrollbar-none min-w-0 flex-1 overflow-x-auto overscroll-x-contain md:overflow-visible">
        <div className="flex w-max items-center gap-1 md:w-auto md:flex-wrap md:gap-2">
          {visible.map((section) => {
            const active = section.match(pathname);

            return (
              <Link
                key={section.to}
                to={sectionHref(section.to, searchParams)}
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
          its chevron is opened, so this strip is the fast path to them. */}
      {actions && !isMobile && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </nav>
  );
}
