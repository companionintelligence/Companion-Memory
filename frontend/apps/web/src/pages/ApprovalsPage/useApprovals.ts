import { useCallback, useEffect, useState } from 'react';

import { fetchJson } from '@ci/common';

import { useJobsAuth } from '@/pages/JobsPage/useJobsAuth';

/**
 * Why a pending action is waiting, as the POLICY decided it.
 *
 * These come from `ToolGateReason` in `@ci/tool-core` — server-computed from the
 * intent's declared privacy label. The card renders from this and never from
 * anything a model wrote: a consent dialog composed by the thing asking for
 * consent is not a consent dialog.
 */
export type ApprovalReason =
  | 'destructive-requires-confirmation'
  | 'external-leaves-appliance'
  | 'confirmation-required'
  | 'not-local-capable'
  | 'capability-insufficient'
  | 'allowed';

export type ApprovalStatus = 'proposed' | 'approved' | 'executed' | 'declined' | 'expired';

export interface PendingApproval {
  id: string;
  /** Dotted intent id, e.g. `messaging.send`. */
  intent: string;
  tool: string;
  /** The actual arguments the call would run with. */
  input: unknown;
  reason: ApprovalReason;
  /** Which tier proposed it. */
  origin: string;
  /** The proposing caller's capability level. */
  actor: string;
  /**
   * Which installed app asked, as its api-key name — null when the owner did.
   * `actor` says what authority it held; this says who it was.
   */
  principalName: string | null;
  status: ApprovalStatus;
  createdAt: string;
  expiresAt: string | null;
}

interface ApprovalsResponse {
  actions: PendingApproval[];
}

/**
 * The owner's approval queue.
 *
 * Polled rather than subscribed: this app has no SSE or WebSocket consumer, and
 * PowerSync covers seven tables of which this is not one. The visibility guard is
 * the same one `useJobsList` explains — polling a hidden tab bills the appliance
 * for a scan nobody is looking at.
 *
 * The interval is short because the thing on the other end is an agent waiting to
 * be told yes or no, and a card the owner answers a minute late is a task that
 * stalled for a minute.
 */
export function useApprovals(refreshIntervalMs = 10000) {
  const [actions, setActions] = useState<PendingApproval[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const { ready, headers } = useJobsAuth();

  const load = useCallback(async () => {
    if (!ready) {
      return;
    }

    try {
      // `?status=proposed` server-side: the queue is the OPEN questions. Resolved
      // rows stay in the table for the ledger, not for this page.
      const body = await fetchJson<ApprovalsResponse>('/api/pending-actions?status=proposed', {
        headers,
      });

      setActions(body?.actions ?? []);
      setError(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [ready, headers]);

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

  /**
   * Answer one card.
   *
   * Reloads rather than mutating in place: approving RE-EXECUTES the intent
   * server-side, so the row's terminal state (`executed`, or still `proposed`
   * because the run failed) is the server's to report. Guessing it here would
   * show the owner a success the appliance never had.
   */
  const answer = useCallback(
    async (id: string, verdict: 'approve' | 'decline') => {
      await fetchJson(`/api/pending-actions/${encodeURIComponent(id)}/${verdict}`, {
        method: 'POST',
        headers,
      });

      await load();
    },
    [headers, load],
  );

  return { actions, loading, error, refresh: load, answer } as const;
}
