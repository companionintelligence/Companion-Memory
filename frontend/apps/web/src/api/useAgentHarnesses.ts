import { useCallback, useEffect, useMemo, useState } from 'react';

import { fetchJson } from '@ci/common';

import { useAuth } from '@/hooks';

export type AgentHarnessId = 'hermes' | 'openclaw';

export type DispatchBlocker =
  | 'not_installed'
  | 'not_connected'
  | 'not_running'
  /** The APPLIANCE cannot ring Hub — nothing to do with OpenClaw's own state. */
  | 'doorbell_unconfigured'
  | 'not_wakeable'
  | 'chat_only'
  | null;

export interface AgentHarnessStatus {
  id: AgentHarnessId;
  name: string;
  connectedToMemory: boolean;
  installed: boolean;
  running: boolean;
  openUrl: string | null;
  accessible: boolean;
  wakeable: boolean;
  dispatchReady: boolean;
  dispatchBlocker: DispatchBlocker;
  connectUrl: string | null;
}

interface AgentHarnessesResponse {
  harnesses: AgentHarnessStatus[];
}

const CACHE_TTL_MS = 30_000;

let cached: { expiresAt: number; value: AgentHarnessesResponse } | null = null;
let inflight: Promise<AgentHarnessesResponse> | null = null;

/** Whether to ask, and what to send when asking: a bearer only when the session has a web JWT. */
interface SessionAuth {
  ready: boolean;
  headers: Record<string, string>;
}

export async function fetchAgentHarnesses(
  session: SessionAuth,
  options: { force?: boolean } = {},
): Promise<AgentHarnessesResponse> {
  if (!session.ready) {
    return { harnesses: [] };
  }

  if (!options.force && cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  if (!options.force && inflight) {
    return inflight;
  }

  inflight = fetchJson<AgentHarnessesResponse>('/api/v1/intelligence/agent-harnesses', {
    headers: session.headers,
  })
    .then((result) => {
      const value = result ?? { harnesses: [] };
      cached = { expiresAt: Date.now() + CACHE_TTL_MS, value };
      inflight = null;

      return value;
    })
    .catch((error) => {
      inflight = null;
      throw error;
    });

  return inflight;
}

/** Discover Hub agent harnesses (Hermes / OpenClaw) with Portal-resolved open URLs. */
export function useAgentHarnesses() {
  // `authenticated`, not `authToken`: the token is the web JWT, which the native shell never has —
  // its credential is a keystore API key that `fetchJson` attaches as `x-api-key`. Gating on the token
  // made the phone's Agents list (and its chat-about menus) report no harnesses though the server
  // listed them; the route takes the key (`JwtOrApiKeyAuthGuard`, `memory` scope, `read`).
  //
  // Reads `useAuth` rather than `useSessionAuth` on purpose: this hook sits under the chat-about menu,
  // which many screens render, and `useAuth` is the one seam every one of their tests already stubs.
  const [{ authToken, authenticated }] = useAuth();
  const ready = Boolean(authenticated);
  // Stable per token, because the load callbacks below take it as a dependency. Built rather than
  // ternaried: the conditional form infers `{ Authorization?: undefined }` for the empty arm, which
  // `exactOptionalPropertyTypes` refuses to widen to Record<string, string>.
  const headers = useMemo<Record<string, string>>(() => {
    const next: Record<string, string> = {};
    if (authToken) {
      next.Authorization = `Bearer ${authToken}`;
    }

    return next;
  }, [authToken]);
  const [harnesses, setHarnesses] = useState<AgentHarnessStatus[]>(cached?.value.harnesses ?? []);
  const [loading, setLoading] = useState(!cached);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!ready) {
      setHarnesses([]);
      setLoading(false);

      return { harnesses: [] };
    }

    setLoading(true);
    setError(null);

    try {
      const result = await fetchAgentHarnesses({ ready, headers }, { force: true });
      setHarnesses(result.harnesses);

      return result;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load agent harnesses.');
      throw err;
    } finally {
      setLoading(false);
    }
  }, [ready, headers]);

  useEffect(() => {
    let cancelled = false;

    if (!ready) {
      setHarnesses([]);
      setLoading(false);

      return;
    }

    setLoading(!cached);
    void fetchAgentHarnesses({ ready, headers })
      .then((result) => {
        if (!cancelled) {
          setHarnesses(result.harnesses);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Could not load agent harnesses.');
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [ready, headers]);

  const runningHarnesses = useMemo(
    () => harnesses.filter((harness) => harness.running && harness.openUrl),
    [harnesses],
  );
  const chatableHarnesses = useMemo(
    () =>
      harnesses.filter((harness) => {
        if (!harness.openUrl || !harness.running) {
          return false;
        }

        return harness.id === 'openclaw' ? harness.connectedToMemory : true;
      }),
    [harnesses],
  );

  return {
    harnesses,
    runningHarnesses,
    chatableHarnesses,
    /** @deprecated Prefer {@link runningHarnesses}. */
    openableHarnesses: runningHarnesses,
    /** @deprecated Prefer {@link runningHarnesses}. */
    accessibleHarnesses: runningHarnesses,
    loading,
    error,
    reload,
  };
}
