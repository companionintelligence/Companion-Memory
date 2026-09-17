import { lazy } from 'react';

import { usePageTitle } from '@ci/common';
import { Navigate, useLocation, useSearchParams } from 'react-router-dom';

import { ResponsiveLoader } from '@/components/ResponsiveLoader';

import { EntityServiceProvider } from '../MemoryPage/useEntityService';

import { parseBbox } from './bbox';
import { resolveExplorerTypes } from './Components/ExplorerToolbar/filterParams';
import { useExplorerWhenReset } from './useExplorerWhenReset';
import { useSavedSearchResolution } from './useSavedSearchResolution';

const DesktopPage = lazy(() => import('./DesktopMemoryPage'));
const MobilePage = lazy(() => import('./MobileMemoryPage'));

/**
 * What a BARE `/memory` means: the list view, every entity kind. The Power
 * Rail's Memory row itself opens here — no type chip, same as clearing filters.
 *
 * What a BARE `/memory/events` means: the list view of the happenings browse.
 * That page is scoped by its route, not by a chip: it only ever shows the
 * kinds with a moment of their own — events, messages and browser activity
 * (EVENTS_EXPLORER_TYPES) — and its What bar offers only those. So the bare
 * URL needs no type filter, and a link that names other kinds is clipped to
 * those three by resolveExplorerTypes rather than widened. A search that must
 * cover everything goes to `/memory`, which is where the global search box
 * commits.
 *
 * ONLY the fully-bare URL gets a default; a deep link that carries any param
 * keeps its exact meaning. In-page filter changes never re-trigger it either,
 * because the toolbar always keeps `view` while clearing filters.
 */
export const DEFAULT_MEMORY_SEARCH = 'view=list';
export const DEFAULT_MEMORY_EVENTS_SEARCH = 'view=list';

/**
 * The explorer's query comes from the URL and nothing else. Every view — List,
 * Gallery, Map, Graph, Timeline — reads this one filter set, so the same link
 * means the same thing wherever it opens.
 *
 * Two filters used to be derived from `?view=` here instead: the gallery forced
 * `includeFiles` on and the map forced `hasLocation` on. Switching views
 * silently changed the result set, and the toolbar showed no sign of it — the
 * map's coercion also made the whole browse events-only, because `hasLocation`
 * puts the server on its event-filter path. Both are gone. Files now follow the
 * What picker's File type like every other type, and the Map tab applies
 * "Has a location" as a visible, removable filter when you click it (see
 * DesktopMemoryPage/MobileMemoryPage). Filters a view genuinely cannot honour
 * are marked as such in the toolbar — see Components/ExplorerToolbar/viewFilterSupport.
 */
export function MemoryPage() {
  usePageTitle('Memory - Companion Memory');
  const { pathname } = useLocation();
  const [searchParams] = useSearchParams();

  // Resolves `?saved_search=` into the params below, above the Desktop/Mobile
  // split, so both read the same resolved filters (see useSavedSearchResolution).
  useSavedSearchResolution();

  // `/memory` offers Newest / Oldest and the Timeline view only inside a When
  // filter; once that filter is gone the sort goes back to relevance and the
  // view to List (rewritten in the URL, and the sort already left out of this
  // render's request).
  const { timeSortStale } = useExplorerWhenReset();

  // Before the provider mounts, so the URL always carries its view.
  if ([...searchParams.keys()].length === 0) {
    const search = pathname === '/memory/events' ? DEFAULT_MEMORY_EVENTS_SEARCH : DEFAULT_MEMORY_SEARCH;

    return <Navigate to={{ search }} replace />;
  }

  // Type filters with the route's scope and the When override applied: the
  // events browse only asks for its three kinds, and a date range only asks
  // for kinds that have a date (see resolveExplorerTypes). When that leaves
  // nothing to ask for, the query is skipped outright — an empty include list
  // would read as "everything" — and the view explains why instead.
  const typeFilters = resolveExplorerTypes(searchParams, pathname);

  return (
    <EntityServiceProvider
      args={[
        {
          searchQuery: searchParams.get('search') || '',
          includeTypes: typeFilters.includeTypes,
          excludeTypes: typeFilters.excludeTypes,
          skip: typeFilters.nothingLeft,
          eventTypes: searchParams.get('eventTypes')?.split(',').filter(Boolean) || undefined,
          tags: searchParams.get('tags')?.split(',').filter(Boolean) || undefined,
          startTime: searchParams.get('from') || undefined,
          endTime: searchParams.get('to') || undefined,
          sortBy: timeSortStale ? undefined : searchParams.get('sortBy') || undefined,
          sortOrder: timeSortStale ? undefined : searchParams.get('sortOrder') || undefined,
          // LifeScope-parity dimensions (who / where / connector / semantic).
          connectors: searchParams.get('connectors')?.split(',').filter(Boolean) || undefined,
          people: searchParams.get('people')?.split(',').filter(Boolean) || undefined,
          places: searchParams.get('places')?.split(',').filter(Boolean) || undefined,
          hasLocation: searchParams.get('hasLocation') === '1' || undefined,
          bbox: parseBbox(searchParams.get('bbox')),
          semantic: searchParams.get('semantic') === '1' || undefined,
          direction: searchParams.get('direction') || undefined,
        },
      ]}
    >
      <ResponsiveLoader desktop={DesktopPage} mobile={MobilePage} />
    </EntityServiceProvider>
  );
}
