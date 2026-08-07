import { useCallback, useEffect, useState } from 'react';

import { fetchJson } from '@ci/common';

import { useAuth } from '@/hooks';

/** Mirrors `EntitySourceKind` in the API's GraphUtilityService. */
export type EntitySourceKind = 'self' | 'imported' | 'derived' | 'unknown';

export interface SourceCount {
  /** Raw provenance key — map it through `sourceLabel` before displaying. */
  readonly source: string;
  readonly kind: EntitySourceKind;
  readonly count: number;
}

export interface TagCount {
  readonly label: string;
  readonly count: number;
}

export interface MemoryStats {
  readonly totals: {
    readonly events: number;
    readonly entities: number;
    readonly relationships: number;
  };
  readonly dateRange: {
    readonly earliest: string | null;
    readonly latest: string | null;
  };
  readonly bySource: readonly SourceCount[];
  readonly byTag: readonly TagCount[];
}

interface MemoryStatsResponse {
  readonly success: boolean;
  readonly data: MemoryStats;
}

export function useStatsService() {
  const [data, setData] = useState<MemoryStats | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const [{ authToken }] = useAuth();

  const load = useCallback(async () => {
    if (!authToken) {
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const response = await fetchJson<MemoryStatsResponse>('/api/graph/stats', {
        headers: {
          Authorization: `Bearer ${authToken}`,
        },
      });

      if (!response?.success) {
        throw new Error('Stats request failed');
      }

      setData(response.data);
      setLoading(false);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
      setLoading(false);
    }
  }, [authToken]);

  useEffect(() => {
    void load();
  }, [load]);

  return {
    data,
    loading,
    error,
    refresh: load,
  } as const;
}
