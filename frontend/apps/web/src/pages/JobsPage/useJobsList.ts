import { useCallback, useEffect, useMemo, useState } from 'react';

import { fetchJson } from '@ci/common';

import { readJobsSnapshot, writeJobsSnapshot } from './jobsSnapshots';
import { useJobsAuth } from './useJobsAuth';

export interface JobListItem {
  readonly id: string;
  readonly queue: string;
  readonly state: string;
  readonly event: string | null;
  readonly workType: string | null;
  /** What this job actually does, from the server-side taxonomy. */
  readonly label: string;
  readonly category: string;
  readonly description: string;
  readonly interactive: boolean;
  readonly createdOn: string;
  readonly startedOn: string | null;
  readonly completedOn: string | null;
  readonly durationMs: number | null;
  readonly retryCount: number;
  readonly retryLimit: number;
  readonly payloadBytes: number;
  readonly failure: { message: string; stack?: string; failedAt?: string } | null;
  readonly deadLettered: boolean;
}

export interface JobListResponse {
  readonly items: readonly JobListItem[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
  readonly queues: readonly string[];
  readonly stateCounts: Readonly<Record<string, number>>;
}

export interface JobFilters {
  state: string;
  queue: string;
  category: string;
  /** Exact event name (e.g. `smart.rotation.work`); narrower than category. */
  type: string;
  search: string;
  offset: number;
  limit: number;
}

export const DESKTOP_JOB_PAGE_SIZE = 50;
/** A phone page of 50 cards is a novel. Twenty fits a scan. */
export const MOBILE_JOB_PAGE_SIZE = 20;

export const DEFAULT_JOB_FILTERS: JobFilters = {
  state: '',
  queue: '',
  category: '',
  type: '',
  search: '',
  offset: 0,
  limit: DESKTOP_JOB_PAGE_SIZE,
};

function toQueryString(filters: JobFilters): string {
  const params = new URLSearchParams();

  if (filters.type) {
    params.set('type', filters.type);
  }

  if (filters.state) {
    params.set('state', filters.state);
  }

  if (filters.queue) {
    params.set('queue', filters.queue);
  }

  if (filters.category) {
    params.set('category', filters.category);
  }

  if (filters.search.trim()) {
    params.set('search', filters.search.trim());
  }

  params.set('limit', String(filters.limit));
  params.set('offset', String(filters.offset));

  return params.toString();
}

/**
 * The filtered job list.
 *
 * Filtering happens in SQL, not in the browser: the table is paged over
 * `pgboss.job`, which routinely holds tens of thousands of rows during an
 * import, so "fetch 25 and filter client-side" would be both wrong and slow.
 *
 * The search term is debounced because it fires per keystroke against a
 * partitioned table.
 */
/** The request a set of filters makes, which is also what its snapshot is keyed on. */
function listUrl(query: string): string {
  return `/api/jobs?${query}`;
}

export function useJobsList(filters: JobFilters, refreshIntervalMs = 15000) {
  const [restored] = useState(() => readJobsSnapshot<JobListResponse>(listUrl(toQueryString(filters))));

  const [data, setData] = useState<JobListResponse | null>(restored?.value ?? null);
  const [loading, setLoading] = useState(restored == null);
  const [error, setError] = useState<string | null>(null);

  const { ready, headers } = useJobsAuth();

  const [debouncedSearch, setDebouncedSearch] = useState(filters.search);

  useEffect(() => {
    const handle = window.setTimeout(() => setDebouncedSearch(filters.search), 300);

    return () => window.clearTimeout(handle);
  }, [filters.search]);

  const query = useMemo(
    () => toQueryString({ ...filters, search: debouncedSearch }),
    [filters, debouncedSearch],
  );

  // A page this session has already fetched renders at once when the filters
  // swing back to it — including the phone's page-size switch, which changes
  // the query on the very first commit and would otherwise blank the table
  // every time Jobs is opened on a phone.
  useEffect(() => {
    const snapshot = readJobsSnapshot<JobListResponse>(listUrl(query));

    if (snapshot) {
      setData(snapshot.value);
      setLoading(false);
    }
  }, [query]);

  const load = useCallback(async () => {
    if (!ready) {
      return;
    }

    try {
      const response = await fetchJson<JobListResponse>(listUrl(query), { headers });

      setData(response ?? null);
      setError(null);

      if (response) {
        writeJobsSnapshot(listUrl(query), response);
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [ready, headers, query]);

  useEffect(() => {
    if (!ready) {
      return;
    }

    void load();

    if (refreshIntervalMs <= 0) {
      return;
    }

    const handle = window.setInterval(() => {
      // Polling a hidden tab bills the appliance for a partitioned scan nobody
      // is looking at.
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        return;
      }

      void load();
    }, refreshIntervalMs);

    return () => window.clearInterval(handle);
  }, [ready, load, refreshIntervalMs]);

  return { data, loading, error, refresh: load } as const;
}
