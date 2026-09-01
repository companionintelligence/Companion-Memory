import { useCallback, useEffect, useState } from 'react';

import { fetchJson } from '@ci/common';

import { readJobsSnapshot, writeJobsSnapshot } from './jobsSnapshots';
import { useJobsAuth } from './useJobsAuth';

export interface JobCategoryHistoryPoint {
  readonly at: string;
  /** Jobs of each category that ARRIVED in this bucket. Zero-filled. */
  readonly counts: Readonly<Record<string, number>>;
}

export interface JobCategoryHistoryResponse {
  readonly points: readonly JobCategoryHistoryPoint[];
  /** Categories present in the window, sorted — the chart's series. */
  readonly categories: readonly string[];
  readonly bucketMinutes: number;
  readonly windowHours: number;
  /**
   * Which store answered.
   *
   * `live` — counted straight off pg-boss, exact. `metrics` — from the
   * five-minute sampler, only as complete as the collector's uptime.
   * `mixed` — the recent end is live, the older end sampled.
   *
   * Surfaced in the UI rather than hidden, because the two differ in KIND and
   * a reader cannot tell them apart from the shape of the curve. pg-boss keeps
   * roughly thirty-six hours of working set, so any window longer than that is
   * necessarily mixed until the sampler has been running for the full range.
   */
  readonly source: 'live' | 'metrics' | 'mixed';
}

function categoryHistoryUrl(windowHours: number): string {
  return `/api/jobs/history/categories?hours=${windowHours}`;
}

/**
 * Arrivals per category over time.
 *
 * Deliberately a separate request from {@link useJobHistory} rather than more
 * fields on it: the two answer different questions over different stores, and
 * the category series is the only one that can fall back between them. Bundling
 * would make the whole history request as slow as its slowest half.
 *
 * Polls on the same minute cadence — both sides are ultimately paced by the
 * collector's five-minute sample, so anything faster redraws identical points.
 */
export function useJobCategoryHistory(windowHours: number, refreshIntervalMs = 60000) {
  const url = categoryHistoryUrl(windowHours);

  const [data, setData] = useState<JobCategoryHistoryResponse | null>(
    () => readJobsSnapshot<JobCategoryHistoryResponse>(url)?.value ?? null,
  );
  const [loading, setLoading] = useState(() => readJobsSnapshot(url) == null);
  const [error, setError] = useState<string | null>(null);

  const { ready, headers } = useJobsAuth();

  // A window already drawn this session redraws at once instead of emptying
  // the chart while it is re-read.
  useEffect(() => {
    const snapshot = readJobsSnapshot<JobCategoryHistoryResponse>(url);

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
      const response = await fetchJson<JobCategoryHistoryResponse>(url, { headers });

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
