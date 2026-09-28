import { useCallback, useState } from 'react';

import { fetchJson } from '@ci/common';

import { useAuth } from '@/hooks';

import type { OnboardingStepKey } from './constants';

export interface OnboardingProgress {
  stepKey: OnboardingStepKey;
  draft: Record<string, unknown>;
  updatedAt: string | null;
}

export function useOnboardingProgress() {
  const [{ authToken, authenticated }] = useAuth();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  const fetchProgress = useCallback(async (): Promise<OnboardingProgress | null> => {
    // A phone session is an API key with no JWT. `authenticated` covers that;
    // `fetchJson` adds `x-api-key`. Skipping on a missing bearer used to drop
    // every progress read on the native app.
    if (!authenticated) {
      setLoading(false);

      return null;
    }

    setLoading(true);
    setError(null);

    try {
      const progress = await fetchJson<OnboardingProgress>('/api/onboarding/progress', {
        headers: authToken ? { Authorization: `Bearer ${authToken}` } : {},
      });

      return progress ?? null;
    } catch (err) {
      setError(err);

      return null;
    } finally {
      setLoading(false);
    }
  }, [authToken, authenticated]);

  const saveProgress = useCallback(
    async (stepKey: OnboardingStepKey, draft: Record<string, unknown>) => {
      if (!authenticated) {
        return;
      }

      // Saving progress is a convenience, never a precondition for moving: the
      // hydrate path already falls back to the first step when the read fails.
      // This used to throw, and every caller advanced the step only *after*
      // awaiting it — so one failed PUT (a phone stepping off the appliance's
      // LAN mid-setup, which is the normal case on the native shells) left the
      // whole footer looking live and doing nothing.
      try {
        await fetchJson<OnboardingProgress>('/api/onboarding/progress', {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
          },
          body: JSON.stringify({ stepKey, draft }),
        });
        setError(null);
      } catch (err: unknown) {
        setError(err instanceof Error ? err : new Error(String(err)));
      }
    },
    [authToken, authenticated],
  );

  return {
    loading,
    error,
    fetchProgress,
    saveProgress,
  };
}
