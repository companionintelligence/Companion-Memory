import { useState, useEffect, useCallback } from 'react';

import { fetchJson } from '@ci/common';

import { useAuth } from '@/hooks';

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
  const [{ authToken }] = useAuth();

  const [threads, setThreads] = useState<Thread[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown | null>(null);

  const fetchThreads = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const data = await fetchJson<Thread[]>('/api/threads', {
        headers: {
          Authorization: `Bearer ${authToken}`,
          'Content-Type': 'application/json',
        },
      });

      setThreads(data);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [setLoading, setError, setThreads, authToken]);

  const deleteThread = useCallback(
    async (id: string) => {
      const res = await fetch(`/api/threads/${id}`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${authToken}`,
        },
      });

      if (!res.ok) {
        throw new Error(`Failed to delete thread ${id}`);
      }

      setThreads((prev) => prev.filter((t) => t.id !== id));
    },
    [authToken],
  );

  useEffect(() => {
    fetchThreads();
  }, []);

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
