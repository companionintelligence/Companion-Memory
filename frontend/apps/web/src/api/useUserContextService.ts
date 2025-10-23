import { useCallback, useEffect, useState } from 'react';

import { fetchJson } from '@ci/common';

import { useAuth } from '@/hooks';

import type { UserContext, UserContextResponse } from './types';

type State = {
  context: UserContext | null;
  loading: boolean;
  error: unknown | null;
};

type Controls = {
  refetch: () => Promise<void>;
};

export function useUserContextService(): [State, Controls] {
  const [{ authToken }] = useAuth();

  const [context, setContext] = useState<UserContext | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<unknown | null>(null);

  const fetchContext = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const response = await fetchJson<UserContextResponse>('/api/graph/context', {
        headers: {
          Authorization: `Bearer ${authToken}`,
          'Content-Type': 'application/json',
        },
      });

      if (!response.success) {
        throw new Error('Failed to load user context');
      }

      setContext(response.context ?? null);
    } catch (err) {
      setError(err);
      setContext(null);
    } finally {
      setLoading(false);
    }
  }, [authToken]);

  useEffect(() => {
    void fetchContext();
  }, [fetchContext]);

  return [
    {
      context,
      loading,
      error,
    },
    {
      refetch: fetchContext,
    },
  ];
}
