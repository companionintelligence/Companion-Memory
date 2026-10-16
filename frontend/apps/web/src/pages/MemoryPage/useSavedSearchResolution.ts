import { useEffect, useState } from 'react';

import { useQuery } from '@apollo/client';
import { GlobalUID } from '@ci/common';
import { ENTITY_TYPE_REVERSE_MAP } from '@ci/common/src/constants';
import { useSearchParams } from 'react-router-dom';

import { excludedEntityTypesFor } from '@/components/SearchBox/useDropdown';
import { gql } from '@/graphql';
import type { GetSavedSearchQuery } from '@/graphql/graphql';

import { AREAS_PARAM, asAreas, formatAreas, LEGACY_BBOX_PARAM } from './bbox';
import {
  isRollingDatePreset,
  resolveDatePreset,
  type DatePreset,
} from './Components/ExplorerToolbar/datePresets';
import { LOADED_SEARCH_PARAM } from './Components/ExplorerToolbar/filterParams';

export const GET_SAVED_SEARCH = gql(`
  query GetSavedSearch($id: ID!) {
    savedSearch(id: $id) {
      id
      name
      description
      query
      entityTypes
      tags
      filters {
        eventTypes
        startTime
        endTime
        datePreset
        sortBy
        sortOrder
        connectors
        people
        places
        hasLocation
        semantic
        direction
        fileKinds
        view
        areas
        bbox
      }
    }
  }
`);

type ResolvedSavedSearch = NonNullable<GetSavedSearchQuery['savedSearch']>;

/**
 * Rewrites `params` to the explorer filters `savedSearch` defines, clearing
 * every param a saved search owns first so a stale filter from whatever the
 * user was looking at cannot survive the restore. Pure and side-effect-free
 * so both the `?saved_search=` deep-link resolver below and an in-page picker
 * (which needs to apply a search without a fresh mount to re-run that
 * resolver) can share one definition of what "load this search" means.
 *
 * The result also carries `?loaded_search=<id>` (see `LOADED_SEARCH_PARAM`):
 * the one-shot `?saved_search=` trigger is consumed here, but the explorer
 * still has to know which search it is showing so Save can offer to update
 * it. The two are different params on purpose — the trigger re-applies the
 * definition on every mount, which would wipe the person's edits each time
 * they came back to the page; the marker only remembers.
 */
export function applySavedSearchToParams(
  params: URLSearchParams,
  savedSearch: ResolvedSavedSearch,
): URLSearchParams {
  const next = new URLSearchParams(params);
  const { entityTypes, query, tags, filters } = savedSearch;

  for (const key of [
    'search',
    'excludedEntityTypes',
    'includedEntityTypes',
    'saved_search',
    'tags',
    'eventTypes',
    'from',
    'to',
    'when',
    'sortBy',
    'sortOrder',
    'connectors',
    'people',
    'places',
    'hasLocation',
    'semantic',
    'direction',
    'fileKinds',
    AREAS_PARAM,
    LEGACY_BBOX_PARAM,
    LOADED_SEARCH_PARAM,
  ]) {
    next.delete(key);
  }

  next.set(LOADED_SEARCH_PARAM, GlobalUID.parse('saved-search', savedSearch.id));

  if (query?.trim()) {
    next.set('search', query.trim());
  }

  if (entityTypes?.length && entityTypes.length > 0) {
    const reverseMapped = entityTypes.map(
      (type) => ENTITY_TYPE_REVERSE_MAP[type as keyof typeof ENTITY_TYPE_REVERSE_MAP],
    );
    // Same exclude-list the What pickers write, so a restored search hides
    // answers too rather than mixing them in with the saved types.
    const inverseEntityTypes = excludedEntityTypesFor(reverseMapped);

    if (inverseEntityTypes.length > 0) {
      next.set('excludedEntityTypes', inverseEntityTypes.join(','));
    }
  }

  //Updating included entities is handled in SearchBox.tsx

  // The free-text lists go back one value per param occurrence, the way the
  // pickers write them, so a saved street address survives the round trip.
  const setList = (param: string, value?: readonly string[] | null) => {
    for (const entry of value ?? []) {
      next.append(param, entry);
    }
  };

  setList('tags', tags);

  // Secondary dimensions (who / where / when / how / sort / semantic). The
  // `filters` keys mirror the explorer URL params 1:1 except for the date
  // range (startTime -> ?from, endTime -> ?to).
  if (filters) {
    const setCsv = (param: string, value?: readonly string[] | null) => {
      if (value && value.length > 0) {
        next.set(param, value.join(','));
      }
    };

    setCsv('eventTypes', filters.eventTypes);
    setCsv('connectors', filters.connectors);
    setCsv('fileKinds', filters.fileKinds);
    setList('people', filters.people);
    setList('places', filters.places);

    if (isRollingDatePreset(filters.datePreset)) {
      next.set('when', filters.datePreset);
      const { from, to } = resolveDatePreset(filters.datePreset as DatePreset);
      next.set('from', from);
      next.set('to', to);
    } else {
      if (filters.startTime) {
        next.set('from', filters.startTime);
      }

      if (filters.endTime) {
        next.set('to', filters.endTime);
      }

      if (filters.startTime || filters.endTime) {
        next.set('when', 'custom');
      }
    }

    if (filters.sortBy) {
      next.set('sortBy', filters.sortBy);
    }

    if (filters.sortOrder) {
      next.set('sortOrder', filters.sortOrder);
    }

    // The saved rectangles go back into ?areas, the param the map's drawing
    // tools write, so the map draws them and fits to them on load. A row from
    // before the list existed carries one `bbox`; it becomes a one-entry list.
    const areas = asAreas(filters.areas) ?? asAreas(filters.bbox ? [filters.bbox] : null);

    // Only the row's own flag: the rectangles are ORed with the Where names
    // on the server, so a search drawn with one is not located-only, and
    // forcing the flag would drop its named-place matches without coordinates.
    if (filters.hasLocation) {
      next.set('hasLocation', '1');
    }

    if (filters.semantic) {
      next.set('semantic', '1');
    }

    if (filters.direction) {
      next.set('direction', filters.direction);
    }

    // A saved view wins over whatever view the page was on; a search saved
    // without one keeps the current view, so old searches stay as they were.
    if (filters.view) {
      next.set('view', filters.view);
    }

    if (areas) {
      next.set(AREAS_PARAM, formatAreas(areas));
    }
  }

  return next;
}

/**
 * Resolves `?saved_search=<id>` into the explorer's URL filter params.
 *
 * Lives in the shared MemoryPage parent (not in DesktopMemoryPage, where this
 * used to be) so both DesktopMemoryPage and MobileMemoryPage — which read
 * their filters from the same URL via useEntityService — receive the
 * resolved saved search identically. Before this moved here, opening a
 * `?saved_search=` link on a phone silently landed on the unfiltered
 * explorer, because MobileMemoryPage never read the param.
 */
export function useSavedSearchResolution() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [searchId, setSearchId] = useState<string | null>(null);

  const { data: savedSearchData } = useQuery(GET_SAVED_SEARCH, {
    variables: { id: GlobalUID.encode('saved-search', searchId!) },
    skip: !searchId,
  });

  useEffect(() => {
    if (savedSearchData?.savedSearch) {
      setSearchParams(applySavedSearchToParams(searchParams, savedSearchData.savedSearch));
    }
  }, [searchId, savedSearchData]);

  useEffect(() => {
    const savedSearchId = searchParams.get('saved_search') || '';
    if (savedSearchId?.length > 0) {
      setSearchId(savedSearchId);
    }
  }, []);
}
