import { useEffect, useState } from 'react';

import { useQuery } from '@apollo/client';
import { GlobalUID } from '@ci/common';
import { ENTITY_TYPE_REVERSE_MAP } from '@ci/common/src/constants';
import { useSearchParams } from 'react-router-dom';

import { excludedEntityTypesFor } from '@/components/SearchBox/useDropdown';
import { gql } from '@/graphql';
import type { GetSavedSearchQuery } from '@/graphql/graphql';

import { isRollingDatePreset, resolveDatePreset, type DatePreset } from './Components/ExplorerToolbar/datePresets';

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
  ]) {
    next.delete(key);
  }

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

  if (tags?.length && tags.length > 0) {
    next.set('tags', tags.join(','));
  }

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
    setCsv('people', filters.people);
    setCsv('places', filters.places);

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

    if (filters.hasLocation) {
      next.set('hasLocation', '1');
    }

    if (filters.semantic) {
      next.set('semantic', '1');
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
