import { useCallback, useEffect, useMemo, useState } from 'react';

import { fetchJson } from '@ci/common';

import { useJobsAuth } from '@/pages/JobsPage/useJobsAuth';

/** How a call ended. Mirrors `ToolInvocationOutcome` in `@ci/tool-core`. */
export type ActivityOutcome = 'success' | 'error' | 'timeout' | 'refused';

/** Who called. Mirrors `ToolPrincipal`. */
export type ActivityPrincipal = 'owner' | 'managed-app';

/**
 * One row of `ci.tool_invocations`.
 *
 * Note what is NOT here: arguments and results. The ledger stores neither, by
 * explicit design in its own migration — a table that keeps every payload
 * forever is a second copy of the user's content with none of the deletion
 * paths the first copy has. So this page can say `messaging.send` ran and was
 * refused; only an approval card can show the recipient and the body.
 */
export interface ActivityRow {
  id: string;
  occurredAt: string;
  intent: string;
  tool: string;
  domain: string | null;
  source: string;
  outcome: ActivityOutcome;
  capability: string | null;
  principal: ActivityPrincipal | null;
  /** The asking app's api-key name, or null when the owner asked. */
  principalName: string | null;
  /** `appliance` or `local`; null reads as `appliance`, the documented default. */
  tier: string | null;
  access: string | null;
  external: boolean;
  destructive: boolean;
  errorCode: string | null;
  error: string | null;
  durationMs: number | null;
  correlationId: string | null;
}

interface ActivityResponse {
  items: ActivityRow[];
  nextCursor: string | null;
}

export interface ActivityFilters {
  outcome?: ActivityOutcome;
  principal?: ActivityPrincipal;
  /** api-key name of one installed app. */
  app?: string;
}

/**
 * The tool-call ledger, newest first.
 *
 * ## Why this is not the activity timeline
 *
 * `ci.activity_rollup` → `activityTimeline` → `ActivityTimelineRail` already
 * ships and draws from eight sources — none of which is a tool call. That rail
 * answers "what happened in my life"; this answers "what did software do on my
 * behalf, and what was it stopped from doing". Folding the second into the
 * first would bury refusals among calendar events, which is the opposite of the
 * point.
 *
 * ## Paging
 *
 * Keyset, via the server's opaque `nextCursor`. Pages ACCUMULATE rather than
 * replacing, because reading a ledger means walking backwards through it, and a
 * refresh that dropped everything already read would make the walk impossible.
 *
 * Polling refreshes only the FIRST page, and only while the tab is visible
 * (`useJobsList`'s guard — polling a hidden tab bills the appliance for a scan
 * nobody is looking at). It deliberately does not re-fetch the accumulated
 * tail: rows are append-only and immutable, so nothing behind the first page
 * can change, and re-reading a year of history every ten seconds to discover
 * that would be absurd.
 */
export function useActivity(filters: ActivityFilters = {}, refreshIntervalMs = 15000) {
  const [pages, setPages] = useState<ActivityRow[][] | null>(null);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { ready, headers } = useJobsAuth();

  // Serialised so the load callbacks can depend on the filters by value; a fresh
  // object literal every render would restart the poll on every render.
  const query = useMemo(() => {
    const params = new URLSearchParams();

    if (filters.outcome) {
      params.set('outcome', filters.outcome);
    }

    if (filters.principal) {
      params.set('principal', filters.principal);
    }

    if (filters.app) {
      params.set('app', filters.app);
    }

    return params.toString();
  }, [filters.outcome, filters.principal, filters.app]);

  const fetchPage = useCallback(
    // `fetchJson` resolves `T | undefined`, not `T | null` — which is why every
    // read below goes through `body?.` rather than a null check.
    async (cursor: string | null): Promise<ActivityResponse | undefined> => {
      const params = new URLSearchParams(query);

      if (cursor) {
        params.set('cursor', cursor);
      }

      const suffix = params.toString();

      return fetchJson<ActivityResponse>(`/api/tools/invocations${suffix ? `?${suffix}` : ''}`, { headers });
    },
    [query, headers],
  );

  /** (Re)load the first page. Replaces the accumulated tail — the filters changed. */
  const load = useCallback(async () => {
    if (!ready) {
      return;
    }

    try {
      const body = await fetchPage(null);

      setPages([body?.items ?? []]);
      setNextCursor(body?.nextCursor ?? null);
      setError(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [ready, fetchPage]);

  /**
   * Refresh the first page in place, keeping everything already paged in.
   *
   * Rows are immutable and append-only, so the only thing that can have changed
   * is that there are new ones at the top.
   */
  const refreshHead = useCallback(async () => {
    if (!ready) {
      return;
    }

    try {
      const body = await fetchPage(null);

      setPages((current) => {
        const tail = current?.slice(1) ?? [];

        return [body?.items ?? [], ...tail];
      });
      setError(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [ready, fetchPage]);

  const loadMore = useCallback(async () => {
    if (!ready || !nextCursor || loadingMore) {
      return;
    }

    setLoadingMore(true);

    try {
      const body = await fetchPage(nextCursor);

      setPages((current) => [...(current ?? []), body?.items ?? []]);
      setNextCursor(body?.nextCursor ?? null);
      setError(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingMore(false);
    }
  }, [ready, nextCursor, loadingMore, fetchPage]);

  // The filters are part of the identity of "the first page", so a filter change
  // resets rather than appends.
  useEffect(() => {
    if (!ready) {
      return;
    }

    setLoading(true);
    void load();
  }, [ready, load]);

  useEffect(() => {
    if (!ready || refreshIntervalMs <= 0) {
      return;
    }

    const handle = window.setInterval(() => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        return;
      }

      void refreshHead();
    }, refreshIntervalMs);

    return () => window.clearInterval(handle);
  }, [ready, refreshHead, refreshIntervalMs]);

  const rows = useMemo(() => (pages == null ? null : pages.flat()), [pages]);

  return {
    rows,
    loading,
    loadingMore,
    error,
    hasMore: nextCursor != null,
    loadMore,
    refresh: load,
  } as const;
}
