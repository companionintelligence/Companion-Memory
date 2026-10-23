import { ENTITY_TYPE_MAP } from '@ci/common/src/constants';

import type { LocalListQuery, LocalListSort } from '@/api/powersync/localList';

import { readAreasParam } from '../bbox';
import { readListParam, resolveExplorerTypes } from '../Components/ExplorerToolbar/filterParams';

/**
 * Explorer filter params the device cannot apply. Since the device record
 * carries connector, people, place and coordinates (recipe version 2), that
 * is only semantic search, which needs the appliance's embeddings. Listed so
 * the view can say what was set aside, in the URL's own names.
 */
export const LOCAL_LIST_IGNORED_PARAMS = ['semantic'] as const;

export interface LocalListOptions {
  query: LocalListQuery;
  /** Filter params present in the URL that the device ignores. */
  ignored: string[];
  /** The explorer asked for nothing the device could hold (a When filter over undated kinds only). */
  nothingLeft: boolean;
}

/** A What-picker display name (`Thing`, `Browser`) as the device's lower-case type. */
function toEntityType(displayName: string): string {
  return ENTITY_TYPE_MAP[displayName as keyof typeof ENTITY_TYPE_MAP] ?? displayName.toLowerCase();
}

function sortFromParams(params: URLSearchParams): LocalListSort {
  if (params.get('sortBy') !== 'time') {
    return 'relevance';
  }

  return params.get('sortOrder') === 'asc' ? 'oldest' : 'newest';
}

/**
 * The offline list's query from the explorer URL, read the way MemoryPage
 * reads it for the appliance: the same type resolution (route scope, Activity
 * pin, When override), the same `?tags=` list, the same `from` / `to`.
 */
export function localListOptionsFromParams(params: URLSearchParams, pathname?: string): LocalListOptions {
  const types = resolveExplorerTypes(params, pathname);
  const ignored = LOCAL_LIST_IGNORED_PARAMS.filter((key) => {
    const value = params.get(key);

    return value != null && value !== '' && value !== '0';
  });
  const list = (key: string) => {
    const values = readListParam(params, key);

    return values.length > 0 ? values : undefined;
  };

  const csv = (key: string) => {
    const values = params.get(key)?.split(',').filter(Boolean) ?? [];

    return values.length > 0 ? values : undefined;
  };

  // The same reading MemoryPage gives the appliance's request.
  return {
    query: {
      query: params.get('search')?.trim() ?? '',
      includeTypes: types.includeTypes?.map(toEntityType),
      excludeTypes: types.excludeTypes?.map(toEntityType),
      tags: list('tags'),
      from: params.get('from') || undefined,
      to: params.get('to') || undefined,
      sort: sortFromParams(params),
      connectors: csv('connectors'),
      direction: params.get('direction') || undefined,
      eventTypes: csv('eventTypes'),
      fileKinds: csv('fileKinds'),
      people: list('people'),
      places: list('places'),
      hasLocation: params.get('hasLocation') === '1' || undefined,
      areas: readAreasParam(params),
    },
    ignored,
    nothingLeft: types.nothingLeft,
  };
}
