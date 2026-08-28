import { useEffect, useMemo, useRef, useState } from 'react';

import { fetchJson } from '@ci/common';

import { useSessionAuth } from '@/hooks/useSessionAuth';

import type { Thread } from './types';

/** How many threads a compact list (the rail submenu) will ever show. */
export const RECENT_THREAD_LIMIT = 10;

/** Skip a refetch if the list we already have is younger than this. */
const STALE_MS = 30_000;

/**
 * What to call a thread nobody named.
 *
 * Shared so the drawer submenu and the desktop sidebar cannot drift into two
 * different names for the same conversation.
 */
export function threadLabel(thread: Pick<Thread, 'id' | 'name'>): string {
  return thread.name || `Thread ${thread.id.slice(0, 8)}`;
}

interface Options {
  /**
   * Fetch only while this is true.
   *
   * The rail renders on every page, so an eager thread list would be a request
   * per navigation for a menu nobody opened. This one fires when the submenu is
   * actually expanded, and not again until the answer goes stale.
   */
  enabled: boolean;
  limit?: number;
}

interface RecentThreads {
  threads: Thread[];
  loading: boolean;
  error: unknown;
}

/**
 * The newest threads, for picking one — not for managing them.
 *
 * {@link useThreadListService} is the Chat page's full-fat version: it deletes,
 * polls while a generation runs, and owns the sidebar's state. This is the
 * read-only slice the navigation needs, capped, and idle until asked.
 */
export function useRecentThreads({ enabled, limit = RECENT_THREAD_LIMIT }: Options): RecentThreads {
  const { ready, headers } = useSessionAuth();
  const [threads, setThreads] = useState<Thread[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const fetchedAt = useRef(0);

  // Hovering the rail flickers `enabled` on and off; a session change means a
  // different user's threads, so that one always refetches. Native has no JWT —
  // `ready` flipping true after the keystore restore is the signal.
  useEffect(() => {
    fetchedAt.current = 0;
  }, [ready]);

  useEffect(() => {
    if (!enabled || !ready || Date.now() - fetchedAt.current < STALE_MS) {
      return;
    }

    let cancelled = false;
    fetchedAt.current = Date.now();
    setLoading(true);
    setError(null);

    fetchJson<Thread[]>('/api/threads', {
      headers: {
        ...headers,
        'Content-Type': 'application/json',
      },
    })
      .then((data) => {
        if (!cancelled) {
          setThreads(data ?? []);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          // Let the next open try again rather than sitting on a failure.
          fetchedAt.current = 0;
          setError(err);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [enabled, ready, headers]);

  // The API orders by `updatedAt` descending, so the head of the list is the
  // most recent — no client-side sort, just a cap.
  const recent = useMemo(() => threads.slice(0, limit), [threads, limit]);

  return { threads: recent, loading, error };
}
