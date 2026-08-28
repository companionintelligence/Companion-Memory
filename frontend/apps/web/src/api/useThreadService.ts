import { useState, useEffect, useCallback } from 'react';

import { fetchJson } from '@ci/common';

import { useSessionAuth } from '@/hooks/useSessionAuth';

import type { Thread } from './types';

type ReturnType = [
  {
    thread: Thread | null;
    loading: boolean;
    error: unknown;
  },
  {
    refetch: () => void;
  },
];

export function useThreadService(id: string | null): ReturnType {
  const { ready, headers } = useSessionAuth();

  const [thread, setThread] = useState<Thread | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown | null>(null);

  const fetchThread = useCallback(async () => {
    if (id == null || !ready) {
      setThread(null);
      setError(null);
      setLoading(false);

      return;
    }

    setLoading(true);

    try {
      const thread = await fetchJson<Thread>(`/api/threads/${id}?includeMessages=true`, {
        headers: {
          ...headers,
          'Content-Type': 'application/json',
        },
      });

      setThread(thread ?? null);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [headers, id, ready]);

  useEffect(() => {
    void fetchThread();
  }, [fetchThread]);

  return [
    {
      thread,
      loading,
      error,
    },
    {
      refetch: fetchThread,
    },
  ];
}
