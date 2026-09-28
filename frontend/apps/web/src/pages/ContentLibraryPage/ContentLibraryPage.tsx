import { useCallback, useMemo } from 'react';

import { useQuery } from '@apollo/client';
import { EmptyState, GlobalUID, usePageTitle } from '@ci/common';
import { Button } from '@ci/shadcn';
import { FileType, Shapes } from '@ci/shadcn/icons';
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom';

import { ErrorState } from '@/components/ErrorState';
import { InfiniteListFooter } from '@/components/InfiniteList';
import { PageContent } from '@/components/layout';
import { MemoryHubShell } from '@/components/MemoryHub';
import { PullToRefresh } from '@/components/PullToRefresh';
import { ConnectorFilter } from '@/components/SearchBox/ConnectorFilter';
import { gql } from '@/graphql';
import { useInfiniteConnection } from '@/hooks/useInfiniteConnection';

import { ContentFacetFilter, readFacetParam } from './ContentFacetFilter';
import { ContentSheet } from './ContentSheet';
import { ContentTile } from './ContentTile';

/** Content is a thumbnail grid, so a page is a few rows rather than a few items. */
export const PAGE_SIZE = 50;

// The library's three filters live in the URL: `types`, `mimetypes` and
// `connectors` (the How filter, the same param the explorer uses), each a
// comma-separated list. They are sent as query variables only when set, so an
// unfiltered library asks for exactly what it always did.
const CONTENT_FILTER_PARAMS = ['types', 'mimetypes', 'connectors'] as const;

export const GET_CONTENT_FACETS = gql(`
  query GetContentFacets {
    contentFacets {
      types
      mimetypes
      sourceSystems
    }
  }
`);

export const GET_CONTENTS = gql(`
  query GetContents(
    $first: Int
    $after: String
    $query: String
    $types: [String!]
    $mimetypes: [String!]
    $connectors: [String!]
  ) {
    contents(
      first: $first
      after: $after
      query: $query
      types: $types
      mimetypes: $mimetypes
      connectors: $connectors
    ) {
      totalCount
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        cursor
        node {
          id
          ...ContentTileFragment
        }
      }
    }
  }
`);

/**
 * `/memory/content` — the paginated `ci.content` library. Rows backed by a file
 * (external_id -> ci.files) arrive with previewUrl/mediaUrl already resolved by
 * the server, so a tile needs no second lookup to show its thumbnail.
 */
