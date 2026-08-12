import { useEffect, useMemo, useState } from 'react';

import { FetchJsonError, fetchJson } from '@ci/common';

type GraphNode = {
  id: string;
  entity_id: string;
  entity_type: string;
  name: string | null;
  description: string | null;
  properties: Record<string, unknown>;
  /** Server-computed edge count (dots payload). Absent on the classic payloads,
   * where the client derives degree from the shipped links. */
  degree?: number;
  /** The event's kind (dots payload, Event nodes only). */
  event_type?: string;
};

type GraphLink = {
  id: string;
  relationship_id: string;
  source: string;
  target: string;
  relationship_type: string;
  strength: number;
  properties: Record<string, unknown>;
};

type TagMatch = {
  active: boolean;
  entityIds: string[];
};

type GraphDataResponse = {
  success: boolean;
  data: {
    nodes: GraphNode[];
    links: GraphLink[];
  };
  tagMatch?: TagMatch;
  // Graph `entity_id`s matching the event-scoped explorer filters (connectors /
  // who / where / how / date range), with `active` following the same
  // param-presence contract as `tagMatch`.
  eventMatch?: TagMatch;
};

type GraphContextDetails = {
  currentUser: {
    entityId: string;
    name: string;
    username: string | null;
  };
  quickStats: {
    totalEntities: number;
    totalPreferences: number;
    totalDislikes: number;
    familySize: number;
  };
};

type GraphContextResponse = {
  success: boolean;
  context: GraphContextDetails | null;
};

type Subgraph = {
  nodes: GraphNode[];
  links: GraphLink[];
};

// Which restrictive explorer filters contributed to the active match scope.
// Drives empty-state messaging ("no nodes match the filters" vs "no data yet").
type FilterScope = { tags: boolean; events: boolean };

type GraphOverviewState = {
  loading: boolean;
  error: string | null;
  userEntityId: string | null;
  subgraph: Subgraph | null;
  quickStats: GraphContextDetails['quickStats'] | null;
  currentUser: GraphContextDetails['currentUser'] | null;
  // Graph `entity_id`s the visible graph should scope to — the intersection of
  // every active restrictive filter (tags ∩ event-scoped dimensions). `null`
  // when no restrictive filter is active (show the whole interactive graph).
  filterMatchedEntityIds: Set<string> | null;
  // Which restrictive dimensions are active, for empty-state messaging.
  filterScope: FilterScope;
};

/**
 * Combine the server's per-dimension match sets into a single scope. Each active
 * filter restricts the graph; multiple active filters AND together (intersection),
 * matching the Search path's combinable-filter semantics. Returns `null` when no
 * restrictive filter is active.
 */
function combineMatches(tagMatch?: TagMatch, eventMatch?: TagMatch): Set<string> | null {
  const tagSet = tagMatch?.active ? new Set(tagMatch.entityIds) : null;
  const eventSet = eventMatch?.active ? new Set(eventMatch.entityIds) : null;

  if (tagSet && eventSet) {
    return new Set([...tagSet].filter((id) => eventSet.has(id)));
  }

  return tagSet ?? eventSet ?? null;
}

/**
 * Keep only links whose BOTH endpoints are present in the node payload. A link
 * dangling against an absent node can never render (the explorer only draws
 * links between loaded nodes), but every dangling link still costs adjacency
 * indexing and neighbor sorting downstream. Older/other servers shipped the
 * account's entire relationship table here — hundreds of thousands of dangling
 * links with real imported data — which froze the main thread for minutes and
 * blocked navigating away from the graph view (#1598).
 */
function dropDanglingLinks(data: { nodes: GraphNode[]; links: GraphLink[] }): {
  nodes: GraphNode[];
  links: GraphLink[];
} {
  const nodeIds = new Set(data.nodes.map((node) => node.id));

  return {
    nodes: data.nodes,
    links: data.links.filter((link) => nodeIds.has(link.source) && nodeIds.has(link.target)),
  };
}

