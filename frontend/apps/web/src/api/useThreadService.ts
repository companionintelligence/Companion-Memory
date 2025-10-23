import { useState, useEffect, useCallback, useRef } from 'react';

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

  const latestIdRef = useRef<string | null>(id);
  const previousIdRef = useRef<string | null>(id);

  useEffect(() => {
    latestIdRef.current = id;
  }, [id]);

  useEffect(() => {
    if (previousIdRef.current !== id) {
      setThread(null);
      setError(null);
    }

    previousIdRef.current = id;
  }, [id]);

  const fetchThread = useCallback(async () => {
    if (id == null) {
      setThread(null);
      setError(null);
      setLoading(false);

      return;
    }

    setLoading(true);

    const requestId = id;

    try {
      const result = await fetchJson<Thread>(`/api/threads/${requestId}?includeMessages=true`, {
        headers: {
          Authorization: `Bearer ${authToken}`,
          'Content-Type': 'application/json',
        },
      });

      if (latestIdRef.current !== requestId) {
        return;
      }

      setThread(result);
      setError(null);
    } catch (err) {
      if (latestIdRef.current === requestId) {
        setError(err);
      }
    } finally {
      if (latestIdRef.current === requestId) {
        setLoading(false);
      }
    }
  }, [authToken, id]);

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
