import { useState, useCallback } from 'react';

import { fetchJson } from '@ci/common';
import { useFormContext } from '@ci/shadcn';

import { useAuth, useCurrentUser } from '@/hooks';
import { markGettingStartedActive } from '@/lib/gettingStarted';

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
  const { user, refetch: refetchCurrentUser } = useCurrentUser();
  const userId = user?.id ?? null;

  const [loading, setLoading] = useState(false);
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
          // Native has no JWT. `fetchJson` attaches `x-api-key` on that
          // platform; sending `Bearer null` would make the guard try a junk
          // token before the key.
          ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
        },
        body: JSON.stringify(form.getValues()),
      });

      // Before the refetch: that flips `onboarded`, which redirects out of the
      // wizard, and the destination should already know to show the banner.
      if (userId) {
        markGettingStartedActive(userId);
      }

      await refetchCurrentUser();
    } catch (err) {
      setError(err);
    } finally {
      setLoading(false);
    }
  }, [form, authToken, refetchCurrentUser, userId]);

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
