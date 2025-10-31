import { useEffect, useMemo, useState } from 'react';

import { fetchJson } from '@ci/common';

type RelationshipSummary = {
  relationshipId: string;
  relationshipType: string;
  direction: 'outbound' | 'inbound';
  strength: number | null;
  isBidirectional: boolean | null;
  properties: Record<string, unknown>;
  otherEntity: {
    entityId: string;
    entityType: string;
    name: string | null;
    description: string | null;
    properties: Record<string, unknown>;
  } | null;
};

type NodeDetailsResponse = {
  success: boolean;
  node: {
    entityId: string;
    entityType: string;
    name: string | null;
    description: string | null;
    properties: Record<string, unknown>;
    createdAt: string;
    updatedAt: string;
  };
  relationships: RelationshipSummary[];
};

interface NodeDetailsState {
  loading: boolean;
  error: string | null;
  data: NodeDetailsResponse | null;
}

export function useNodeDetails(
  entityId: string | null,
  authToken?: string | null,
  revision = 0,
): NodeDetailsState {
  const [state, setState] = useState<NodeDetailsState>({ loading: false, error: null, data: null });

  useEffect(() => {
    if (!entityId) {
      setState({ loading: false, error: null, data: null });

      return;
    }

    const targetEntityId = entityId;
    const authHeader = authToken ? { Authorization: `Bearer ${authToken}` } : undefined;
    let cancelled = false;

    async function load() {
      try {
        setState({ loading: true, error: null, data: null });

        const response = await fetchJson<NodeDetailsResponse>(
          `/api/graph/node?entityId=${encodeURIComponent(targetEntityId)}`,
          {
            credentials: 'include',
            headers: authHeader,
          },
        );

        if (!cancelled) {
          setState({ loading: false, error: null, data: response });
        }
      } catch (error) {
        if (cancelled) {
          return;
        }

        const message = error instanceof Error ? error.message : 'Unknown error';
        setState({ loading: false, error: message, data: null });
      }
    }

    load();

    return () => {
      cancelled = true;
    };
  }, [entityId, authToken, revision]);

  return useMemo(() => state, [state]);
}

export type { NodeDetailsResponse, RelationshipSummary };
