import { useEffect, useState } from 'react';

import { useQuery } from '@apollo/client';

import { gql } from '@/graphql';

// Name suggestions for the Who / Where dimensions. The backend matches those
// filters as case-insensitive *contains* patterns against person and place
// names, so a suggestion is a convenience, not the only valid input: the
// picker also lets any typed text through as a pattern.
export const PERSON_NAME_SUGGESTIONS_QUERY = gql(`
  query PersonNameSuggestions($query: String, $first: Int) {
    people(query: $query, first: $first) {
      edges {
        node {
          id
          name
        }
      }
    }
  }
`);

export const PLACE_NAME_SUGGESTIONS_QUERY = gql(`
  query PlaceNameSuggestions($query: String, $first: Int) {
    places(query: $query, first: $first) {
      edges {
        node {
          id
          name
        }
      }
    }
  }
`);

export const NAME_SUGGESTION_LIMIT = 8;

export interface NameSuggestions {
  names: string[];
  loading: boolean;
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
export const noNameSuggestions: NameSuggestionHook = () => ({ names: [], loading: false });

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

export const usePersonNameSuggestions: NameSuggestionHook = (query, active) => {
  const debounced = useDebounced(query);
  const { data, loading } = useQuery(PERSON_NAME_SUGGESTIONS_QUERY, {
    variables: { query: debounced.trim(), first: NAME_SUGGESTION_LIMIT },
    skip: !active,
  });

  return { names: uniqueNames(data?.people.edges.map((edge) => edge.node) ?? []), loading };
};

export const usePlaceNameSuggestions: NameSuggestionHook = (query, active) => {
  const debounced = useDebounced(query);
  const { data, loading } = useQuery(PLACE_NAME_SUGGESTIONS_QUERY, {
    variables: { query: debounced.trim(), first: NAME_SUGGESTION_LIMIT },
    skip: !active,
  });

  return { names: uniqueNames(data?.places.edges.map((edge) => edge.node) ?? []), loading };
};
