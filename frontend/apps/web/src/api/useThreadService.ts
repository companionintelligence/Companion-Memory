import { useState, useEffect, useCallback } from 'react';

import { fetchJson } from '@ci/common';

import { useAuth } from '@/hooks';

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
  const [{ authToken }] = useAuth();

  const [thread, setThread] = useState<Thread | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown | null>(null);

  const fetchThread = useCallback(async () => {
    if (id == null) {
      setThread(null);
      setError(null);
      setLoading(false);

      return;
    }

    setLoading(true);

    try {
      const thread = await fetchJson<Thread>(`/api/threads/${id}?includeMessages=true`, {
        headers: {
          Authorization: `Bearer ${authToken}`,
          'Content-Type': 'application/json',
        },
      });

      setThread(thread ?? null);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [setLoading, setThread, setError, id]);

  useEffect(() => {
    fetchThread();
  }, [id]);

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
