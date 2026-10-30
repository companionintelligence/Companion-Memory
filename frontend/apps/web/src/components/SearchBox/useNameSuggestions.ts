import { useCallback, useEffect, useRef, useState } from 'react';

import { useQuery } from '@apollo/client';

import { gql } from '@/graphql';

// Name suggestions for the Who / Where dimensions. The backend matches those
// filters as case-insensitive *contains* patterns against person and place
// names, so a suggestion is a convenience, not the only valid input: the
// picker also lets any typed text through as a pattern.
export const PERSON_NAME_SUGGESTIONS_QUERY = gql(`
  query PersonNameSuggestions($query: String, $first: Int, $after: String) {
    people(query: $query, first: $first, after: $after) {
      edges {
        cursor
        node {
          id
          name
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`);

export const PLACE_NAME_SUGGESTIONS_QUERY = gql(`
  query PlaceNameSuggestions($query: String, $first: Int, $after: String) {
    places(query: $query, first: $first, after: $after) {
      edges {
        cursor
        node {
          id
          name
        }
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
`);

export const NAME_SUGGESTION_LIMIT = 8;

export interface NameSuggestions {
  names: string[];
  loading: boolean;
  /** More names exist past the ones listed; `loadMore` fetches the next page of them. */
  hasMore: boolean;
  loadingMore: boolean;
  loadMore: () => void;
}

/**
 * A hook that turns the picker's typed text into name suggestions. `active`
 * is the picker's open state — nothing is fetched while it is closed, so a
 * page that mounts several pickers pays for none of them until one opens.
 * Passed into presentational components as a prop, so it MUST be a stable
 * (module-level) function: swapping hooks between renders breaks React.
 */
export type NameSuggestionHook = (query: string, active: boolean) => NameSuggestions;

/** For hosts without data access (stories, unit tests): never suggests. */
export const noNameSuggestions: NameSuggestionHook = () => ({
  names: [],
  loading: false,
  hasMore: false,
  loadingMore: false,
  loadMore: () => undefined,
});

function useDebounced(value: string, delayMs = 200): string {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);

    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}

function uniqueNames(nodes: ReadonlyArray<{ name?: string | null }>): string[] {
  const seen = new Set<string>();
  const names: string[] = [];

  for (const { name } of nodes) {
    const trimmed = name?.trim();

    if (trimmed && !seen.has(trimmed.toLocaleLowerCase())) {
      seen.add(trimmed.toLocaleLowerCase());
      names.push(trimmed);
    }
  }

  return names;
}

interface NameEdge {
  cursor: string;
  node: { id: string; name?: string | null };
}

interface NameConnection {
  edges: NameEdge[];
  pageInfo: { hasNextPage: boolean; endCursor?: string | null };
}

/** The pages after the first, appended to it — once each, whatever Apollo replays. */
function appendPage<T extends NameConnection>(previous: T, next: T): T {
  const seen = new Set(previous.edges.map((edge) => edge.cursor));

  return {
    ...previous,
    ...next,
    edges: [...previous.edges, ...next.edges.filter((edge) => !seen.has(edge.cursor))],
  };
}

/**
 * The paging shared by the two hooks below: whether a page follows the ones
 * listed, and one guarded fetch of it. The query is sized to the picker's
 * list, so the first page is rarely the whole vocabulary — the explorer's Who
 * offered eight people and stopped there, with no way to the rest.
 *
 * A page that fails stays failed (`hasMore` turns false) until the typed text
 * changes: the picker asks again whenever its list's end is in view, and an
 * error that cleared itself would be asked for in a loop.
 */
function usePaging(
  connection: NameConnection | undefined,
  debouncedQuery: string,
  fetchNext: (after: string) => Promise<unknown>,
): Pick<NameSuggestions, 'hasMore' | 'loadingMore' | 'loadMore'> {
  const [loadingMore, setLoadingMore] = useState(false);
  const [failed, setFailed] = useState(false);
  // Read through a ref so `loadMore` need not change identity as pages land,
  // which would re-arm the picker's end-of-list observer for nothing.
  const state = useRef({ connection, loadingMore, failed, fetchNext });

  state.current = { connection, loadingMore, failed, fetchNext };

  useEffect(() => {
    setFailed(false);
  }, [debouncedQuery]);

  const loadMore = useCallback(() => {
    const current = state.current;
    const endCursor = current.connection?.pageInfo.endCursor;

    if (!current.connection?.pageInfo.hasNextPage || current.loadingMore || current.failed || !endCursor) {
      return;
    }

    setLoadingMore(true);
    current
      .fetchNext(endCursor)
      .catch(() => setFailed(true))
      .finally(() => setLoadingMore(false));
  }, []);

  return {
    hasMore: (connection?.pageInfo.hasNextPage ?? false) && !failed,
    loadingMore,
    loadMore,
  };
}

export const usePersonNameSuggestions: NameSuggestionHook = (query, active) => {
  const debounced = useDebounced(query).trim();
  const { data, loading, fetchMore } = useQuery(PERSON_NAME_SUGGESTIONS_QUERY, {
    variables: { query: debounced, first: NAME_SUGGESTION_LIMIT },
    skip: !active,
  });

  const fetchNext = useCallback(
    (after: string) =>
      fetchMore({
        variables: { after },
        updateQuery: (previous, { fetchMoreResult }) =>
          fetchMoreResult
            ? { ...previous, people: appendPage(previous.people, fetchMoreResult.people) }
            : previous,
      }),
    [fetchMore],
  );

  return {
    names: uniqueNames(data?.people.edges.map((edge) => edge.node) ?? []),
    loading,
    ...usePaging(data?.people, debounced, fetchNext),
  };
};

export const usePlaceNameSuggestions: NameSuggestionHook = (query, active) => {
  const debounced = useDebounced(query).trim();
  const { data, loading, fetchMore } = useQuery(PLACE_NAME_SUGGESTIONS_QUERY, {
    variables: { query: debounced, first: NAME_SUGGESTION_LIMIT },
    skip: !active,
  });

  const fetchNext = useCallback(
    (after: string) =>
      fetchMore({
        variables: { after },
        updateQuery: (previous, { fetchMoreResult }) =>
          fetchMoreResult
            ? { ...previous, places: appendPage(previous.places, fetchMoreResult.places) }
            : previous,
      }),
    [fetchMore],
  );

  return {
    names: uniqueNames(data?.places.edges.map((edge) => edge.node) ?? []),
    loading,
    ...usePaging(data?.places, debounced, fetchNext),
  };
};
