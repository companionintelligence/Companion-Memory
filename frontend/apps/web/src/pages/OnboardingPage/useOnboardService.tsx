import { useState, useCallback } from 'react';

import { fetchJson } from '@ci/common';
import { useFormContext } from '@ci/shadcn';

import { useAuth, useCurrentUser } from '@/hooks';

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
  const { refetch: refetchCurrentUser } = useCurrentUser();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown | null>(null);

  const form = useFormContext();

  const onboard = useCallback(async () => {
    setError(null);
    setLoading(true);

    try {
      await fetchJson<Response>('/api/onboarding/onboard', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${authToken}`,
        },
        body: JSON.stringify(form.getValues()),
      });

      await refetchCurrentUser();
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [form, authToken, refetchCurrentUser]);

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
