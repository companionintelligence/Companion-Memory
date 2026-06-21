import { useEffect, useMemo, useState } from 'react';

import { fetchJson } from '@ci/common';

type GraphNode = {
  id: string;
  entity_id: string;
  entity_type: string;
  name: string | null;
  description: string | null;
  properties: Record<string, unknown>;
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

type GraphDataResponse = {
  success: boolean;
  data: {
    nodes: GraphNode[];
    links: GraphLink[];
  };
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

type GraphOverviewState = {
  loading: boolean;
  error: string | null;
  userEntityId: string | null;
  subgraph: Subgraph | null;
  quickStats: GraphContextDetails['quickStats'] | null;
  currentUser: GraphContextDetails['currentUser'] | null;
};

function buildSubgraph(
  data: { nodes: GraphNode[]; links: GraphLink[] },
  seedId: string,
  maxDepth: number,
): Subgraph {
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
}

export function useGraphOverview(
  authToken?: string | null,
  options: GraphOverviewOptions = {},
): GraphOverviewState {
  const maxDepth = options.maxDepth ?? 1;
  const refreshKey = options.refreshKey ?? 0;
  const includeTypesActive = options.includeTypes !== undefined;
  const includeTypesKey = (options.includeTypes ?? []).join(',');

  const [state, setState] = useState<GraphOverviewState>({
    loading: true,
    error: null,
    userEntityId: null,
    subgraph: null,
    quickStats: null,
    currentUser: null,
  });

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        setState((prev) => ({ ...prev, loading: true, error: null }));

        const headers = authToken ? { Authorization: `Bearer ${authToken}` } : undefined;

        const baseInit: RequestInit = {
          headers,
          credentials: 'include',
        };

        const dataUrl = includeTypesActive
          ? `/api/graph/data?includeTypes=${encodeURIComponent(includeTypesKey)}`
          : '/api/graph/data';

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
        const subgraph = buildSubgraph(graphResponse.data, userEntityId, maxDepth);

        if (!cancelled) {
          setState({
            loading: false,
            error: null,
            userEntityId,
            subgraph,
            quickStats: context.quickStats,
            currentUser: context.currentUser,
          });
        }
      } catch (error) {
        if (cancelled) {
          return;
        }

        const message =
          error instanceof Error && /401/.test(error.message)
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
        });
      }
    }

    load();

    return () => {
      cancelled = true;
    };
  }, [authToken, maxDepth, refreshKey, includeTypesActive, includeTypesKey]);

  return useMemo(() => state, [state]);
}

export type { GraphNode, GraphLink, Subgraph };
export type CurrentUser = GraphContextDetails['currentUser'];
