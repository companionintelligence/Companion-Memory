import { useCallback, useEffect, useRef, useState } from 'react';

import { fetchJson } from '@ci/common';

import { useAuth } from '@/hooks';

export interface JobRecord {
  readonly id: string;
  readonly queue: string;
  readonly state: string;
  readonly priority: number;
  readonly retryLimit: number;
  readonly retryCount: number;
  readonly retryDelay: number;
  readonly retryBackoff: boolean;
  readonly createdOn: string;
  readonly startAfter: string;
  readonly startedOn?: string;
  readonly completedOn?: string;
  readonly deadLetter?: string | null;
  readonly policy?: string | null;
  readonly data: Record<string, unknown> | null;
  readonly output: Record<string, unknown> | null;
}

export interface ArchivedJobRecord extends JobRecord {
  readonly archivedOn: string;
}

export interface JobSchedule {
  readonly name: string;
  readonly cron: string;
  readonly timezone?: string | null;
  readonly createdOn: string;
  readonly updatedOn: string;
  readonly data: Record<string, unknown> | null;
  readonly options: Record<string, unknown> | null;
}

export interface JobQueue {
  readonly name: string;
  readonly policy?: string | null;
  readonly retryLimit: number;
  readonly retryDelay: number;
  readonly retryBackoff: boolean;
  readonly expireInSeconds?: number | null;
  readonly retentionMinutes?: number | null;
  readonly deadLetter?: string | null;
  readonly createdOn: string;
  readonly updatedOn?: string;
}

export interface JobDistributionSegment {
  readonly jobName: string;
  readonly count: number;
}

export interface JobsDashboardResponse {
  readonly summary: {
    readonly active: number;
    readonly completed: number;
    readonly failed: number;
    readonly scheduled: number;
  };
  readonly distribution: readonly JobDistributionSegment[];
  readonly jobs: readonly JobRecord[];
  readonly archive: readonly ArchivedJobRecord[];
  readonly schedules: readonly JobSchedule[];
  readonly queues: readonly JobQueue[];
}

export function useJobsDashboard(refreshIntervalMs = 15000) {
  const [data, setData] = useState<JobsDashboardResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const [{ authToken }] = useAuth();
  const isInitialLoad = useRef(true);

  const load = useCallback(async () => {
    if (!authToken) {
      return;
    }

    if (isInitialLoad.current) {
      setLoading(true);
      setError(null);
    }

    try {
      const response = await fetchJson<JobsDashboardResponse>('/api/jobs/dashboard', {
        headers: {
          Authorization: `Bearer ${authToken}`,
        },
      });

      setData(response ?? null);
      setLoading(false);
      setError(null);
      isInitialLoad.current = false;
    } catch (err: unknown) {
      if (isInitialLoad.current) {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        setLoading(false);
      }
      // On subsequent loads, we fail silently.
    }
  }, [authToken]);

  useEffect(() => {
    if (!authToken) {
      return;
    }

    void load();

    if (refreshIntervalMs <= 0) {
      return;
    }

    const handle = window.setInterval(() => {
      void load();
    }, refreshIntervalMs);

    return () => window.clearInterval(handle);
  }, [authToken, load, refreshIntervalMs]);

  return {
    data,
    loading,
    error,
    refresh: load,
  } as const;
}
