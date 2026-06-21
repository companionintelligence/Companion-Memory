import { useCallback, useMemo, useState } from 'react';

import type { ApolloError } from '@apollo/client';
import { useQuery } from '@apollo/client';
import { createHookContext } from '@ci/common';
import { type ResultOf } from '@graphql-typed-document-node/core';

import { gql } from '@/graphql';

const PAGE_SIZE = 30;

const SEARCH_QUERY = gql(`
  query Search($query: String!, $includeTypes: [String!], $excludeTypes: [String!], $first: Int, $after: String) {
    search(input: { query: $query, includeTypes: $includeTypes, excludeTypes: $excludeTypes, first: $first, after: $after }) {
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        cursor
        node {
          __typename

          ... on Node {
            id
          }

          ...AnswerGridItemData
          ...BrowserActivityGridItemData
          ...CommunicationGridItemData
          ...ConceptGridItemData
          ...ContentGridItemData
          ...EventGridItemData
          ...FileGridItemData
          ...NoteGridItemData
          ...ItemGridItemData
          ...PersonGridItemData
          ...PlaceGridItemData
          ...ThreadGridItemData

          ...TableAnswerRowData
          ...TableCommunicationRowData
          ...TableConceptRowData
          ...TableContentRowData
          ...TableEventRowData
          ...TableFileRowData
          ...TableItemRowData
          ...TableNoteRowData
          ...TablePersonRowData
          ...TablePlaceRowData
          ...TableThreadRowData
          ...TableBrowserActivityRowData

          ...TimelineBrowserActivityCardData
          ...TimelineCommunicationCardData
          ...TimelineEventCardData
        }
      }
    }
  }
`);

export type EntityItem = ResultOf<typeof SEARCH_QUERY>['search']['edges'][number]['node'];

type ReturnType = [
  {
    data: Array<EntityItem>;
    loading: boolean;
    loadingMore: boolean;
    hasNextPage: boolean;
    error: ApolloError | undefined;
    activeEntity: EntityItem | null;
    loadMore: () => void;
  },
  {
    setActiveEntity: (entity: EntityItem | null) => void;
  },
];

function useEntityService({
  searchQuery,
  includeTypes,
  excludeTypes,
}: {
  searchQuery: string;
  includeTypes?: string[];
  excludeTypes?: string[];
}): ReturnType {
  const { data, loading, error, fetchMore } = useQuery(SEARCH_QUERY, {
    variables: {
      query: searchQuery,
      includeTypes: includeTypes?.map((type) => type.toLowerCase()) || [],
      excludeTypes: excludeTypes?.map((type) => type.toLowerCase()) || [],
      first: PAGE_SIZE,
    },
    fetchPolicy: 'cache-and-network',
    notifyOnNetworkStatusChange: true,
  });

  const [activeEntity, setActiveEntity] = useState<EntityItem | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const pageInfo = data?.search?.pageInfo;
  const hasNextPage = pageInfo?.hasNextPage ?? false;

  // Append the next server page (cursor-based) onto the accumulated results.
  const loadMore = useCallback(() => {
    if (!hasNextPage || loadingMore || !pageInfo?.endCursor) {
      return;
    }

    setLoadingMore(true);

    fetchMore({
      variables: { after: pageInfo.endCursor },
      updateQuery: (prev, { fetchMoreResult }) => {
        if (!fetchMoreResult?.search) {
          return prev;
        }

        const prevEdges = prev.search?.edges ?? [];
        const seen = new Set(prevEdges.map((edge) => edge.cursor));
        const nextEdges = fetchMoreResult.search.edges.filter((edge) => !seen.has(edge.cursor));

        return {
          search: {
            ...fetchMoreResult.search,
            edges: [...prevEdges, ...nextEdges],
          },
        };
      },
    }).finally(() => setLoadingMore(false));
  }, [fetchMore, hasNextPage, loadingMore, pageInfo?.endCursor]);

  const results = useMemo(() => (data?.search?.edges ?? []).map((edge) => edge.node), [data]);

  return [
    {
      data: results,
      loading,
      loadingMore,
      hasNextPage,
      error,
      activeEntity,
      loadMore,
    },
    {
      setActiveEntity,
    },
  ];
}

const { Provider: EntityServiceProvider, useHookContext } = createHookContext(useEntityService);

export { EntityServiceProvider, useHookContext as useEntityService };
