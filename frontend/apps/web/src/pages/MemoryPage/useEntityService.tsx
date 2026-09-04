import { useCallback, useMemo, useState } from 'react';

import type { ApolloError } from '@apollo/client';
import { useQuery } from '@apollo/client';
import { createHookContext } from '@ci/common';
import { ENTITY_TYPE_MAP } from '@ci/common/src/constants';
import { type ResultOf, type VariablesOf } from '@graphql-typed-document-node/core';

import { gql } from '@/graphql';

const PAGE_SIZE = 30;

const SEARCH_QUERY = gql(`
  query Search($query: String!, $includeTypes: [String!], $excludeTypes: [String!], $eventTypes: [String!], $tags: [String!], $startTime: String, $endTime: String, $sortBy: String, $sortOrder: String, $connectors: [String!], $people: [String!], $places: [String!], $hasLocation: Boolean, $bbox: [Float!], $semantic: Boolean, $shareToken: String, $first: Int, $after: String) {
    search(input: { query: $query, includeTypes: $includeTypes, excludeTypes: $excludeTypes, eventTypes: $eventTypes, tags: $tags, startTime: $startTime, endTime: $endTime, sortBy: $sortBy, sortOrder: $sortOrder, connectors: $connectors, people: $people, places: $places, hasLocation: $hasLocation, bbox: $bbox, semantic: $semantic, shareToken: $shareToken, first: $first, after: $after }) {
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
            # Original byte size, so a tile can decline to use a huge original
            # as its thumbnail when no PREVIEW variant has been generated.
            galleryMediaSize: size
          }

          ... on ContentType {
            galleryMimetype: mimetype
            galleryTitle: title
            galleryContentUrl: url
            galleryContentSourceUrl: sourceUrl
            # Media content rows carry no url/sourceUrl of their own — the
            # binary is reachable only through external_id -> ci.files, which
            # ContentResolver resolves into these three fields (mirrors the
            # EventType media aliases below).
            galleryPreviewUrl: previewUrl
            galleryFileUrl: mediaUrl
            galleryMediaSize: mediaSize
            # Provider-hosted player derived server-side from url/externalId
            # (YouTube, Spotify, …). Null for anything without one. The tile
            # shows the poster; the iframe mounts only when the lightbox opens.
            galleryPlayer: player {
              provider
              playerUrl
              posterUrl
              aspectRatio
              mediaKind
            }
            # Resolved link preview from the enrich.unfurl stage: the poster
            # for a Spotify track (no predictable poster URL) or a Netflix
            # episode (no URL at all), plus the provider's title.
            galleryUnfurl: unfurl {
              status
              title
              thumbnailUrl
              canonicalUrl
            }
          }

          ...AnswerGridItemData
          ...BrowserActivityGridItemData
          ...CommunicationGridItemData
          ...ConceptGridItemData
          ...ContentGridItemData
          ...EventGridItemData
          ...FileChunkGridItemData
          ...FileGridItemData
          ...NoteGridItemData
          ...ItemGridItemData
          ...PersonGridItemData
          ...PlaceGridItemData
          ...ProductGridItemData
          ...ReceiptGridItemData
          ...ThreadGridItemData

          ...TableAnswerRowData
          ...TableCommunicationRowData
          ...TableConceptRowData
          ...TableContentRowData
          ...TableEventRowData
          ...TableFileChunkRowData
          ...TableFileRowData
          ...TableItemRowData
          ...TableNoteRowData
          ...TablePersonRowData
          ...TablePlaceRowData
          ...TableProductRowData
          ...TableReceiptRowData
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
            # time_source = 'ingest' means the export gave this record no
            # time and startTime is only the import wall clock (a Google Maps
            # saved place, a Reddit affiliation, …) — getEntityTimestamp reads
            # this to keep such rows OUT of the dated timeline instead of
            # sorting them by the moment they were imported. NOTE: no
            # backtick characters in this comment — it lives inside a
            # backtick-delimited JS template literal, and an unescaped one
            # silently truncates the query string.
            bucketTimeSource: timeSource
            # The event's kind (visited / messaged / traveled / …), unmasked so
            # the Events tab can group its timeline by activity without
            # unmasking the card fragment.
            eventType
            # Coordinates for the map. Events carry a PostGIS Point in
            # locationCoordinates (GeoJSON [lng, lat]) even with no resolved
            # location PlaceType; aliased + unmasked so the map can read it
            # without unmasking the card fragment.
            mapCoordinates: locationCoordinates

            # Photo/video events carry their binary via a linked file; these
            # aliased media fields let the gallery build real thumbnails + a
            # lightbox (mirrors FileType/ContentType above). Null for non-media
            # events. galleryLocationName feeds the derived "Photo · place ·
            # date" tile caption (eventDisplayTitle).
            # Distinct content-type alias: FileType.contentType is String! but
            # EventType.mediaContentType is nullable String, so they can't share
            # the galleryContentType response key (overlapping-fields rule).
            galleryMediaContentType: mediaContentType
            galleryPreviewUrl: previewUrl
            gallerySourceUrl: mediaUrl
            galleryMediaSize: mediaSize
            galleryTitle: title
            galleryLocationName: locationName
          }

          ... on PersonType {
            bucketAppearedAt: appearedAt
          }

          ... on PlaceType {
            bucketAppearedAt: appearedAt
            mapProperties: properties
          }

          ...TimelineFileChunkCardData
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

/**
 * Apollo's normalized cache key for an explorer node (`EventType:<globalId>`),
 * or null for anything that isn't cache-backed — graph nodes arrive as a
 * synthetic `GenericEntity` and members of the search union that don't
 * implement `Node` carry no `id`.
 */
function entityCacheKey(entity: MemoryEntity | null | undefined): string | null {
  if (entity == null || entity.__typename === 'GenericEntity') {
    return null;
  }

  const { id } = entity as { id?: string | null };

  return id ? `${entity.__typename}:${id}` : null;
}

/**
 * Re-resolve the entity backing the open detail drawer against the live query
 * result.
 *
 * `setActiveEntity` is handed the node object the clicked row was rendered
 * from — a snapshot frozen at click time. When the drawer saves, the mutation
 * writes the new field values into the Apollo cache, every watcher of the
 * search query re-reads, and the list row behind the drawer picks up a *new*
 * node object with the new values. Holding the snapshot meant the drawer alone
 * kept rendering the pre-save values, so a successful edit looked like it had
 * been thrown away.
 *
 * Falling back to the snapshot keeps drawers whose entity is no longer in the
 * result set (filters changed underneath it, graph-node drawers) rendering
 * exactly what they render today.
 */
export function resolveLiveEntity<TEntity extends MemoryEntity>(
  selected: TEntity | null,
  results: ReadonlyArray<EntityItem>,
): TEntity | null {
  const key = entityCacheKey(selected);

  if (key == null) {
    return selected;
  }

  const live = results.find((node) => entityCacheKey(node) === key);

  return (live as TEntity | undefined) ?? selected;
}

/**
 * The filter half of the search variables — everything except paging.
 *
 * Exposed so a view that needs its own read of the SAME filtered set can issue
 * it without re-deriving the filters from the URL (which is how the map and the
 * explorer would drift apart). The map's pin query is the one caller: it asks
 * `mapPins` for every located event matching these filters instead of walking
 * this hook's 30-row pages. Paging (`first`/`after`) is deliberately excluded —
 * it belongs to the feed, not to the filter.
 */
export type SearchFilterVariables = Omit<VariablesOf<typeof SEARCH_QUERY>, 'first' | 'after'>;

type ReturnType = [
  {
    data: Array<EntityItem>;
    loading: boolean;
    loadingMore: boolean;
    hasNextPage: boolean;
    totalCount: number;
    error: ApolloError | Error | undefined;
    activeEntity: MemoryEntity | null;
    /** The current filters, minus paging. See {@link SearchFilterVariables}. */
    searchVariables: SearchFilterVariables;
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
  shareToken,
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
  // Shared-search capability token. When set, the server runs the referenced
  // public saved search as its owner and ignores every other filter above —
  // this drives the read-only /shared viewer with the same view components.
  shareToken?: string;
}): ReturnType {
  const searchVariables: SearchFilterVariables = {
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
    shareToken: shareToken || undefined,
  };

  const { data, loading, error, fetchMore, refetch } = useQuery(SEARCH_QUERY, {
    variables: { ...searchVariables, first: PAGE_SIZE },
    fetchPolicy: 'cache-and-network',
    notifyOnNetworkStatusChange: true,
  });

  // The node object captured when a row was clicked. Never rendered directly —
  // see `activeEntity` below, which keeps the drawer in step with the cache.
  const [selectedEntity, setActiveEntity] = useState<MemoryEntity | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  // Apollo's `useQuery` error field only tracks the *initial* query — a
  // rejected `fetchMore()` promise never touches it (see below), so a failed
  // page would otherwise be invisible to every caller that guards on `error`.
  const [loadMoreError, setLoadMoreError] = useState<Error | undefined>(undefined);

  const pageInfo = data?.search?.pageInfo;
  const hasNextPage = pageInfo?.hasNextPage ?? false;
  const totalCount = data?.search?.totalCount ?? 0;

  // Append the next server page (cursor-based) onto the accumulated results.
  const loadMore = useCallback(() => {
    if (!hasNextPage || loadingMore || !pageInfo?.endCursor) {
      return;
    }

    setLoadingMore(true);
    setLoadMoreError(undefined);

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
    })
      .catch((rejection: unknown) => {
        // Apollo's `error` from useQuery does NOT get set by a rejected
        // fetchMore — record it ourselves so callers guarding on `error`
        // (auto-paging effects, the Retry affordance) actually see the
        // failure instead of looping on the same cursor forever.
        setLoadMoreError(rejection instanceof Error ? rejection : new Error('Failed to load more results'));
      })
      .finally(() => setLoadingMore(false));
  }, [fetchMore, hasNextPage, loadingMore, pageInfo?.endCursor]);

  const results = useMemo(() => (data?.search?.edges ?? []).map((edge) => edge.node), [data]);

  // Read the open drawer's entity back out of the live result on every render,
  // so a save made in the drawer is reflected in the drawer and not only in the
  // list behind it.
  const activeEntity = useMemo(() => resolveLiveEntity(selectedEntity, results), [selectedEntity, results]);

  const refetchSearch = useCallback(() => {
    // Retry clears the stuck fetchMore failure too — a fresh refetch (or the
    // next loadMore it enables) deserves its own chance, not an error left
    // over from the page that failed before it.
    setLoadMoreError(undefined);
    void refetch();
  }, [refetch]);

  return [
    {
      data: results,
      loading,
      loadingMore,
      hasNextPage,
      totalCount,
      error: error ?? loadMoreError,
      activeEntity,
      searchVariables,
      loadMore,
      refetch: refetchSearch,
    },
    {
      setActiveEntity,
    },
  ];
}

const {
  Provider: EntityServiceProvider,
  useHookContext,
  useOptionalHookContext,
} = createHookContext(useEntityService, 'useEntityService');

export {
  EntityServiceProvider,
  useHookContext as useEntityService,
  useOptionalHookContext as useOptionalEntityService,
};
