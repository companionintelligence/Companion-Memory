import { useCallback, useEffect, useState } from 'react';

import { fetchJson } from '@ci/common';

import { useAuth } from '@/hooks';

import { type Action } from './types';

export function useActionListService() {
  const [{ authToken }] = useAuth();

  const [actions, setActions] = useState<Action[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown | null>(null);

  const fetchAnswers = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);

      const data = await fetchJson<Action[]>('/api/actions', {
        headers: {
          Authorization: `Bearer ${authToken}`,
          'Content-Type': 'application/json',
        },
      });

      setActions(data);
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [authToken]);

  useEffect(() => {
    fetchAnswers();
  }, []);

  return [
    {
      data: actions,
      loading,
      error,
    },
  ];
}
