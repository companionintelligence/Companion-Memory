import { useCallback, useMemo } from 'react';

import { useApolloClient } from '@apollo/client';
import { GlobalUID } from '@ci/common';
import type { EntityReferenceConfig, EntityReferenceItem } from '@ci/editor';
import { useNavigate } from 'react-router-dom';

import { gql } from '@/graphql';

/**
 * Types a `[[` reference can point at: everything indexable that has both a
 * human-readable name and a detail route to land on. Deliberately excludes
 * `file-chunk`, `message`, `answer` and `browser-activity` — fragments and
 * machine artefacts nobody would reference by name.
 */
const REFERENCEABLE_TYPES = [
  'note',
  'person',
  'place',
  'event',
  'concept',
  'item',
  'content',
  'communication',
];

/** Detail route per entity-type slug. Types absent here are not linkable. */
const ROUTE_BY_TYPE: Record<string, (id: string) => string> = {
  communication: (id) => `/communications/${id}`,
  concept: (id) => `/concepts/${id}`,
  content: (id) => `/content/${id}`,
  event: (id) => `/events/${id}`,
  item: (id) => `/items/${id}`,
  note: (id) => `/notes/${id}`,
  person: (id) => `/people/${id}`,
  place: (id) => `/places/${id}`,
};

const MAX_RESULTS = 8;

const REFERENCE_SEARCH = gql(`
  query NoteReferenceSearch($query: String!, $includeTypes: [String!]) {
    search(input: { query: $query, includeTypes: $includeTypes }) {
      edges {
        node {
          __typename

          ... on Node {
            id
          }

          ... on NoteType {
            referenceTitle: title
          }

          ... on PersonType {
            referenceName: name
          }

          ... on PlaceType {
            placeReferenceName: name
          }

          ... on ConceptType {
            conceptReferenceName: name
          }

          ... on ItemType {
            itemReferenceName: name
          }

          ... on EventType {
            eventReferenceTitle: title
          }

          ... on ContentType {
            contentReferenceTitle: title
          }

          ... on CommunicationType {
            referencePreview: preview
          }
        }
      }
    }
  }
`);

/** The display field varies per type; first non-empty wins. */
function labelOf(node: Record<string, unknown>): string | null {
  const candidates = [
    node.referenceTitle,
    node.referenceName,
    node.placeReferenceName,
    node.conceptReferenceName,
    node.itemReferenceName,
    node.eventReferenceTitle,
    node.contentReferenceTitle,
    node.referencePreview,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return candidate.trim();
    }
  }

  return null;
}

/**
 * Wires the note editor's `[[` autocomplete to the app: searching is the
 * existing `search` query, and routing is the app's own URL scheme. Returns a
 * stable config plus the click handler that navigates a reference.
 */
export function useEntityReference() {
  const client = useApolloClient();
  const navigate = useNavigate();

  const search = useCallback(
    async (query: string): Promise<EntityReferenceItem[]> => {
      const trimmed = query.trim();

      if (trimmed.length === 0) {
        return [];
      }

      try {
        // cache-first because the plugin calls this per keystroke; backtracking
        // over a query already typed is then free.
        const { data } = await client.query({
          query: REFERENCE_SEARCH,
          variables: { query: trimmed, includeTypes: REFERENCEABLE_TYPES },
          fetchPolicy: 'cache-first',
        });

        const items: EntityReferenceItem[] = [];

        for (const edge of data?.search?.edges ?? []) {
          const node = edge?.node as Record<string, unknown> | null;
          const uid = typeof node?.id === 'string' ? node.id : null;

          if (!uid) {
            continue;
          }

          let type: string;

          try {
            type = GlobalUID.decode(uid).type;
          } catch {
            continue;
          }

          const label = labelOf(node ?? {});

          // A result with no usable name, or of a type with no detail route,
          // would insert a chip that goes nowhere.
          if (!label || !ROUTE_BY_TYPE[type]) {
            continue;
          }

          items.push({ uid, type, label });

          if (items.length >= MAX_RESULTS) {
            break;
          }
        }

        return items;
      } catch {
        // A failed lookup shows the menu's empty state rather than tearing down
        // the editor mid-keystroke.
        return [];
      }
    },
    [client],
  );

  const resolveHref = useCallback(({ uid, type }: { uid: string; type: string }) => {
    const route = ROUTE_BY_TYPE[type];

    if (!route) {
      return '#';
    }

    try {
      return route(GlobalUID.decode(uid).id);
    } catch {
      return '#';
    }
  }, []);

  const onReferenceClick = useCallback(
    (reference: { uid: string; type: string }) => {
      const href = resolveHref(reference);

      if (href !== '#') {
        navigate(href);
      }
    },
    [navigate, resolveHref],
  );

  const reference = useMemo<EntityReferenceConfig>(() => ({ search, resolveHref }), [search, resolveHref]);

  return { reference, onReferenceClick };
}
