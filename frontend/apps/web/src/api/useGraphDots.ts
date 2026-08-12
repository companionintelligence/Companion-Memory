import { useEffect, useMemo, useState } from 'react';

import { FetchJsonError, fetchJson } from '@ci/common';

import type { GraphNode } from '@/api/useGraphOverview';

type DotPayloadNode = {
  id: string;
  entity_id: string;
  entity_type: string;
  name: string | null;
  degree: number;
  event_type?: string;
};

/** Account-wide relatedness — entities with ≥1 relationship vs alone. */
export type GraphConnectivity = {
  total: number;
  related: number;
  isolated: number;
  /** related / total in [0, 1]. */
  relatedRatio: number;
};

type GraphDotsResponse = {
  success: boolean;
  data: {
    nodes: DotPayloadNode[];
  };
  /** Total active entities per type, so the UI can report coverage. */
  counts?: Record<string, number>;
  truncated?: boolean;
  connectivity?: GraphConnectivity;
};

type GraphContextResponse = {
  success: boolean;
  context: {
    currentUser: { entityId: string; name: string; username: string | null };
  } | null;
};

export interface GraphDotsOptions {
  /** Same contract as useGraphOverview: `undefined` = filter inactive. */
  includeTypes?: string[];
  /** Narrows Event dots to these kinds (the How dimension). */
  eventTypes?: string[];
  refreshKey?: number | string;
  /** Don't fetch (the classic overview is active instead). */
  skip?: boolean;
}

export interface GraphDotsState {
  /** True only until the first paintable page arrives (or fails). */
  loading: boolean;
  /**
   * True while later pages are still densifying the constellation. The canvas
   * should already be interactive; this is atmosphere, not a blocker.
   */
  hydrating: boolean;
  error: string | null;
  /** Dots as full GraphNodes (empty description/properties) so the ForceGraph renders them as-is. */
  nodes: GraphNode[];
  userEntityId: string | null;
  counts: Record<string, number>;
  truncated: boolean;
  /** Key graph health metric from the server (related vs alone). */
  connectivity: GraphConnectivity | null;
}

const IDLE_STATE: GraphDotsState = {
  loading: false,
  hydrating: false,
  error: null,
  nodes: [],
  userEntityId: null,
  counts: {},
  truncated: false,
  connectivity: null,
};

/**
 * First paint budget — just over the ForceGraph LOD threshold so the overview
 * opens as dots (not a labelled web) without waiting on the full 2k payload.
 */
const FIRST_PAINT_LIMIT = 320;
/** Full constellation budget (matches the API default / DOTS_LIMIT). */
const FULL_LIMIT = 2000;

function toGraphNodes(nodes: DotPayloadNode[]): GraphNode[] {
  return nodes.map((node) => ({
    id: node.id,
    entity_id: node.entity_id,
    entity_type: node.entity_type,
    name: node.name,
    description: null,
    properties: {},
    degree: node.degree,
    ...(node.event_type != null ? { event_type: node.event_type } : {}),
  }));
}

function mergeNodes(existing: GraphNode[], incoming: GraphNode[]): GraphNode[] {
  if (existing.length === 0) {
    return incoming;
  }

  const byId = new Map(existing.map((node) => [node.id, node]));
  for (const node of incoming) {
    // Prefer the fuller/later degree; keep prior object identity when unchanged.
    const prior = byId.get(node.id);
    if (!prior || (node.degree ?? 0) !== (prior.degree ?? 0) || node.name !== prior.name) {
      byId.set(node.id, node);
    }
  }

  return Array.from(byId.values());
}

function buildDotsUrl(
  limit: number,
  includeTypesActive: boolean,
  includeTypesKey: string,
  eventTypesKey: string,
) {
  const params = new URLSearchParams();
  params.set('limit', String(limit));
  if (includeTypesActive) {
    params.set('includeTypes', includeTypesKey);
  }

  if (eventTypesKey) {
    params.set('eventTypes', eventTypesKey);
  }

  return `/api/graph/dots?${params.toString()}`;
}

