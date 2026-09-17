import { useCallback, useEffect, useState } from 'react';

import { fetchJson, FetchJsonError } from '@ci/common';

import { readJobsSnapshot, writeJobsSnapshot } from './jobsSnapshots';
import { useJobsAuth } from './useJobsAuth';

/** How much a queue is allowed to do. See the API's own notes for why there are three. */
export type JobMode = 'enabled' | 'paused' | 'disabled';
export type CronMode = 'enabled' | 'disabled';

/**
 * A number the operator can set, with everything needed to render it honestly.
 *
 * `value` is what they asked for, `effective` is what the appliance is doing,
 * and those differ whenever something tighter is binding — a queue whose code
 * declares a ceiling of 1 answers 1 however large a number is typed. Showing
 * only `value` would be showing a machine that does not exist.
 */
export interface JobControlNumber {
  readonly value: number | null;
  readonly default: number;
  readonly max: number;
  readonly effective: number;
}

export interface JobQueueControl {
  readonly name: string;
  readonly mode: JobMode;
  /** Quiet only because of the global non-interactive pause, not by its own setting. */
  readonly pausedByGlobal: boolean;
  readonly concurrency: JobControlNumber;
  /** The ceiling the queue declared in code, if any. Non-null = the code is binding. */
  readonly declaredConcurrency: number | null;
  readonly role: 'web' | 'worker';
  readonly interactive: boolean;
  readonly categories: readonly string[];
  readonly jobTypes: ReadonlyArray<{
    readonly event: string;
    readonly label: string;
    readonly category: string;
    readonly description: string;
  }>;
  readonly locked: boolean;
  readonly lockedReason: string | null;
  readonly skippedCount: number;
  readonly lastSkippedAt: string | null;
}

export interface JobCronControl {
  readonly name: string;
  readonly cron: string;
  readonly mode: CronMode;
  /** Which process runs it. Every schedule in the build is listed, both roles. */
  readonly role: 'web' | 'worker';
  /**
   * Whether the process that answered is the one that runs it. False only on a
   * split deployment, and it does not mean uncontrollable — the switch writes a
   * setting every process polls.
   */
  readonly servedHere: boolean;
  readonly locked: boolean;
  readonly lockedReason: string | null;
  readonly skippedCount: number;
  readonly lastSkippedAt: string | null;
}

export interface JobControlsResponse {
  readonly global: {
    readonly concurrency: JobControlNumber;
    readonly perQueueConcurrency: JobControlNumber;
    readonly nonInteractive: JobMode;
  };
  readonly topology: {
    readonly role: 'all' | 'web' | 'worker';
    readonly queueWorkerProcesses: number;
    readonly perProcessConcurrency: number;
  };
  readonly queues: readonly JobQueueControl[];
  readonly crons: readonly JobCronControl[];
  readonly maxConcurrency: number;
}

/**
 * A change to send. Every field is optional and absence means "leave it alone";
 * an explicit `null` on a concurrency resets it to the shipped default. The two
 * have to stay distinguishable or toggling a queue's mode would silently wipe
 * its cap.
 */
export interface JobControlsPatch {
  readonly global?: {
    readonly concurrency?: number | null;
    readonly perQueueConcurrency?: number | null;
    readonly nonInteractive?: 'enabled' | 'paused';
  };
  readonly queues?: ReadonlyArray<{
    readonly name: string;
    readonly mode?: JobMode;
    readonly concurrency?: number | null;
  }>;
  readonly crons?: ReadonlyArray<{ readonly name: string; readonly mode: CronMode }>;
}

const CONTROLS_URL = '/api/jobs/controls';

/**
 * The persisted operator controls.
 *
 * Not polled. Unlike the dashboard beside it, this is not a live view of the
 * appliance — it is a form, and a form whose fields move under the cursor every
 * fifteen seconds is a form nobody can fill in. It reloads on mount, and every
 * save returns the recomputed state, so what is on screen is always the server's
 * answer to the last thing that was actually done.
 *
 * The response is snapshotted for the same reason the other Jobs hooks snapshot
 * theirs: coming back to the page paints the last known settings on the first
 * frame instead of an empty card, and the refetch lands underneath.
 */
export function useJobControls() {
  const { ready, headers } = useJobsAuth();

  const [restored] = useState(() => readJobsSnapshot<JobControlsResponse>(CONTROLS_URL));
  const [data, setData] = useState<JobControlsResponse | null>(restored?.value ?? null);
  const [loading, setLoading] = useState(restored == null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * The HTTP status behind {@link error}, when there was one.
   *
   * Kept because the message alone cannot tell the card WHY controls are
   * missing, and the card was guessing: a 404 (this build has no controls
   * endpoint) rendered the same "the settings table may not have been migrated
   * yet" explanation as a 500 (the endpoint is there and the table is not).
   * Those need opposite actions, and sending someone to check migrations when
   * the server is simply too old costs them the afternoon.
   */
  const [errorStatus, setErrorStatus] = useState<number | null>(null);

  const load = useCallback(async () => {
    if (!ready) {
      return;
    }

    try {
      const response = await fetchJson<JobControlsResponse>(CONTROLS_URL, { headers });

      if (response) {
        writeJobsSnapshot(CONTROLS_URL, response);
        setData(response);
      }

      setError(null);
      setErrorStatus(null);
    } catch (err: unknown) {
      // Keep whatever is on screen. Blanking the card on a failed refetch would
      // hide the very settings an operator came here to change, and the values
      // cannot have drifted — nothing else writes them.
      setError(err instanceof Error ? err.message : String(err));
      setErrorStatus(err instanceof FetchJsonError ? err.status : null);
    } finally {
      setLoading(false);
    }
  }, [ready, headers]);

  useEffect(() => {
    void load();
  }, [load]);

  /**
   * Send one change and adopt the server's recomputed state.
   *
   * Deliberately NOT optimistic. A cap of 8 on a queue that declares 1 lands as
   * 1, and a protected schedule refuses outright — so the only state worth
   * rendering is the one that came back. Rejections surface as `error` and the
   * card keeps showing the settings that are actually in force.
   */
  const save = useCallback(
    async (patch: JobControlsPatch): Promise<boolean> => {
      if (!ready) {
        return false;
      }

      setSaving(true);

      try {
        const response = await fetchJson<JobControlsResponse>(CONTROLS_URL, {
          method: 'PUT',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        });

        if (response) {
          writeJobsSnapshot(CONTROLS_URL, response);
          setData(response);
        }

        setError(null);
        setErrorStatus(null);

        return true;
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : String(err));
        setErrorStatus(err instanceof FetchJsonError ? err.status : null);

        return false;
      } finally {
        setSaving(false);
      }
    },
    [ready, headers],
  );

  return { data, loading, saving, error, errorStatus, refresh: load, save } as const;
}
