import { type ReactNode, useCallback, useState } from 'react';

import { useQuery } from '@apollo/client';
import { EmptyState, LoadingPage, usePageTitle } from '@ci/common';
import { Button, Collapsible, Input } from '@ci/shadcn';
import { ChevronRight, Plus, Search } from '@ci/shadcn/icons';
import { Link, useSearchParams } from 'react-router-dom';

import { ErrorState } from '@/components/ErrorState';
import { SavedSearchIcon } from '@/components/icons';
import { InfiniteListFooter } from '@/components/InfiniteList';
import { PageContent } from '@/components/layout';
import { gql } from '@/graphql';
import { type FragmentType, useFragment } from '@/graphql/fragment-masking';
import { useInfiniteConnection } from '@/hooks/useInfiniteConnection';

import { DeleteSavedSearchModal } from './DeleteSavedSearchModal';
import { SavedSearchGridItemFragment, SavedSearch } from './SavedSearch';
import { ShareSavedSearchModal } from './ShareSavedSearchModal';

const PAGE_SIZE = 30;
const STARTER_PAGE_SIZE = 20;

const GET_SAVED_SEARCHES = gql(`
  query GetSavedSearches($first: Int, $after: String, $query: String, $isSeed: Boolean) {
    savedSearches(first: $first, after: $after, query: $query, isSeed: $isSeed) {
      totalCount
      pageInfo {
        hasNextPage
        endCursor
      }
      edges {
        cursor
        node {
          id
          ...SavedSearchGridItemFragment
        }
      }
    }
  }
`);

type SavedSearchNode = FragmentType<typeof SavedSearchGridItemFragment>;

