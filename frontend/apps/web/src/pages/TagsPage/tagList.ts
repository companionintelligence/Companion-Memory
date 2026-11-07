import { isReference, type ApolloCache, type Reference } from '@apollo/client';

export interface TagListItem {
  id: string;
  label: string;
  description?: string | null;
  entityCount: number;
}

/**
 * Mirror of the server's `TagService.validateLabel`, so the dialog can tell
 * whether an edit is really a rename — and whether it collides with an
 * existing tag — before it is sent.
 */
export function normalizeTagLabel(label: string): string {
  return label.trim().toLowerCase();
}

/**
 * Drop a tag from the cache so every query that listed it stops showing it —
 * this page's list and the Memory explorer's own `tags` query alike.
 *
 * Both halves are needed. `cache.modify` prunes the connection edge: Apollo
 * filters dangling references out of arrays *of references*, but `tags.edges`
 * is an array of edge objects that merely hold one, so an evicted tag would
 * otherwise leave a live edge pointing at nothing. `cache.evict` then removes
 * the normalized tag itself. Neither query passes arguments to `tags`, so a
 * single field modifier covers both.
 */
export function evictTag(cache: ApolloCache, id: string): void {
  cache.modify({
    fields: {
      tags(existing: { edges: { node: Reference }[] } | Reference = { edges: [] }, { readField }) {
        if (isReference(existing)) {
          return existing;
        }

        return {
          ...existing,
          edges: existing.edges.filter((edge) => readField('id', edge.node) !== id),
        };
      },
    },
  });

  const normalizedId = cache.identify({ id, __typename: 'TagType' });

  if (normalizedId) {
    cache.evict({ id: normalizedId });
    cache.gc();
  }
}