function buildSubgraph(
  data: { nodes: GraphNode[]; links: GraphLink[] },
  seedId: string,
  maxDepth: number,
): Subgraph {
  // A BFS from a seed that isn't in the payload prunes everything reachable
  // only through it — with lots of data that collapses the graph to empty.
  // Hand the payload through unpruned instead; the explorer's visibility
  // expansion still bounds what actually renders.
  if (!data.nodes.some((node) => node.id === seedId)) {
    return { nodes: data.nodes, links: data.links };
  }

  const visited = new Set<string>([seedId]);
  const queue: Array<{ id: string; depth: number }> = [{ id: seedId, depth: 0 }];
  const adjacency = new Map<string, GraphLink[]>();

  for (const link of data.links) {
    adjacency.set(link.source, [...(adjacency.get(link.source) ?? []), link]);
    adjacency.set(link.target, [...(adjacency.get(link.target) ?? []), link]);
  }

  while (queue.length > 0) {
    const current = queue.shift()!;

    if (current.depth >= maxDepth) {
      continue;
    }

    for (const link of adjacency.get(current.id) ?? []) {
      const neighborId = link.source === current.id ? link.target : link.source;
      if (!visited.has(neighborId)) {
        visited.add(neighborId);
        queue.push({ id: neighborId, depth: current.depth + 1 });
      }
    }
  }

  const filteredNodes = data.nodes.filter((node) => visited.has(node.id));
  const nodeIds = new Set(filteredNodes.map((node) => node.id));
  const filteredLinks = data.links.filter((link) => nodeIds.has(link.source) && nodeIds.has(link.target));

  return { nodes: filteredNodes, links: filteredLinks };
}

export interface GraphOverviewOptions {
  maxDepth?: number;
  refreshKey?: number | string;
  /**
   * Explorer entity types (GraphQL vocabulary, e.g. `person`, `place`) the user has selected.
   * Forwarded to `/api/graph/data` so the graph honors the explorer's entity-type filter.
   *
   * `undefined` means the filter is inactive (show all). An array — even an empty one — means
   * the filter is active; an empty array excludes every mappable type (keeping connective nodes).
   */
  includeTypes?: string[];
  // Comma-separated tag labels from the explorer's `tags` URL param. `undefined`
  // leaves the filter inactive; any string (including '') activates it, honoring
  // the "filter active = present, even if empty" contract.
  tags?: string;
  // Event-scoped LifeScope dimensions, mirroring the explorer's Search filters.
  // Each is forwarded to `/api/graph/data` only when it carries a value, so an
  // absent/empty dimension leaves the graph unrestricted by it.
  connectors?: string[];
  people?: string[];
  places?: string[];
  eventTypes?: string[];
  hasLocation?: boolean;
  // Date range (`from`/`to` URL params, ISO strings).
  dateFrom?: string;
  dateTo?: string;
  /**
   * Don't fetch at all (the caller is showing the dots overview instead).
   * While skipped the hook reports `loading: false` with no data.
   */
  skip?: boolean;
}