export function ContentLibraryPage() {
  usePageTitle('Content - Companion Memory');

  const navigate = useNavigate();
  // The open row lives in the URL rather than in local state, so it has a
  // shareable address and Back closes the drawer. `/memory/content/:contentId`
  // carries the RAW uuid, matching /people/:id and /places/:id; the GraphQL
  // `id` is the base64 global id, so each direction converts explicitly.
  const { contentId } = useParams<{ contentId: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  // The drawer is a path segment; the search and every facet are query params.
  // Opening and closing must carry `location.search` along, or the first click
  // silently resets the library to an empty, queryless page behind the drawer.
  const { search: queryString } = useLocation();

  const filterVariables = useMemo(() => {
    // The header search box's `?search=` (see isLiveSearchPath): title, text or URL.
    const query = searchParams.get('search')?.trim() ?? '';
    const types = readFacetParam(searchParams, 'types');
    const mimetypes = readFacetParam(searchParams, 'mimetypes');
    const connectors = readFacetParam(searchParams, 'connectors');

    return {
      ...(query ? { query } : {}),
      ...(types.length > 0 ? { types } : {}),
      ...(mimetypes.length > 0 ? { mimetypes } : {}),
      ...(connectors.length > 0 ? { connectors } : {}),
    };
  }, [searchParams]);
  const filtered = Object.keys(filterVariables).some((key) => key !== 'query');

  const { data, loading, error, fetchMore, refetch } = useQuery(GET_CONTENTS, {
    variables: { first: PAGE_SIZE, ...filterVariables },
    fetchPolicy: 'cache-and-network',
    notifyOnNetworkStatusChange: true,
  });
  // `error` matters here as much as it does for the page query below: a facet
  // query that fails leaves `facetData` undefined, and the pickers must not
  // read that as "this account has no types". Measured live 2026-09-22 —
  // Postgres out of /dev/shm, every load — they said exactly that.
  const { data: facetData, error: facetError } = useQuery(GET_CONTENT_FACETS);
  const facets = facetData?.contentFacets;
  const facetsUnavailable = facetError != null && facets == null;

  const clearFilters = useCallback(
    () =>
      setSearchParams((params) => {
        for (const param of CONTENT_FILTER_PARAMS) {
          params.delete(param);
        }

        return params;
      }),
    [setSearchParams],
  );

  const contents = useMemo(() => (data?.contents.edges ?? []).map((edge) => edge.node), [data]);

  const fetchNextPage = useCallback(
    (after: string) =>
      fetchMore({
        variables: { after },
        updateQuery: (prev, { fetchMoreResult }) => {
          if (!fetchMoreResult?.contents) {
            return prev;
          }

          const prevEdges = prev.contents?.edges ?? [];
          const seen = new Set(prevEdges.map((edge) => edge.cursor));
          const nextEdges = fetchMoreResult.contents.edges.filter((edge) => !seen.has(edge.cursor));

          return {
            contents: {
              ...fetchMoreResult.contents,
              edges: [...prevEdges, ...nextEdges],
            },
          };
        },
      }),
    [fetchMore],
  );

  const pagination = useInfiniteConnection({
    connection: data?.contents,
    loadedCount: contents.length,
    fetchNextPage,
  });

  const selectedGlobalId = useMemo(() => {
    if (!contentId) {
      return null;
    }

    // A hand-typed or stale id still encodes fine; the sheet simply stays
    // closed when the query returns nothing.
    return GlobalUID.encode('content', contentId);
  }, [contentId]);

  const handleSelect = useCallback(
    (globalId: string) => navigate(`/memory/content/${GlobalUID.parse('content', globalId)}${queryString}`),
    [navigate, queryString],
  );
  const handleClose = useCallback(() => navigate(`/memory/content${queryString}`), [navigate, queryString]);
  const handleChanged = useCallback(() => void refetch(), [refetch]);

  return (
    <PullToRefresh onRefresh={refetch}>
      <PageContent ref={pagination.scrollRef} className="gap-4 p-0">
        <MemoryHubShell>
          <div className="flex flex-col gap-4 px-2 pb-3 sm:px-4 sm:pb-4">
            {/* Content-specific filters, like the Things page's category and
                brand: each picker lists what the user's rows actually carry. */}
            <div className="flex flex-wrap items-center gap-2" data-testid="content-filters">
              <ContentFacetFilter
                label="Content type"
                param="types"
                options={facets?.types ?? []}
                unavailable={facetsUnavailable}
                icon={Shapes}
              />
              <ContentFacetFilter
                label="File type"
                param="mimetypes"
                options={facets?.mimetypes ?? []}
                unavailable={facetsUnavailable}
                icon={FileType}
              />
              <ConnectorFilter modal={false} label="How" includeTypes={['content']} />
              {filtered && (
                <Button type="button" variant="ghost" size="sm" onClick={clearFilters}>
                  Clear filters
                </Button>
              )}
            </div>

            {loading && contents.length === 0 ? (
              <p className="text-sm text-muted-foreground">Loading content…</p>
            ) : error && contents.length === 0 ? (
              // `error` was not destructured, so a failed query rendered the
              // branch below with an empty array: a blank tile area under an
              // InfiniteListFooter reading "0 of 0 loaded · end". That footer is
              // the worst part — it is a positive statement that the library has
              // been fully enumerated and holds nothing.
              <ErrorState
                title="Could not load your content"
                description="Your files are still here — this device could not reach them just now."
                onRetry={() => void refetch()}
              />
            ) : contents.length === 0 ? (
              <EmptyState
                message={
                  filtered || filterVariables.query
                    ? 'Nothing matches this search. Clear a filter or change the query to widen the library.'
                    : 'Nothing here yet. Content appears as your sources sync and files finish parsing.'
                }
              />
            ) : (
              <>
                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4">
                  {contents.map((content) => (
                    <ContentTile key={content.id} content={content} onSelect={handleSelect} />
                  ))}
                </div>

                <InfiniteListFooter pagination={pagination} noun="content" />
              </>
            )}

            <ContentSheet contentId={selectedGlobalId} onClose={handleClose} onChanged={handleChanged} />
          </div>
        </MemoryHubShell>
      </PageContent>
    </PullToRefresh>
  );
}
