import { useState, useCallback } from 'react';

import { fetchJson } from '@ci/common';

import { useAuth } from '@/hooks';

interface Response {
  onboarded: boolean;
}

type ReturnType = [
  {
    loading: boolean;
    error: unknown | null;
  },
  {
    onboard: () => void;
  },
];

export function useOnboardService(): ReturnType {
  const [{ authToken }] = useAuth();

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<unknown | null>(null);

  const onboard = useCallback(async () => {
    setError(null);
    setLoading(true);

    const formData = new FormData();

    try {
      await fetchJson<Response>('/api/onboarding/onboard', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${authToken}`,
        },
        body: formData,
      });
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [authToken]);

  return [
    {
      loading,
      error,
    },
    {
      onboard,
    },
  ];
}