export function useGraphOverview(
  authToken?: string | null,
  options: GraphOverviewOptions = {},
): GraphOverviewState {
  const maxDepth = options.maxDepth ?? 1;
  const refreshKey = options.refreshKey ?? 0;
  const includeTypesActive = options.includeTypes !== undefined;
  const includeTypesKey = (options.includeTypes ?? []).join(',');
  const tags = options.tags;

  // Stable CSV keys for the event-scoped dimensions: arrays change identity each
  // render, so the effect depends on these joined keys (a change ⇔ a content
  // change), and the request reads the keys directly. Mirrors `includeTypesKey`.
  const connectorsKey = (options.connectors ?? []).join(',');
  const peopleKey = (options.people ?? []).join(',');
  const placesKey = (options.places ?? []).join(',');
  const eventTypesKey = (options.eventTypes ?? []).join(',');
  const hasLocation = options.hasLocation ?? false;
  const dateFrom = options.dateFrom;
  const dateTo = options.dateTo;
  const skip = options.skip ?? false;

  const [state, setState] = useState<GraphOverviewState>({
    loading: !skip,
    error: null,
    userEntityId: null,
    subgraph: null,
    quickStats: null,
    currentUser: null,
    filterMatchedEntityIds: null,
    filterScope: { tags: false, events: false },
  });

  useEffect(() => {
    let cancelled = false;

    if (skip) {
      setState({
        loading: false,
        error: null,
        userEntityId: null,
        subgraph: null,
        quickStats: null,
        currentUser: null,
        filterMatchedEntityIds: null,
        filterScope: { tags: false, events: false },
      });

      return () => {
        cancelled = true;
      };
    }

    async function load() {
      try {
        setState((prev) => ({ ...prev, loading: true, error: null }));

        const headers = authToken ? { Authorization: `Bearer ${authToken}` } : undefined;

        const baseInit: RequestInit = {
          headers,
          credentials: 'include',
        };

        // Forward each filter only when active (param present), so absent params
        // leave the backend returning the whole graph.
        const dataParams = new URLSearchParams();
        if (includeTypesActive) {
          dataParams.set('includeTypes', includeTypesKey);
        }

        if (tags !== undefined) {
          dataParams.set('tags', tags);
        }

        // Event-scoped dimensions: forward only when set, so an unused dimension
        // leaves the graph unrestricted by it.
        if (connectorsKey) {
          dataParams.set('connectors', connectorsKey);
        }

        if (peopleKey) {
          dataParams.set('people', peopleKey);
        }

        if (placesKey) {
          dataParams.set('places', placesKey);
        }

        if (eventTypesKey) {
          dataParams.set('eventTypes', eventTypesKey);
        }

        if (hasLocation) {
          dataParams.set('hasLocation', '1');
        }

        if (dateFrom) {
          dataParams.set('from', dateFrom);
        }

        if (dateTo) {
          dataParams.set('to', dateTo);
        }

        const dataQuery = dataParams.toString();
        const dataUrl = dataQuery ? `/api/graph/data?${dataQuery}` : '/api/graph/data';

        const [contextResponse, graphResponse] = await Promise.all([
          fetchJson<GraphContextResponse>('/api/graph/context', { ...baseInit }),
          fetchJson<GraphDataResponse>(dataUrl, { ...baseInit }),
        ]);

        if (!contextResponse?.success || !contextResponse.context) {
          throw new Error('Unable to resolve user context');
        }

        if (!graphResponse?.success) {
          throw new Error('Graph data request failed');
        }

        const context = contextResponse.context!;
        const userEntityId = context.currentUser.entityId;
        const filterMatchedEntityIds = combineMatches(graphResponse.tagMatch, graphResponse.eventMatch);
        const filterScope: FilterScope = {
          tags: graphResponse.tagMatch?.active === true,
          events: graphResponse.eventMatch?.active === true,
        };

        const graphData = dropDanglingLinks(graphResponse.data);

        // The user-seeded BFS prunes anything beyond `maxDepth` hops from the
        // owner — fine for the click-driven interactive view, but it would drop
        // filter-matched nodes that sit farther out before the filter is even
        // applied. When a restrictive filter is active the view scopes to
        // `filterMatchedEntityIds` directly, so hand the full node/link set
        // through unpruned and let the client do the scoping.
        const subgraph =
          filterScope.tags || filterScope.events
            ? graphData
            : buildSubgraph(graphData, userEntityId, maxDepth);

        if (!cancelled) {
          setState({
            loading: false,
            error: null,
            userEntityId,
            subgraph,
            quickStats: context.quickStats,
            currentUser: context.currentUser,
            filterMatchedEntityIds,
            filterScope,
          });
        }
      } catch (error) {
        if (cancelled) {
          return;
        }

        const message =
          error instanceof FetchJsonError && error.status === 401
            ? 'You need to sign in again to load analytics.'
            : error instanceof Error
              ? error.message
              : 'Unknown error';

        setState({
          loading: false,
          userEntityId: null,
          subgraph: null,
          quickStats: null,
          currentUser: null,
          error: message,
          filterMatchedEntityIds: null,
          filterScope: { tags: false, events: false },
        });
      }
    }

    load();

    return () => {
      cancelled = true;
    };
  }, [
    authToken,
    maxDepth,
    refreshKey,
    includeTypesActive,
    includeTypesKey,
    tags,
    connectorsKey,
    peopleKey,
    placesKey,
    eventTypesKey,
    hasLocation,
    dateFrom,
    dateTo,
    skip,
  ]);

  return useMemo(() => state, [state]);
}

export type { GraphNode, GraphLink, Subgraph };
export type CurrentUser = GraphContextDetails['currentUser'];
