import { useMemo } from 'react';

import { useAuth } from './useAuth';

/**
 * Session for both clients: web JWT and native API key.
 *
 * Chat, models, and the LLM endpoint used to gate on `authToken` and send it as
 * a bearer. `authToken` is the web JWT, which is **null on native**: the phone's
 * durable credential is a keystore API key that `fetchJson` / `streamingFetch`
 * attach as `x-api-key` (see `useAuth`, which reports it through `authenticated`).
 * The LLM and thread controllers already accept that key via
 * `JwtOrApiKeyAuthGuard`. Gate on `authenticated`, and send the bearer only
 * when there is one — never `Authorization: Bearer null`.
 */
export function useSessionAuth(): {
  ready: boolean;
  authToken: string | null;
  headers: Record<string, string>;
} {
  const [{ authToken, authenticated, expired }] = useAuth();

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

  return { ready: Boolean(authenticated) && !expired, authToken: authToken ?? null, headers };
}
