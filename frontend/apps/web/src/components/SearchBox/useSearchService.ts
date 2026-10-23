import { useEffect, useMemo, useState } from 'react';

import { useQuery } from '@apollo/client';
import { useOptionalConnectionMode } from '@ci/common';

import { type LocalSearchNode, searchLocal } from '@/api/powersync/localSearch';
import { getReplicaDatabase } from '@/api/powersync/session';
import { gql } from '@/graphql';
import type { SearchBoxQueryQuery } from '@/graphql/graphql';

const SEARCH_QUERY = gql(`
  query SearchBoxQuery($query: String!, $includeTypes: [String!], $excludeTypes: [String!], $semantic: Boolean) {
    search(input: { query: $query, includeTypes: $includeTypes, excludeTypes: $excludeTypes, semantic: $semantic }) {
      matchingTags {
        id
        label
      }

      edges {
        node {
          __typename

          ... on Node {
            id
          }

          # Unmasked names so the header box can attach a who/where filter
          # payload to person/place rows (arrow-key add/remove) without
          # per-item useFragment. Aliased to stay clear of the result
          # fragments' own selections.
          ... on PersonType {
            filterName: name
          }

          ... on PlaceType {
            filterName: name
          }

          ...SearchResultCommunicationData
          ...SearchResultConceptData
          ...SearchResultContentData
          ...SearchResultEventData
          ...SearchResultFileData
          ...SearchResultItemData
          ...SearchResultNoteData
          ...SearchResultPersonData
          ...SearchResultPlaceData
          ...SearchResultThreadData
        }
      }
    }
  }
`);

/** Where the current results came from. */
export type SearchSource = 'appliance' | 'device';

type ApplianceNode = NonNullable<SearchBoxQueryQuery['search']>['edges'][number]['node'];

/**
 * The header box's results: the appliance's `search` query while it answers,
 * and this device's synced search index when it does not.
 *
 * The fallback is taken in two cases, because neither alone covers the other:
 * the connection chip says the appliance is unreachable (so no request is even
 * sent, and the box answers at once), or a request that was sent fails with a
 * network error (the appliance went away between probes). A GraphQL error
 * from a reachable appliance is not a reason to answer from the phone — it is
 * surfaced as before.
 *
 * Device results are shaped like the appliance's nodes (see localSearch.ts),
 * so the result rows need not know which answered; `source` is for the one
 * place that should say so.
 */
export function useSearchService({
  searchQuery,
  includeTypes,
  excludeTypes,
  semantic,
}: {
  searchQuery: string;
  includeTypes?: string[];
  excludeTypes?: string[];
  semantic?: boolean;
}) {
  const trimmedQuery = searchQuery.trim();
  // Optional: the box also renders inside modals mounted in trees without a
  // connection probe (AddRelationshipModal on an entity page, tests), where
  // the appliance is the only source.
  const mode = useOptionalConnectionMode()?.mode ?? 'connected';
  const applianceUnreachable = mode !== 'connected';

  // An includeTypes allowlist takes precedence (the backend ignores excludeTypes
  // when includeTypes is set); otherwise default the global search box to hide
  // answers and raw browser activity, while still honouring a caller override.
  const includeTypesParam =
    includeTypes && includeTypes.length > 0 ? includeTypes.map((type) => type.toLowerCase()) : undefined;
  const excludeTypesParam = includeTypesParam
    ? undefined
    : (excludeTypes ?? ['answer', 'browser-activity']).map((type) => type.toLowerCase());

  const { data, loading, error } = useQuery(SEARCH_QUERY, {
    variables: {
      query: trimmedQuery,
      includeTypes: includeTypesParam,
      excludeTypes: excludeTypesParam,
      semantic: semantic || undefined,
    },
    // Don't fire a wasted empty-query request on mount; treat skipped as empty.
    // Nor one at an appliance the chip already found unreachable.
    skip: !trimmedQuery || applianceUnreachable,
    fetchPolicy: 'cache-and-network',
  });

  const networkFailed = Boolean(error?.networkError);
  const useDevice = Boolean(trimmedQuery) && (applianceUnreachable || networkFailed);
  // The type arrays are rebuilt every render; the effect below keys on their
  // contents, not their identity.
  const includeKey = includeTypesParam?.join(',');
  const excludeKey = excludeTypesParam?.join(',');

  const [device, setDevice] = useState<{
    query: string;
    nodes: LocalSearchNode[];
    tags: Array<{ id: string; label: string }>;
    loading: boolean;
  }>({ query: '', nodes: [], tags: [], loading: false });

  useEffect(() => {
    if (!useDevice) {
      return;
    }

    const database = getReplicaDatabase();

    if (!database) {
      setDevice({ query: trimmedQuery, nodes: [], tags: [], loading: false });

      return;
    }

    let cancelled = false;

    setDevice((previous) => ({ ...previous, loading: true }));

    void searchLocal(database, {
      query: trimmedQuery,
      includeTypes: includeKey === undefined ? undefined : includeKey.split(','),
      excludeTypes: excludeKey === undefined ? undefined : excludeKey.split(','),
    })
      .then((result) => {
        if (!cancelled) {
          setDevice({ query: trimmedQuery, nodes: result.nodes, tags: result.tags, loading: false });
        }
      })
      .catch((searchError: unknown) => {
        console.warn('[search] On-device search failed', searchError);

        if (!cancelled) {
          setDevice({ query: trimmedQuery, nodes: [], tags: [], loading: false });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [useDevice, trimmedQuery, includeKey, excludeKey]);

  const applianceResults = useMemo(() => (data?.search?.edges ?? []).map((edge) => edge.node), [data]);
  // Tags whose label matches the query, surfaced as draggable filter rows.
  const applianceTags = useMemo(() => data?.search?.matchingTags ?? [], [data]);

  if (useDevice) {
    // Results for a previous query are not shown against the current one.
    const current = device.query === trimmedQuery;

    return {
      // The device nodes carry exactly the fields the result fragments read, in
      // the appliance's shape; the cast is the one place that is asserted.
      data: (current ? device.nodes : []) as unknown as ApplianceNode[],
      tags: current ? device.tags : [],
      loading: !current || device.loading,
      // A network failure is what sent us here; it is not an error to show.
      error: undefined,
      source: 'device' as const satisfies SearchSource,
    };
  }

  return {
    data: applianceResults,
    tags: applianceTags,
    loading,
    error,
    source: 'appliance' as const satisfies SearchSource,
  };
}
