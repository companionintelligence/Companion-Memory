import { useCallback, useEffect, useMemo, useState } from 'react';

import { fetchJson } from '@ci/common';

import { useAuth } from '@/hooks';

export type AgentHarnessId = 'hermes' | 'openclaw';

export type DispatchBlocker =
  | 'not_installed'
  | 'not_connected'
  | 'not_running'
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

function authHeaders(authToken: string | null | undefined): HeadersInit {
  return {
    Authorization: `Bearer ${authToken}`,
  };
}

export async function fetchAgentHarnesses(
  authToken: string | null | undefined,
  options: { force?: boolean } = {},
): Promise<AgentHarnessesResponse> {
  if (!authToken) {
    return { harnesses: [] };
  }

  if (!options.force && cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  if (!options.force && inflight) {
    return inflight;
  }

  inflight = fetchJson<AgentHarnessesResponse>('/api/v1/intelligence/agent-harnesses', {
    headers: authHeaders(authToken),
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
  const [{ authToken }] = useAuth();
  const [harnesses, setHarnesses] = useState<AgentHarnessStatus[]>(cached?.value.harnesses ?? []);
  const [loading, setLoading] = useState(!cached);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!authToken) {
      setHarnesses([]);
      setLoading(false);

      return { harnesses: [] };
    }

    setLoading(true);
    setError(null);

    try {
      const result = await fetchAgentHarnesses(authToken, { force: true });
      setHarnesses(result.harnesses);

      return result;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load agent harnesses.');
      throw err;
    } finally {
      setLoading(false);
    }
  }, [authToken]);

  useEffect(() => {
    let cancelled = false;

    if (!authToken) {
      setHarnesses([]);
      setLoading(false);

      return;
    }

    setLoading(!cached);
    void fetchAgentHarnesses(authToken)
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
  }, [authToken]);

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
