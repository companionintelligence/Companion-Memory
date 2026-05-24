import { useCallback, useEffect, useRef, useState } from 'react';

import { useAuth } from '@/hooks';

export type EvolutionChangeType = 'created' | 'updated' | 'archived' | 'deleted' | 'merged';
export type EvolutionNodeType = 'entity' | 'relationship';

export interface EvolutionFieldChange {
  field: string;
  oldValue: unknown;
  newValue: unknown;
}

export interface EvolutionDelta {
  deltaId: string;
  nodeType: EvolutionNodeType;
  entityId: string | null;
  relationshipId: string | null;
  entityType: string | null;
  relationshipType: string | null;
  changeType: EvolutionChangeType;
  changedFields: Record<string, { old?: unknown; new?: unknown }>;
  fieldChanges: EvolutionFieldChange[];
  changeSource: string | null;
  changeReason: string | null;
  summaryId: string | null;
  changedAt: string;
  entity: {
    entityId: string;
    entityType: string | null;
    name: string | null;
  } | null;
  fromEntity: {
    entityId: string;
    entityType: string | null;
    name: string | null;
  } | null;
  toEntity: {
    entityId: string;
    entityType: string | null;
    name: string | null;
  } | null;
}

export interface EntityEvolutionStats {
  total: number;
  firstChangedAt: string | null;
  lastChangedAt: string | null;
  created: number;
  updated: number;
  archived: number;
  deleted: number;
  merged: number;
  entity: number;
  relationship: number;
}

export interface EntityEvolutionData {
  entityId: string;
  deltas: EvolutionDelta[];
  stats: EntityEvolutionStats;
}

interface EntityEvolutionResponse {
  success: boolean;
  data: EntityEvolutionData;
}

interface Props {
  entityId?: string;
  limit?: number;
  skip?: boolean;
}

export function useEntityEvolutionService({ entityId, limit = 200, skip = false }: Props) {
  const [{ authToken }] = useAuth();
  const tokenRef = useRef(authToken);

  const [data, setData] = useState<EntityEvolutionData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    tokenRef.current = authToken;
  }, [authToken]);

  const fetchEvolution = useCallback(async (id: string, requestedLimit: number) => {
    setLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams({
        entityId: id,
        limit: String(requestedLimit),
      });

      const response = await fetch(`/api/audit/deltas?${params.toString()}`, {
        headers: tokenRef.current ? { Authorization: `Bearer ${tokenRef.current}` } : undefined,
      });

      if (!response.ok) {
        throw new Error(`Failed to fetch entity evolution: ${response.statusText}`);
      }

      const payload: EntityEvolutionResponse = await response.json();
      if (!payload.success) {
        throw new Error('Entity evolution request was not successful');
      }

      setData(payload.data);
    } catch (err) {
      setError(err instanceof Error ? err : new Error('Unknown error occurred'));
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (skip || !entityId) {
      return;
    }

    fetchEvolution(entityId, limit);
  }, [entityId, fetchEvolution, limit, skip]);

  return {
    data,
    loading,
    error,
    refresh: () => entityId && fetchEvolution(entityId, limit),
  };
}
