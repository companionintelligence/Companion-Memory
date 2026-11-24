/**
 * The secondary explorer filter dimensions a saved search persists alongside its
 * query / entityTypes / tags. Field names match the backend SavedSearchFiltersInput
 * and the SearchInput filter fields (date is split into startTime/endTime).
 */
import { readMessageDirection } from '@/components/SearchBox/DirectionToggle';

import { readAreasParam } from './bbox';
import { isRollingDatePreset } from './Components/ExplorerToolbar/datePresets';
import { readListParam } from './Components/ExplorerToolbar/filterParams';
export interface SavedSearchFiltersInput {
  eventTypes?: string[];
  datePreset?: string;
  startTime?: string;
  endTime?: string;
  sortBy?: string;
  sortOrder?: string;
  connectors?: string[];
  people?: string[];
  places?: string[];
  hasLocation?: boolean;
  semantic?: boolean;
  direction?: string;
  fileKinds?: string[];
  view?: string;
  /** The map's searched areas, each `[minLon, minLat, maxLon, maxLat]`, ORed; see `bbox.ts`. */
  areas?: number[][];
}

/**
 * Capture the explorer's secondary filter dimensions from the URL into a
 * SavedSearchFiltersInput, so a saved search round-trips the full search the user
 * built. Returns undefined when none are active (so we never store an empty `{}`).
 * Rolling When presets persist as `datePreset`; custom ranges use startTime/endTime.
 */
export function buildSavedSearchFilters(params: URLSearchParams): SavedSearchFiltersInput | undefined {
  const csv = (key: string) => {
    const value = params.get(key)?.split(',').filter(Boolean);

    return value && value.length > 0 ? value : undefined;
  };

  // Who / Where carry one value per param occurrence (a place can be a full
  // street address, commas and all); see readListParam.
  const list = (key: string) => {
    const value = readListParam(params, key);

    return value.length > 0 ? value : undefined;
  };

  const when = params.get('when');
  const rollingPreset = isRollingDatePreset(when) ? when : undefined;

  const filters: SavedSearchFiltersInput = {
    eventTypes: csv('eventTypes'),
    connectors: csv('connectors'),
    people: list('people'),
    places: list('places'),
    datePreset: rollingPreset,
    startTime: rollingPreset ? undefined : params.get('from') || undefined,
    endTime: rollingPreset ? undefined : params.get('to') || undefined,
    sortBy: params.get('sortBy') || undefined,
    sortOrder: params.get('sortOrder') || undefined,
    hasLocation: params.get('hasLocation') === '1' ? true : undefined,
    semantic: params.get('semantic') === '1' ? true : undefined,
    direction: readMessageDirection(params.get('direction')) ?? undefined,
    fileKinds: csv('fileKinds'),
    // The view is part of the search as the person built it: a Where search
    // saved from the map comes back on the map. The list is the default, so it
    // is not worth remembering and does not make an otherwise empty search one.
    view: params.get('view') && params.get('view') !== 'list' ? params.get('view')! : undefined,
    // The rectangles drawn on the map are part of the search: they are what
    // make a trip a place on the globe rather than a place name.
    areas: readAreasParam(params),
  };

  return Object.values(filters).some((value) => value !== undefined) ? filters : undefined;
}
