import { useCallback, useMemo, useState } from 'react';

import type { ApolloError } from '@apollo/client';
import { useQuery } from '@apollo/client';
import { createHookContext } from '@ci/common';
import { ENTITY_TYPE_MAP } from '@ci/common/src/constants';
import { type ResultOf } from '@graphql-typed-document-node/core';

import { gql } from '@/graphql';

const PAGE_SIZE = 30;

const SEARCH_QUERY = gql(`
  query Search($query: String!, $includeTypes: [String!], $excludeTypes: [String!], $eventTypes: [String!], $tags: [String!], $startTime: String, $endTime: String, $sortBy: String, $sortOrder: String, $connectors: [String!], $people: [String!], $places: [String!], $hasLocation: Boolean, $bbox: [Float!], $semantic: Boolean, $first: Int, $after: String) {
    search(input: { query: $query, includeTypes: $includeTypes, excludeTypes: $excludeTypes, eventTypes: $eventTypes, tags: $tags, startTime: $startTime, endTime: $endTime, sortBy: $sortBy, sortOrder: $sortOrder, connectors: $connectors, people: $people, places: $places, hasLocation: $hasLocation, bbox: $bbox, semantic: $semantic, first: $first, after: $after }) {
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

          ... on Taggable {
            tags {
              label
            }
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

          # Aliased timestamps so date-grouping (getEntityTimestamp) can read the
          # field the server sorts by without unmasking spread fragments. Mirrors
          # SearchResolver.getEntityTimestamp (time ?? startTime).
          ... on CommunicationType {
            bucketTime: time
          }

          ... on BrowserActivityType {
            bucketTime: time
          }

          ... on EventType {
            bucketStartTime: startTime
          }
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

/** Narrow {@link MemoryEntity} to a single `__typename` (used by detail bodies). */
export type MemoryEntityOf<TName extends MemoryEntity['__typename']> = Extract<
  MemoryEntity,
  { __typename: TName }
>;

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
    refetch: () => void;
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
  bbox,
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
  bbox?: number[];
  semantic?: boolean;
}): ReturnType {
  const { data, loading, error, fetchMore, refetch } = useQuery(SEARCH_QUERY, {
    variables: {
      query: searchQuery,
      // Map display names to the backend IndexableEntity values via the shared
      // map — naive toLowerCase() turned 'Browser'/'Thing' into 'browser'/'thing'
      // (not 'browser-activity'/'item'), so those two filters silently no-op'd.
      includeTypes:
        includeTypes?.map(
          (type) => ENTITY_TYPE_MAP[type as keyof typeof ENTITY_TYPE_MAP] ?? type.toLowerCase(),
        ) || [],
      excludeTypes:
        excludeTypes?.map(
          (type) => ENTITY_TYPE_MAP[type as keyof typeof ENTITY_TYPE_MAP] ?? type.toLowerCase(),
        ) || [],
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
      bbox: bbox && bbox.length === 4 ? bbox : undefined,
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

  const refetchSearch = useCallback(() => {
    void refetch();
  }, [refetch]);

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
      refetch: refetchSearch,
    },
    {
      setActiveEntity,
    },
  ];
}

const { Provider: EntityServiceProvider, useHookContext } = createHookContext(useEntityService);

export { EntityServiceProvider, useHookContext as useEntityService };
