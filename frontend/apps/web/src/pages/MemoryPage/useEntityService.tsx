import { useMemo, useState } from 'react';

import type { ApolloError } from '@apollo/client';
import { useQuery } from '@apollo/client';
import { createHookContext } from '@ci/common';
import { type ResultOf } from '@graphql-typed-document-node/core';

import { gql } from '@/graphql';

const SEARCH_QUERY = gql(`
  query Search($query: String!, $includeTypes: [String!], $excludeTypes: [String!], $eventTypes: [String!]) {
    search(input: { query: $query, includeTypes: $includeTypes, excludeTypes: $excludeTypes, eventTypes: $eventTypes }) {
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

/**
 * Lightweight entity shape for sources that lack full GraphQL entity data —
 * e.g. graph nodes from the REST `/api/graph/*` endpoints. Routed to
 * GenericDetails in the shared EntityDetails sheet. The `__typename` sentinel
 * is intentionally not a real GraphQL type so it never collides with the
 * EntityItem union members (which all end in `Type`).
 */
export interface GenericEntity {
  __typename: 'GenericEntity';
  id: string;
  name?: string | null;
  entityType?: string | null;
  description?: string | null;
  properties?: Record<string, unknown> | null;
}

/** Anything that can populate the shared EntityDetails sheet. */
export type MemoryEntity = EntityItem | GenericEntity;

type ReturnType = [
  {
    data: Array<EntityItem>;
    loading: boolean;
    error: ApolloError | undefined;
    activeEntity: MemoryEntity | null;
  },
  {
    setActiveEntity: (entity: MemoryEntity | null) => void;
  },
];

function useEntityService({
  searchQuery,
  includeTypes,
  excludeTypes,
  eventTypes,
}: {
  searchQuery: string;
  includeTypes?: string[];
  excludeTypes?: string[];
  eventTypes?: string[];
}): ReturnType {
  const { data, loading, error } = useQuery(SEARCH_QUERY, {
    variables: {
      query: searchQuery,
      includeTypes: includeTypes?.map((type) => type.toLowerCase()) || [],
      excludeTypes: excludeTypes?.map((type) => type.toLowerCase()) || [],
      eventTypes: eventTypes || [],
    },
    fetchPolicy: 'cache-and-network',
  });

  const [activeEntity, setActiveEntity] = useState<MemoryEntity | null>(null);

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
