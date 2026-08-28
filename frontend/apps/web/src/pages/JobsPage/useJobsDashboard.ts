import { useCallback, useEffect, useRef, useState } from 'react';

import { fetchJson } from '@ci/common';

import { readJobsSnapshot, writeJobsSnapshot } from './jobsSnapshots';
import { useJobsAuth } from './useJobsAuth';

/** Why a job failed, lifted server-side out of `pgboss.job.output`. */
export interface JobFailure {
  readonly message: string;
  readonly stack?: string;
  readonly failedAt?: string;
}

/**
 * One job, as the API is willing to describe it.
 *
 * Job payloads are user content and this endpoint carries no owner predicate, so
 * the server projects each job down to what the dashboard actually needs — the
 * event name, the rotation work type, the payload's size, and a failure's
 * message and stack — rather than shipping `data` and `output` verbatim to
 * whoever happens to be signed in.
 */
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
  readonly event: string | null;
  readonly workType: string | null;
  readonly payloadBytes: number;
  readonly failure: JobFailure | null;
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

/**
 * A recurring job as the appliance actually schedules them — a NestJS `@Cron`
 * method, read from the live scheduler registry. Distinct from `JobSchedule`,
 * which reads pg-boss's own `schedule` table; nothing writes that table here, so
 * it is always empty.
 */
export interface CronSchedule {
  readonly name: string;
  readonly cron: string;
  readonly timezone?: string | null;
  /**
   * Whether the scheduler has this job started — not whether it works. The
   * `@Cron` wrapper catches, logs and returns, so a schedule whose body throws
   * on every tick stays started forever. Read with `lastSuccessAt` and
   * `overdue`, never alone.
   */
  readonly running: boolean;
  readonly nextRunAt: string | null;
  /** Last *attempt*: stamped before the body, so a tick that threw still counts. */
  readonly lastRunAt: string | null;
  /** Last tick whose body returned without throwing. Null until one does. */
  readonly lastSuccessAt: string | null;
  /**
   * The schedule's own expression says it should have fired by now and no
   * attempt was recorded for that fire. Computed server-side, where the cron
   * expression can actually be evaluated; false while nothing has ever run, so
   * a fresh appliance does not light up every row.
   */
  readonly overdue: boolean;
}

export interface JobsDashboardResponse {
  readonly summary: {
    readonly pending: number;
    readonly active: number;
    readonly retry: number;
    readonly completed: number;
    readonly failed: number;
    readonly cancelled: number;
    readonly deadLettered: number;
    readonly scheduled: number;
  };
  readonly archiveDistribution: readonly JobDistributionSegment[];
  readonly activeDistribution: readonly JobDistributionSegment[];
  readonly queueDistribution: Array<{ queue: string; count: number }>;
  readonly smartRotationDistribution: Array<{ workType: string; count: number }>;
  readonly jobs: readonly JobRecord[];
  readonly archive: readonly ArchivedJobRecord[];
  readonly schedules: readonly JobSchedule[];
  readonly crons: readonly CronSchedule[];
  readonly queues: readonly JobQueue[];
}

/** Cache key for the one payload this hook reads. */
const DASHBOARD_SNAPSHOT = '/api/jobs/dashboard';

export function useJobsDashboard(refreshIntervalMs = 15000) {
  // Read once, at mount. Coming back to Jobs paints the previous snapshot on
  // the first frame instead of a skeleton, and the fetch below lands under it.
  const [restored] = useState(() => readJobsSnapshot<JobsDashboardResponse>(DASHBOARD_SNAPSHOT));

  const [data, setData] = useState<JobsDashboardResponse | null>(restored?.value ?? null);
  const [loading, setLoading] = useState<boolean>(restored == null);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [staleSince, setStaleSince] = useState<Date | null>(null);
  const [updatedAt, setUpdatedAt] = useState<Date | null>(restored ? new Date(restored.at) : null);

  const { ready, headers } = useJobsAuth();

  // A restored snapshot means this mount is not a first load: a failure here
  // belongs in the stale banner over data that is already on screen, not in a
  // full-page error that throws that data away.
  const isInitialLoad = useRef(restored == null);

  const load = useCallback(
    async ({ background = false }: { background?: boolean } = {}) => {
      if (!ready) {
        return;
      }

      if (isInitialLoad.current) {
        setLoading(true);
        setError(null);
      }

      // Interval ticks pass `background`. Spinning the header every fifteen
      // seconds would make the indicator meaningless — it is there to answer
      // "did my pull/click do anything", which a poll never asks.
      if (!background) {
        setRefreshing(true);
      }

      try {
        const response = await fetchJson<JobsDashboardResponse>('/api/jobs/dashboard', { headers });

        setData(response ?? null);
        setLoading(false);
        setError(null);
        setStaleSince(null);
        setUpdatedAt(new Date(response ? writeJobsSnapshot(DASHBOARD_SNAPSHOT, response).at : Date.now()));
        isInitialLoad.current = false;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);

        if (isInitialLoad.current) {
          setError(message);
          setLoading(false);

          return;
        }

        // A refresh that fails after the first success used to be swallowed
        // entirely, leaving a page that looks live — auto-refreshing, timestamps
        // ticking — while showing numbers frozen at whenever the API last
        // answered. On a queue dashboard that is the worst possible failure: an
        // operator watching a backlog drain cannot tell "nothing changed" from
        // "nothing is being reported". Keep showing the last good data, but say
        // out loud that it is the last good data.
        setStaleSince((current) => current ?? new Date());
        setError(message);
      } finally {
        if (!background) {
          setRefreshing(false);
        }
      }
    },
    [ready, headers],
  );

  useEffect(() => {
    if (!ready) {
      return;
    }

    void load();

    if (refreshIntervalMs <= 0) {
      return;
    }

    const handle = window.setInterval(() => {
      // Polling a hidden tab bills the appliance for grouped scans over the job
      // tables that nobody is looking at. Refresh resumes on the next tick after
      // the tab is shown again.
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        return;
      }

      void load({ background: true });
    }, refreshIntervalMs);

    return () => window.clearInterval(handle);
  }, [ready, load, refreshIntervalMs]);

  return {
    data,
    /** No payload to render yet. A restored snapshot means this is never true. */
    loading,
    /**
     * A fetch is in flight over data that is already on screen — the mount
     * refetch behind a restored snapshot, or an explicit refresh. Drives a
     * spinner; never a skeleton, because nothing is being replaced.
     */
    refreshing,
    error,
    /** Set when refreshes are failing but stale data is still on screen. */
    staleSince,
    /** When the displayed data was last successfully fetched. */
    updatedAt,
    refresh: load,
  } as const;
}
