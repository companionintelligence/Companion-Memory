import { useQuery } from '@apollo/client';

import { EVENT_TYPES_QUERY } from '@/components/SearchBox/ActivityFilter';
import { SOURCE_SYSTEMS_QUERY } from '@/components/SearchBox/ConnectorFilter';
import { usePersonNameSuggestions, usePlaceNameSuggestions } from '@/components/SearchBox/useNameSuggestions';

import type { SavedSearchVocabulary } from './SavedSearchFiltersEditor';

/**
 * The saved-search editor's vocabulary, from the same queries the memory
 * toolbar's pickers use — so a saved search can only name a source or an
 * activity the search can actually match, and suggests the same people and
 * places. Until a list has loaded (or if it fails) that field falls back to
 * free text rather than blocking the editor.
 */
export function useSavedSearchVocabulary(): SavedSearchVocabulary {
  const sources = useQuery(SOURCE_SYSTEMS_QUERY, { variables: {} });
  const eventTypes = useQuery(EVENT_TYPES_QUERY);

  return {
    sources: sources.data?.sourceSystems,
    eventTypes: eventTypes.data?.eventTypes,
    usePersonSuggestions: usePersonNameSuggestions,
    usePlaceSuggestions: usePlaceNameSuggestions,
  };
}
