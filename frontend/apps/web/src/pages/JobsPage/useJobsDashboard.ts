import { useCallback, useEffect, useState } from 'react';

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

interface HookState {
  data: JobsDashboardResponse | null;
  loading: boolean;
  error: string | null;
}

export function useJobsDashboard(refreshIntervalMs = 15000) {
  const [{ data, loading, error }, setState] = useState<HookState>({
    data: null,
    loading: true,
    error: null,
  });
  const [{ authToken }] = useAuth();

  const load = useCallback(async () => {
    if (!authToken) {
      return;
    }

    setState((prev) => ({ ...prev, loading: true, error: null }));

    try {
      const response = await fetchJson<JobsDashboardResponse>('/api/events/jobs/dashboard', {
        headers: {
          Authorization: `Bearer ${authToken}`,
        },
      });

      setState({ data: response, loading: false, error: null });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setState((prev) => ({ ...prev, loading: false, error: message }));
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
