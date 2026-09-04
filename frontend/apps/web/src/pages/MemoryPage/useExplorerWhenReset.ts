import { useEffect } from 'react';

import { useLocation, useSearchParams } from 'react-router-dom';

import { hasWhenFilter } from './Components/ExplorerToolbar/filterParams';
import { isEverythingExplorer } from './explorerRoute';

/**
 * On the everything browse (`/memory`), two things only make sense inside a
 * When filter, and fall away when it goes:
 *
 * - a time sort — Newest / Oldest are offered there and nowhere else (see
 *   explorerSortOptions), and drop back to relevance;
 * - the Timeline view — a chronology of a mixed bag with no date range is the
 *   list this page exists to not be, so the tab is hidden and a URL still on
 *   `?view=timeline` lands on List.
 *
 * Whichever of the several affordances cleared the When filter (the chip, the
 * popover, the heatmap, Clear all, a deep link that never had one), the URL is
 * rewritten in place. Returns whether this render's URL still carries the
 * stale time sort, so the caller can already leave it out of the request it
 * is about to send instead of fetching one time-ordered page and re-fetching.
 */
export function useExplorerWhenReset(): { timeSortStale: boolean } {
  const { pathname } = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();

  const whenGone = isEverythingExplorer(pathname) && !hasWhenFilter(searchParams);
  const timeSortStale = whenGone && searchParams.get('sortBy') === 'time';
  const timelineStale = whenGone && searchParams.get('view') === 'timeline';

  useEffect(() => {
    if (!timeSortStale && !timelineStale) {
      return;
    }

    setSearchParams(
      (params) => {
        const next = new URLSearchParams(params);

        if (timeSortStale) {
          next.delete('sortBy');
          next.delete('sortOrder');
        }

        if (timelineStale) {
          next.set('view', 'list');
        }

        return next;
      },
      { replace: true },
    );
  }, [timeSortStale, timelineStale, setSearchParams]);

  return { timeSortStale };
}
