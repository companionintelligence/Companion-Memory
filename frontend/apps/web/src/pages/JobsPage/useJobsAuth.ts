import { useMemo } from 'react';

import { useAuth } from '@/hooks';

/**
 * How this page's requests authenticate, on both clients.
 *
 * Every Jobs request used to gate on `authToken` and send it as a bearer — and
 * `authToken` is the web JWT, which is **null on native**: the phone's durable
 * credential is a keystore API key that `fetchJson` attaches as `x-api-key` by
 * itself (see `useAuth`, which reports it through `authenticated` instead). So
 * inside the Capacitor app all five Jobs requests returned before they were
 * made — the dashboard sat on skeletons forever, the Refresh button refreshed
 * nothing, and a swipe-down had nothing to drive.
 *
 * `JobsController` and `PipelineController` both guard with
 * `JwtOrApiKeyAuthGuard`, so the key is a credential the server already takes.
 * Gate on `authenticated`, and send the bearer only when there is one.
 */
export function useJobsAuth(): { ready: boolean; headers: Record<string, string> } {
  const [{ authToken, authenticated }] = useAuth();

  // Stable identity, because the load callbacks below take it as a dependency.
  // Built rather than ternaried: the conditional form infers
  // `{ Authorization?: undefined }` for the empty arm, which
  // `exactOptionalPropertyTypes` refuses to widen to Record<string, string>.
  const headers = useMemo<Record<string, string>>(() => {
    const next: Record<string, string> = {};
    if (authToken) {
      next.Authorization = `Bearer ${authToken}`;
    }

    return next;
  }, [authToken]);

  return { ready: Boolean(authenticated), headers };
}