/**
 * The dots overview: `GET /api/graph/dots` — thousands of minimal type-balanced
 * nodes with a server-computed degree, no edges.
 *
 * Loads in two waves so the canvas is never blocked on the full budget:
 *   1. a fast first page (~320) for immediate paint
 *   2. the full constellation (~2000) merged in while the picture keeps moving
 *
 * Edges still come from focus fetches and the zoomed-in section fetch
 * (`POST /api/graph/edges`), not from here.
 */
export function useGraphDots(authToken?: string | null, options: GraphDotsOptions = {}): GraphDotsState {
  const skip = options.skip ?? false;
  const refreshKey = options.refreshKey ?? 0;
  const includeTypesActive = options.includeTypes !== undefined;
  const includeTypesKey = (options.includeTypes ?? []).join(',');
  const eventTypesKey = (options.eventTypes ?? []).join(',');

  const [state, setState] = useState<GraphDotsState>(skip ? IDLE_STATE : { ...IDLE_STATE, loading: true });

  useEffect(() => {
    let cancelled = false;

    if (skip) {
      setState(IDLE_STATE);

      return () => {
        cancelled = true;
      };
    }

    async function load() {
      try {
        setState((prev) => ({
          ...IDLE_STATE,
          // Keep prior constellation on screen across filter refreshes so the
          // picture doesn't blink to a spinner; only the first visit blocks.
          nodes: prev.nodes,
          userEntityId: prev.userEntityId,
          counts: prev.counts,
          loading: prev.nodes.length === 0,
          hydrating: true,
          error: null,
        }));

        const headers = authToken ? { Authorization: `Bearer ${authToken}` } : undefined;
        const baseInit: RequestInit = { headers, credentials: 'include' };

        const firstUrl = buildDotsUrl(FIRST_PAINT_LIMIT, includeTypesActive, includeTypesKey, eventTypesKey);
        const fullUrl = buildDotsUrl(FULL_LIMIT, includeTypesActive, includeTypesKey, eventTypesKey);

        // Context + first page race in together; the heavy full page starts in
        // parallel so densification begins before the first paint even lands.
        const contextPromise = fetchJson<GraphContextResponse>('/api/graph/context', { ...baseInit });
        const firstPromise = fetchJson<GraphDotsResponse>(firstUrl, { ...baseInit });
        const fullPromise = fetchJson<GraphDotsResponse>(fullUrl, { ...baseInit });

        const [contextResponse, firstResponse] = await Promise.all([contextPromise, firstPromise]);

        if (!contextResponse?.success || !contextResponse.context) {
          throw new Error('Unable to resolve user context');
        }

        if (!firstResponse?.success) {
          throw new Error('Graph dots request failed');
        }

        if (cancelled) {
          return;
        }

        const firstNodes = toGraphNodes(firstResponse.data.nodes);
        setState({
          loading: false,
          hydrating: true,
          error: null,
          nodes: firstNodes,
          userEntityId: contextResponse.context.currentUser.entityId,
          counts: firstResponse.counts ?? {},
          truncated: firstResponse.truncated ?? false,
          connectivity: firstResponse.connectivity ?? null,
        });

        // Full constellation — merge quietly. If it fails, keep the first page.
        try {
          const fullResponse = await fullPromise;
          if (cancelled) {
            return;
          }

          if (!fullResponse?.success) {
            setState((prev) => ({ ...prev, hydrating: false }));

            return;
          }

          setState((prev) => ({
            ...prev,
            hydrating: false,
            nodes: mergeNodes(prev.nodes, toGraphNodes(fullResponse.data.nodes)),
            counts: fullResponse.counts ?? prev.counts,
            truncated: fullResponse.truncated ?? false,
            connectivity: fullResponse.connectivity ?? prev.connectivity,
          }));
        } catch {
          if (!cancelled) {
            setState((prev) => ({ ...prev, hydrating: false }));
          }
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

        setState({ ...IDLE_STATE, error: message });
      }
    }

    load();

    return () => {
      cancelled = true;
    };
  }, [authToken, skip, refreshKey, includeTypesActive, includeTypesKey, eventTypesKey]);

  return useMemo(() => state, [state]);
}
