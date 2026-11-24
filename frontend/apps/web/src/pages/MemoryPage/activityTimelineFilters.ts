import { ENTITY_TYPE_MAP } from '@ci/common/src/constants';

import {
  explorerSearchTypeFilters,
  readListParam,
} from '@/pages/MemoryPage/Components/ExplorerToolbar/filterParams';

export interface ActivityTimelineFilterVariables {
  includeTypes?: string[];
  excludeTypes?: string[];
  eventTypes?: string[];
  connectors?: string[];
  people?: string[];
  places?: string[];
  tags?: string[];
  query?: string;
}

function toIndexableTypes(displayTypes: string[]): string[] {
  return displayTypes.map(
    (type) => ENTITY_TYPE_MAP[type as keyof typeof ENTITY_TYPE_MAP] ?? type.toLowerCase(),
  );
}

/**
 * Derive the Memory explorer filters that should constrain the activity heatmap.
 * When no entity-type filter is active, omit include/exclude so the server uses
 * its full browse set — matching an unfiltered search. The type filters come
 * through explorerSearchTypeFilters, so the heatmap sees the same When
 * override as the list (a date range asks only for kinds that have a date).
 */
export function activityTimelineFiltersFromSearchParams(
  params: URLSearchParams,
  pathname?: string,
): ActivityTimelineFilterVariables | undefined {
  const { includeTypes, excludeTypes } = explorerSearchTypeFilters(params, pathname);
  const search = params.get('search')?.trim();
  const tags = readListParam(params, 'tags');
  const eventTypes = params.get('eventTypes')?.split(',').filter(Boolean) ?? [];
  const connectors = params.get('connectors')?.split(',').filter(Boolean) ?? [];
  const people = readListParam(params, 'people');
  const places = readListParam(params, 'places');

  const filters: ActivityTimelineFilterVariables = {};

  if (includeTypes) {
    filters.includeTypes = toIndexableTypes(includeTypes);
  }

  if (excludeTypes) {
    filters.excludeTypes = toIndexableTypes(excludeTypes);
  }

  if (eventTypes.length > 0) {
    filters.eventTypes = eventTypes;
  }

  if (connectors.length > 0) {
    filters.connectors = connectors;
  }

  if (people.length > 0) {
    filters.people = people;
  }

  if (places.length > 0) {
    filters.places = places;
  }

  if (tags.length > 0) {
    filters.tags = tags;
  }

  if (search) {
    filters.query = search;
  }

  return Object.keys(filters).length > 0 ? filters : undefined;
}
