import { useMemo, useState } from 'react';

import type { ApolloError } from '@apollo/client';
import { useQuery } from '@apollo/client';
import { createHookContext } from '@ci/common';
import { type ResultOf } from '@graphql-typed-document-node/core';

import { gql } from '@/graphql';

const SEARCH_QUERY = gql(`
  query Search($query: String!, $includeTypes: [String!], $excludeTypes: [String!], $tags: [String!], $startTime: String, $endTime: String, $sortBy: String, $sortOrder: String) {
    search(input: { query: $query, includeTypes: $includeTypes, excludeTypes: $excludeTypes, tags: $tags, startTime: $startTime, endTime: $endTime, sortBy: $sortBy, sortOrder: $sortOrder }) {
      edges {
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
    error: ApolloError | undefined;
    activeEntity: EntityItem | null;
  },
  {
    setActiveEntity: (entity: EntityItem | null) => void;
  },
];

function useEntityService({
  searchQuery,
  includeTypes,
  excludeTypes,
  tags,
  startTime,
  endTime,
  sortBy,
  sortOrder,
}: {
  searchQuery: string;
  includeTypes?: string[];
  excludeTypes?: string[];
  tags?: string[];
  startTime?: string;
  endTime?: string;
  sortBy?: string;
  sortOrder?: string;
}): ReturnType {
  const { data, loading, error } = useQuery(SEARCH_QUERY, {
    variables: {
      query: searchQuery,
      includeTypes: includeTypes?.map((type) => type.toLowerCase()) || [],
      excludeTypes: excludeTypes?.map((type) => type.toLowerCase()) || [],
      tags: tags && tags.length > 0 ? tags : undefined,
      startTime: startTime || undefined,
      endTime: endTime || undefined,
      sortBy: sortBy || undefined,
      sortOrder: sortOrder || undefined,
    },
    fetchPolicy: 'cache-and-network',
  });

  const [activeEntity, setActiveEntity] = useState<EntityItem | null>(null);

  const results = useMemo(() => (data?.search?.edges ?? []).map((edge) => edge.node), [data]);

  return [
    {
      data: results,
      loading,
      error,
      activeEntity,
    },
    {
      setActiveEntity,
    },
  ];
}

const { Provider: EntityServiceProvider, useHookContext } = createHookContext(useEntityService);

export { EntityServiceProvider, useHookContext as useEntityService };
