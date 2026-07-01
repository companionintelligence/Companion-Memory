/**
 * The secondary explorer filter dimensions a saved search persists alongside its
 * query / entityTypes / tags. Field names match the backend SavedSearchFiltersInput
 * and the SearchInput filter fields (date is split into startTime/endTime).
 */
export interface SavedSearchFiltersInput {
  eventTypes?: string[];
  startTime?: string;
  endTime?: string;
  sortBy?: string;
  sortOrder?: string;
  connectors?: string[];
  people?: string[];
  places?: string[];
  hasLocation?: boolean;
  semantic?: boolean;
}

/**
 * Capture the explorer's secondary filter dimensions from the URL into a
 * SavedSearchFiltersInput, so a saved search round-trips the full search the user
 * built. Returns undefined when none are active (so we never store an empty `{}`).
 * Mirrors the param names MemoryPage threads into the search — note the date
 * range lives at ?from / ?to, not ?startTime / ?endTime.
 */
export function buildSavedSearchFilters(params: URLSearchParams): SavedSearchFiltersInput | undefined {
  const csv = (key: string) => {
    const value = params.get(key)?.split(',').filter(Boolean);

    return value && value.length > 0 ? value : undefined;
  };

  const filters: SavedSearchFiltersInput = {
    eventTypes: csv('eventTypes'),
    connectors: csv('connectors'),
    people: csv('people'),
    places: csv('places'),
    startTime: params.get('from') || undefined,
    endTime: params.get('to') || undefined,
    sortBy: params.get('sortBy') || undefined,
    sortOrder: params.get('sortOrder') || undefined,
    hasLocation: params.get('hasLocation') === '1' ? true : undefined,
    semantic: params.get('semantic') === '1' ? true : undefined,
  };

  return Object.values(filters).some((value) => value !== undefined) ? filters : undefined;
}
