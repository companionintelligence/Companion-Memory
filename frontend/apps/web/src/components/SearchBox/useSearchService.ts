import { useMemo } from 'react';

import { useQuery } from '@apollo/client';

import { gql } from '@/graphql';

const SEARCH_QUERY = gql(`
  query SearchBoxQuery($query: String!, $includeTypes: [String!], $excludeTypes: [String!], $semantic: Boolean) {
    search(input: { query: $query, includeTypes: $includeTypes, excludeTypes: $excludeTypes, semantic: $semantic }) {
      matchingTags {
        id
        label
      }

      edges {
        node {
          __typename

          ... on Node {
            id
          }

          # Unmasked names so the header box can attach a who/where filter
          # payload to person/place rows (arrow-key add/remove) without
          # per-item useFragment. Aliased to stay clear of the result
          # fragments' own selections.
          ... on PersonType {
            filterName: name
          }

          ... on PlaceType {
            filterName: name
          }

          ...SearchResultCommunicationData
          ...SearchResultConceptData
          ...SearchResultContentData
          ...SearchResultEventData
          ...SearchResultFileData
          ...SearchResultItemData
          ...SearchResultNoteData
          ...SearchResultPersonData
          ...SearchResultPlaceData
          ...SearchResultThreadData
        }
      }
    }
  }
`);

export function useSearchService({
  searchQuery,
  includeTypes,
  excludeTypes,
  semantic,
}: {
  searchQuery: string;
  includeTypes?: string[];
  excludeTypes?: string[];
  semantic?: boolean;
}) {
  const trimmedQuery = searchQuery.trim();

  // An includeTypes allowlist takes precedence (the backend ignores excludeTypes
  // when includeTypes is set); otherwise default the global search box to hide
  // answers and raw browser activity, while still honouring a caller override.
  const includeTypesParam =
    includeTypes && includeTypes.length > 0 ? includeTypes.map((type) => type.toLowerCase()) : undefined;
  const excludeTypesParam = includeTypesParam
    ? undefined
    : (excludeTypes ?? ['answer', 'browser-activity']).map((type) => type.toLowerCase());

  const { data, loading, error } = useQuery(SEARCH_QUERY, {
    variables: {
      query: trimmedQuery,
      includeTypes: includeTypesParam,
      excludeTypes: excludeTypesParam,
      semantic: semantic || undefined,
    },
    // Don't fire a wasted empty-query request on mount; treat skipped as empty.
    skip: !trimmedQuery,
    fetchPolicy: 'cache-and-network',
  });

  const results = useMemo(() => (data?.search?.edges ?? []).map((edge) => edge.node), [data]);
  // Tags whose label matches the query, surfaced as draggable filter rows.
  const tags = useMemo(() => data?.search?.matchingTags ?? [], [data]);

  return {
    data: results,
    tags,
    loading,
    error,
  };
}