export function SavedSearchesPage() {
  usePageTitle('Saved Searches - Companion Memory');

  const [searchParams, setSearchParams] = useSearchParams();
  const searchText = searchParams.get('q') ?? '';
  const trimmedQuery = searchText.trim() || undefined;

  const setSearchText = useCallback(
    (value: string) => {
      setSearchParams(
        (params) => {
          const next = new URLSearchParams(params);

          if (value === '') {
            next.delete('q');
          } else {
            next.set('q', value);
          }

          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  const [starterOpen, setStarterOpen] = useState(false);

  const [savedSearchToDelete, setSavedSearchToDelete] = useState<SavedSearchNode | null>(null);
  const [savedSearchToShare, setSavedSearchToShare] = useState<SavedSearchNode | null>(null);

  const openSavedSearchShareModal = (e: React.MouseEvent, savedSearch: SavedSearchNode) => {
    e.preventDefault();
    e.stopPropagation();
    setSavedSearchToShare(savedSearch);
  };

  const openSavedSearchDeleteModal = (e: React.MouseEvent, savedSearch: SavedSearchNode) => {
    e.preventDefault();
    e.stopPropagation();

    setSavedSearchToDelete(savedSearch);
  };

  const {
    data: yourData,
    loading: yourLoading,
    error: yourError,
    fetchMore: fetchMoreYours,
    refetch: refetchYours,
  } = useQuery(GET_SAVED_SEARCHES, {
    variables: { first: PAGE_SIZE, query: trimmedQuery, isSeed: false },
  });

  const yourSearches = yourData?.savedSearches.edges.map((edge) => edge.node) ?? [];

  const fetchMoreYourSearches = useCallback(
    (after: string) =>
      fetchMoreYours({
        variables: { after },
        updateQuery: (prev, { fetchMoreResult }) => {
          if (!fetchMoreResult?.savedSearches) {
            return prev;
          }

          const prevEdges = prev.savedSearches?.edges ?? [];
          const seen = new Set(prevEdges.map((edge) => edge.cursor));

          return {
            savedSearches: {
              ...fetchMoreResult.savedSearches,
              edges: [
                ...prevEdges,
                ...fetchMoreResult.savedSearches.edges.filter((edge) => !seen.has(edge.cursor)),
              ],
            },
          };
        },
      }),
    [fetchMoreYours],
  );

  const yourPagination = useInfiniteConnection({
    connection: yourData?.savedSearches,
    loadedCount: yourSearches.length,
    fetchNextPage: fetchMoreYourSearches,
  });

  const {
    data: starterData,
    loading: starterLoading,
    error: starterError,
    fetchMore: fetchMoreStarter,
    refetch: refetchStarter,
  } = useQuery(GET_SAVED_SEARCHES, {
    variables: { first: STARTER_PAGE_SIZE, query: trimmedQuery, isSeed: true },
    skip: !starterOpen,
  });

  const starterSearches = starterData?.savedSearches.edges.map((edge) => edge.node) ?? [];

  const fetchMoreStarterSearches = useCallback(
    (after: string) =>
      fetchMoreStarter({
        variables: { after },
        updateQuery: (prev, { fetchMoreResult }) => {
          if (!fetchMoreResult?.savedSearches) {
            return prev;
          }

          const prevEdges = prev.savedSearches?.edges ?? [];
          const seen = new Set(prevEdges.map((edge) => edge.cursor));

          return {
            savedSearches: {
              ...fetchMoreResult.savedSearches,
              edges: [
                ...prevEdges,
                ...fetchMoreResult.savedSearches.edges.filter((edge) => !seen.has(edge.cursor)),
              ],
            },
          };
        },
      }),
    [fetchMoreStarter],
  );

  const starterPagination = useInfiniteConnection({
    connection: starterData?.savedSearches,
    loadedCount: starterSearches.length,
    fetchNextPage: fetchMoreStarterSearches,
  });

  let yourContent: ReactNode;
  // `LoadingPage` and `EmptyState` paint as `absolute inset-0` overlays on their
  // nearest positioned ancestor, which here is the whole scrolling page. Nothing
  // sat under them until the Starter searches list opened into that same page on
  // an account with no searches of its own: its rows rendered beneath the "You
  // don't have any Saved Searches yet" block and were unreadable (QA MEM-08).
  // An overlay therefore gets a box of its own, in the flow, and the list opens
  // below it.
  let yourContentIsOverlay = false;

  if (yourLoading && !yourData) {
    yourContent = <LoadingPage />;
    yourContentIsOverlay = true;
  } else if (yourError && yourSearches.length === 0) {
    // `error` used to fall through to the empty state below, positively
    // telling the owner they have saved nothing and inviting them to
    // recreate work that still exists. The empty state is a CLAIM about
    // their data; only make it when the data actually arrived.
    yourContent = (
      <ErrorState
        title="Could not load your saved searches"
        description="They are still saved — this device could not reach them just now."
        onRetry={() => void refetchYours()}
      />
    );
  } else if (yourSearches.length === 0) {
    yourContentIsOverlay = true;
    yourContent = trimmedQuery ? (
      <EmptyState message={`No saved searches match "${trimmedQuery}".`} />
    ) : (
      <EmptyState
        icon={<SavedSearchIcon size={48} colorized={false} />}
        message={
          <div className="flex max-w-md flex-col items-center gap-4 text-center">
            <div>
              <div className="font-medium">You don't have any Saved Searches yet.</div>
              <div className="mt-1 text-sm text-muted-foreground">
                Save a search you are running from Memory's advanced filters, or define one from scratch right
                here.
              </div>
            </div>
            <div className="flex flex-wrap items-center justify-center gap-2">
              <Button asChild>
                <Link to="/memory">
                  <Plus className="mr-2 h-4 w-4" />
                  New saved search
                </Link>
              </Button>
              <Button variant="outline" asChild>
                <Link to="/memory">
                  <Search className="mr-2 h-4 w-4" />
                  Search Memory
                </Link>
              </Button>
            </div>
          </div>
        }
      />
    );
  } else {
    yourContent = (
      <div className="w-full border-t border-border/50">
        {yourSearches.map((savedSearch) => (
          <SavedSearch
            key={savedSearch.id}
            savedSearch={savedSearch}
            openSavedSearchDeleteModal={(e) => openSavedSearchDeleteModal(e, savedSearch)}
            openSavedSearchShareModal={(e) => openSavedSearchShareModal(e, savedSearch)}
          />
        ))}
        <InfiniteListFooter pagination={yourPagination} noun="saved searches" />
      </div>
    );
  }

  let starterContent: ReactNode = null;

  if (starterOpen) {
    if (starterLoading && !starterData) {
      starterContent = <LoadingPage />;
    } else if (starterError && starterSearches.length === 0) {
      starterContent = (
        <ErrorState
          title="Could not load starter searches"
          onRetry={() => void refetchStarter()}
          className="py-6"
        />
      );
    } else if (starterSearches.length === 0) {
      starterContent = (
        <p className="px-2 py-6 text-center text-sm text-muted-foreground sm:px-3">
          {trimmedQuery ? `No starter searches match "${trimmedQuery}".` : 'No starter searches.'}
        </p>
      );
    } else {
      starterContent = (
        <div className="w-full border-t border-border/50">
          {starterSearches.map((savedSearch) => (
            <SavedSearch
              key={savedSearch.id}
              savedSearch={savedSearch}
              openSavedSearchDeleteModal={(e) => openSavedSearchDeleteModal(e, savedSearch)}
              openSavedSearchShareModal={(e) => openSavedSearchShareModal(e, savedSearch)}
            />
          ))}
          <InfiniteListFooter pagination={starterPagination} noun="starter searches" />
        </div>
      );
    }
  }

  return (
    <>
      <PageContent className="gap-3">
        <div className="flex w-full flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <Input
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            placeholder="Search your saved searches by name, description or tag..."
            className="w-full sm:max-w-sm"
          />
          <Button asChild className="shrink-0">
            <Link to="/memory">
              <Plus className="mr-2 h-4 w-4" />
              New saved search
            </Link>
          </Button>
        </div>

        {yourData && !yourError && (
          <div className="text-sm text-muted-foreground">
            {yourPagination.totalCount} saved {yourPagination.totalCount === 1 ? 'search' : 'searches'}
          </div>
        )}

        {yourContentIsOverlay ? <div className="relative min-h-72 w-full">{yourContent}</div> : yourContent}

        <Collapsible open={starterOpen} onOpenChange={setStarterOpen} className="w-full pt-2">
          <Collapsible.Trigger asChild>
            <Button
              variant="ghost"
              size="sm"
              className="h-8 gap-1.5 px-2 text-sm text-muted-foreground hover:text-foreground"
            >
              <ChevronRight
                className={
                  starterOpen ? 'h-4 w-4 rotate-90 transition-transform' : 'h-4 w-4 transition-transform'
                }
              />
              Starter searches
            </Button>
          </Collapsible.Trigger>
          <Collapsible.Content>{starterContent}</Collapsible.Content>
        </Collapsible>
      </PageContent>

      {savedSearchToDelete && (
        <DeleteSavedSearchModal
          savedSearchId={useFragment(SavedSearchGridItemFragment, savedSearchToDelete).id}
          onClose={() => setSavedSearchToDelete(null)}
        />
      )}

      {savedSearchToShare && (
        <ShareSavedSearchModal savedSearch={savedSearchToShare} onClose={() => setSavedSearchToShare(null)} />
      )}
    </>
  );
}
