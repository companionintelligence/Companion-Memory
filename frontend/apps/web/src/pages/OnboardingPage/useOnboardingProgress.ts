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
  const [{ authToken }] = useAuth();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);

  const fetchProgress = useCallback(async (): Promise<OnboardingProgress | null> => {
    if (!authToken) {
      setLoading(false);

      return null;
    }

    setLoading(true);
    setError(null);

    try {
      const progress = await fetchJson<OnboardingProgress>('/api/onboarding/progress', {
        headers: { Authorization: `Bearer ${authToken}` },
      });

      return progress ?? null;
    } catch (err) {
      setError(err);

      return null;
    } finally {
      setLoading(false);
    }
  }, [authToken]);

  const saveProgress = useCallback(
    async (stepKey: OnboardingStepKey, draft: Record<string, unknown>) => {
      if (!authToken) {
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
            Authorization: `Bearer ${authToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ stepKey, draft }),
        });
        setError(null);
      } catch (err: unknown) {
        setError(err instanceof Error ? err : new Error(String(err)));
      }
    },
    [authToken],
  );

  return {
    loading,
    error,
    fetchProgress,
    saveProgress,
  };
}
