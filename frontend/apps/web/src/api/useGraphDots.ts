import { useEffect, useMemo, useState } from 'react';

import { FetchJsonError, fetchJson } from '@ci/common';

import type { GraphNode } from '@/api/useGraphOverview';

type GraphDotsResponse = {
  success: boolean;
  data: {
    nodes: Array<{
      id: string;
      entity_id: string;
      entity_type: string;
      name: string | null;
      degree: number;
      event_type?: string;
    }>;
  };
  /** Total active entities per type, so the UI can report coverage. */
  counts?: Record<string, number>;
  truncated?: boolean;
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
  loading: boolean;
  error: string | null;
  /** Dots as full GraphNodes (empty description/properties) so the ForceGraph renders them as-is. */
  nodes: GraphNode[];
  userEntityId: string | null;
  counts: Record<string, number>;
  truncated: boolean;
}

const IDLE_STATE: GraphDotsState = {
  loading: false,
  error: null,
  nodes: [],
  userEntityId: null,
  counts: {},
  truncated: false,
};

/**
 * The dots overview: `GET /api/graph/dots` — thousands of minimal type-balanced
 * nodes with a server-computed degree, no edges. The graph explorer renders
 * these as the zoomed-out constellation; edges come from focus fetches and the
 * zoomed-in section fetch (`POST /api/graph/edges`), not from here.
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
        setState((prev) => ({ ...prev, loading: true, error: null }));

        const headers = authToken ? { Authorization: `Bearer ${authToken}` } : undefined;
        const baseInit: RequestInit = { headers, credentials: 'include' };

        const params = new URLSearchParams();
        if (includeTypesActive) {
          params.set('includeTypes', includeTypesKey);
        }

        if (eventTypesKey) {
          params.set('eventTypes', eventTypesKey);
        }

        const query = params.toString();
        const dotsUrl = query ? `/api/graph/dots?${query}` : '/api/graph/dots';

        const [contextResponse, dotsResponse] = await Promise.all([
          fetchJson<GraphContextResponse>('/api/graph/context', { ...baseInit }),
          fetchJson<GraphDotsResponse>(dotsUrl, { ...baseInit }),
        ]);

        if (!contextResponse?.success || !contextResponse.context) {
          throw new Error('Unable to resolve user context');
        }

        if (!dotsResponse?.success) {
          throw new Error('Graph dots request failed');
        }

        if (cancelled) {
          return;
        }

        setState({
          loading: false,
          error: null,
          nodes: dotsResponse.data.nodes.map((node) => ({
            id: node.id,
            entity_id: node.entity_id,
            entity_type: node.entity_type,
            name: node.name,
            description: null,
            properties: {},
            degree: node.degree,
            ...(node.event_type != null ? { event_type: node.event_type } : {}),
          })),
          userEntityId: contextResponse.context.currentUser.entityId,
          counts: dotsResponse.counts ?? {},
          truncated: dotsResponse.truncated ?? false,
        });
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
