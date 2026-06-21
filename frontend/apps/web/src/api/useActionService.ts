import { useCallback, useEffect, useState } from 'react';

import { fetchJson } from '@ci/common';

import { useAuth } from '@/hooks';

import { type Action } from './types';

export function useActionService(id: string | null) {
  const [{ authToken }] = useAuth();

  const [data, setData] = useState<Action | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown | null>(null);

  const fetch = useCallback(async () => {
    if (id == null) {
      setData(null);
      setLoading(false);
      setError(null);
    } else {
      try {
        setLoading(true);
        setError(null);

        const data = await fetchJson<Action>(`/api/actions/${id}`, {
          headers: {
            Authorization: `Bearer ${authToken}`,
            'Content-Type': 'application/json',
          },
        });

        setData(data ?? null);
      } catch (err) {
        setError(err);
      } finally {
        setLoading(false);
      }
    }
  }, [authToken, id]);

  useEffect(() => {
    fetch();
  }, [id]);

  return [
    {
      data,
      loading,
      error,
    },
    {
      refetch: fetch,
    },
  ];
}
