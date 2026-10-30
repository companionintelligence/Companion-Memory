import { useMemo } from 'react';

import { useQuery } from '@apollo/client';

import { gql } from '@/graphql';

export const GET_TAG_SUGGESTIONS = gql(`
  query GetTagSuggestions {
    tags {
      edges {
        node {
          label
        }
      }
    }
  }
`);

const NO_PINNED_TAGS: readonly string[] = [];

/**
 * The user's existing tag vocabulary, optionally prefixed with a small set of
 * context-specific choices. Matching is case-insensitive because tag writes
 * normalize labels to lowercase.
 */
export function useTagSuggestions(pinned: readonly string[] = NO_PINNED_TAGS, enabled = true): string[] {
  const { data } = useQuery(GET_TAG_SUGGESTIONS, { skip: !enabled });

  return useMemo(() => {
    const suggestions: string[] = [];
    const seen = new Set<string>();

    for (const label of [...pinned, ...(data?.tags.edges.map((edge) => edge.node.label) ?? [])]) {
      const trimmed = label.trim();
      const normalized = trimmed.toLowerCase();

      if (trimmed !== '' && !seen.has(normalized)) {
        seen.add(normalized);
        suggestions.push(trimmed);
      }
    }

    return suggestions;
  }, [data, pinned]);
}
