import { useMemo } from 'react';

import { useQuery } from '@apollo/client';

import { gql } from '@/graphql';

const SEARCH_QUERY = gql(`
  query SearchBoxQuery($query: String!, $includeTypes: [String!], $excludeTypes: [String!]) {
    search(input: { query: $query, includeTypes: $includeTypes, excludeTypes: $excludeTypes }) {
      edges {
        node {
          __typename

          ... on Node {
            id
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
}: {
  searchQuery: string;
  includeTypes?: string[];
  excludeTypes?: string[];
}) {
  const { data, loading, error } = useQuery(SEARCH_QUERY, {
    variables: {
      query: searchQuery,
      excludeTypes: ['answer', 'browser-activity'],
    },
    fetchPolicy: 'cache-and-network',
  });

  const results = useMemo(() => (data?.search?.edges ?? []).map((edge) => edge.node), [data]);

  return {
    data: results,
    loading,
    error,
  };
}
