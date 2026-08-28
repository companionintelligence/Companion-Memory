import { useState, useEffect, useCallback } from 'react';

import { apiFetch, apiKeyHeaders, fetchJson } from '@ci/common';

import { useSessionAuth } from '@/hooks/useSessionAuth';

import type { Thread } from './types';

type ReturnType = [
  {
    threads: Thread[];
    loading: boolean;
    error: unknown;
  },
  {
    refetch: () => void;
    delete: (id: string) => void;
  },
];

export function useThreadListService(): ReturnType {
  const { ready, headers } = useSessionAuth();

  const [threads, setThreads] = useState<Thread[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown | null>(null);

  const fetchThreads = useCallback(async () => {
    if (!ready) {
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const data = await fetchJson<Thread[]>('/api/threads', {
        headers: {
          ...headers,
          'Content-Type': 'application/json',
        },
      });

      setThreads(data ?? []);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [ready, headers]);

  const deleteThread = useCallback(
    async (id: string) => {
      const res = await apiFetch(`/api/threads/${id}`, {
        method: 'DELETE',
        headers: {
          ...apiKeyHeaders(),
          ...headers,
        },
      });

      if (!res.ok) {
        throw new Error(`Failed to delete thread ${id}`);
      }

      setThreads((prev) => prev.filter((t) => t.id !== id));
    },
    [headers],
  );

  useEffect(() => {
    void fetchThreads();
  }, [fetchThreads]);

  const busy = threads.some(
    (thread) => thread.generationStatus === 'queued' || thread.generationStatus === 'running',
  );

  useEffect(() => {
    if (!busy) {
      return;
    }

    const timer = window.setInterval(() => {
      void fetchThreads();
    }, 2000);

    return () => window.clearInterval(timer);
  }, [busy, fetchThreads]);

  return [
    {
      threads,
      loading,
      error,
    },
    {
      refetch: fetchThreads,
      delete: deleteThread,
    },
  ];
}
