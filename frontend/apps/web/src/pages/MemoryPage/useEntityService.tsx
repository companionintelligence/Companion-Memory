import { useCallback, useMemo, useState } from 'react';

import type { ApolloError } from '@apollo/client';
import { useQuery } from '@apollo/client';
import { createHookContext } from '@ci/common';
import { type ResultOf } from '@graphql-typed-document-node/core';

import { gql } from '@/graphql';

const PAGE_SIZE = 30;

const SEARCH_QUERY = gql(`
  query Search($query: String!, $includeTypes: [String!], $excludeTypes: [String!], $eventTypes: [String!], $tags: [String!], $startTime: String, $endTime: String, $sortBy: String, $sortOrder: String, $connectors: [String!], $people: [String!], $places: [String!], $hasLocation: Boolean, $semantic: Boolean, $first: Int, $after: String) {
    search(input: { query: $query, includeTypes: $includeTypes, excludeTypes: $excludeTypes, eventTypes: $eventTypes, tags: $tags, startTime: $startTime, endTime: $endTime, sortBy: $sortBy, sortOrder: $sortOrder, connectors: $connectors, people: $people, places: $places, hasLocation: $hasLocation, semantic: $semantic, first: $first, after: $after }) {
      totalCount
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

          # Unmasked media fields so the gallery can build real thumbnails and a
          # cross-item lightbox without per-item useFragment calls. Aliased to
          # stay clear of the grid fragments' own selections.
          ... on FileType {
            galleryContentType: contentType
            galleryFilename: filename
            galleryPreviewUrl: previewUrl
            gallerySourceUrl: sourceUrl
          }

          ... on ContentType {
            galleryMimetype: mimetype
            galleryTitle: title
            galleryContentUrl: url
            galleryContentSourceUrl: sourceUrl
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
    loadingMore: boolean;
    hasNextPage: boolean;
    totalCount: number;
    error: ApolloError | undefined;
    activeEntity: MemoryEntity | null;
    loadMore: () => void;
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
  tags,
  startTime,
  endTime,
  sortBy,
  sortOrder,
  connectors,
  people,
  places,
  hasLocation,
  semantic,
}: {
  searchQuery: string;
  includeTypes?: string[];
  excludeTypes?: string[];
  eventTypes?: string[];
  tags?: string[];
  startTime?: string;
  endTime?: string;
  sortBy?: string;
  sortOrder?: string;
  connectors?: string[];
  people?: string[];
  places?: string[];
  hasLocation?: boolean;
  semantic?: boolean;
}): ReturnType {
  const { data, loading, error, fetchMore } = useQuery(SEARCH_QUERY, {
    variables: {
      query: searchQuery,
      includeTypes: includeTypes?.map((type) => type.toLowerCase()) || [],
      excludeTypes: excludeTypes?.map((type) => type.toLowerCase()) || [],
      eventTypes: eventTypes || [],
      tags: tags && tags.length > 0 ? tags : undefined,
      startTime: startTime || undefined,
      endTime: endTime || undefined,
      sortBy: sortBy || undefined,
      sortOrder: sortOrder || undefined,
      connectors: connectors && connectors.length > 0 ? connectors : undefined,
      people: people && people.length > 0 ? people : undefined,
      places: places && places.length > 0 ? places : undefined,
      hasLocation: hasLocation || undefined,
      semantic: semantic || undefined,
      first: PAGE_SIZE,
    },
    fetchPolicy: 'cache-and-network',
    notifyOnNetworkStatusChange: true,
  });

  const [activeEntity, setActiveEntity] = useState<MemoryEntity | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);

  const pageInfo = data?.search?.pageInfo;
  const hasNextPage = pageInfo?.hasNextPage ?? false;
  const totalCount = data?.search?.totalCount ?? 0;

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
      totalCount,
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
