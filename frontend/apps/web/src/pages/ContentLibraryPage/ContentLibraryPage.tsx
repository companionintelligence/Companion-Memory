import { useCallback, useMemo } from 'react';

import { useQuery } from '@apollo/client';
import { EmptyState, GlobalUID, usePageTitle } from '@ci/common';
import { useNavigate, useParams } from 'react-router-dom';

import { ErrorState } from '@/components/ErrorState';
import { InfiniteListFooter } from '@/components/InfiniteList';
import { PageContent } from '@/components/layout';
import { MemoryHubShell } from '@/components/MemoryHub';
import { PullToRefresh } from '@/components/PullToRefresh';
import { gql } from '@/graphql';
import { useInfiniteConnection } from '@/hooks/useInfiniteConnection';

import { ContentSheet } from './ContentSheet';
import { ContentTile } from './ContentTile';

/** Content is a thumbnail grid, so a page is a few rows rather than a few items. */
export const PAGE_SIZE = 50;

const GET_CONTENTS = gql(`
  query GetContents($first: Int, $after: String) {
    contents(first: $first, after: $after) {
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
  usePageTitle('Content - Companion Intelligence');

  const navigate = useNavigate();
  // The open row lives in the URL rather than in local state, so it has a
  // shareable address and Back closes the drawer. `/memory/content/:contentId`
  // carries the RAW uuid, matching /people/:id and /places/:id; the GraphQL
  // `id` is the base64 global id, so each direction converts explicitly.
  const { contentId } = useParams<{ contentId: string }>();

  const { data, loading, error, fetchMore, refetch } = useQuery(GET_CONTENTS, {
    variables: { first: PAGE_SIZE },
    fetchPolicy: 'cache-and-network',
    notifyOnNetworkStatusChange: true,
  });

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
    (globalId: string) => navigate(`/memory/content/${GlobalUID.parse('content', globalId)}`),
    [navigate],
  );
  const handleClose = useCallback(() => navigate('/memory/content'), [navigate]);
  const handleChanged = useCallback(() => void refetch(), [refetch]);

  return (
    <PullToRefresh onRefresh={refetch}>
      <PageContent ref={pagination.scrollRef} className="gap-4 p-0">
        <MemoryHubShell>
          <div className="flex flex-col gap-4 px-2 pb-3 sm:px-4 sm:pb-4">
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
              <EmptyState message="Nothing here yet. Content appears as your sources sync and files finish parsing." />
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
