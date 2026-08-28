import { useCallback, useEffect, useState } from 'react';

import { fetchJson } from '@ci/common';

import { readJobsSnapshot, writeJobsSnapshot } from './jobsSnapshots';
import { useJobsAuth } from './useJobsAuth';

export interface JobHistoryPoint {
  readonly at: string;
  /** Gauges — how much work was outstanding. */
  readonly pending: number;
  readonly active: number;
  readonly retry: number;
  readonly deadLettered: number;
  /** Deltas — how much work settled in the bucket. */
  readonly completed: number;
  readonly failed: number;
  readonly avgDurationMs: number | null;
  readonly p95DurationMs: number | null;
}

export interface JobHistoryResponse {
  readonly points: readonly JobHistoryPoint[];
  readonly queues: readonly string[];
  readonly bucketMinutes: number;
  readonly windowHours: number;
}

/** Windows the UI offers. Hours, because the API takes hours. */
export const HISTORY_WINDOWS = [
  { label: '6h', hours: 6 },
  { label: '24h', hours: 24 },
  { label: '7d', hours: 24 * 7 },
  { label: '30d', hours: 24 * 30 },
] as const;

/**
 * Job history for the charts.
 *
 * Backed by `ci.job_metrics`, which exists because pg-boss keeps roughly
 * thirty-six hours of working set and no history — a queue's behaviour
 * yesterday is only knowable because the collector wrote it down.
 *
 * Polls more slowly than the table: the collector samples every five minutes,
 * so a faster refresh would redraw the same points.
 */
/** The request a window/queue pair makes, which is also its snapshot key. */
function historyUrl(windowHours: number, queue: string): string {
  const params = new URLSearchParams({ hours: String(windowHours) });

  if (queue) {
    params.set('queue', queue);
  }

  return `/api/jobs/history?${params}`;
}

export function useJobHistory(windowHours: number, queue: string, refreshIntervalMs = 60000) {
  const url = historyUrl(windowHours, queue);

  const [data, setData] = useState<JobHistoryResponse | null>(
    () => readJobsSnapshot<JobHistoryResponse>(url)?.value ?? null,
  );
  const [loading, setLoading] = useState(() => readJobsSnapshot(url) == null);
  const [error, setError] = useState<string | null>(null);

  const { ready, headers } = useJobsAuth();

  // Switching to a window that has already been drawn this session redraws it
  // at once, rather than emptying the charts while the collector is re-read.
  useEffect(() => {
    const snapshot = readJobsSnapshot<JobHistoryResponse>(url);

    if (snapshot) {
      setData(snapshot.value);
      setLoading(false);
    }
  }, [url]);

  const load = useCallback(async () => {
    if (!ready) {
      return;
    }

    try {
      const response = await fetchJson<JobHistoryResponse>(url, { headers });

      setData(response ?? null);
      setError(null);

      if (response) {
        writeJobsSnapshot(url, response);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [ready, headers, url]);

  useEffect(() => {
    if (!ready) {
      return;
    }

    void load();

    if (refreshIntervalMs <= 0) {
      return;
    }

    const handle = window.setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        return;
      }

      void load();
    }, refreshIntervalMs);

    return () => window.clearInterval(handle);
  }, [ready, load, refreshIntervalMs]);

  return { data, loading, error, refresh: load } as const;
}
