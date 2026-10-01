import { useCallback, useEffect, useState } from 'react';

import { fetchJson } from '@ci/common';

import { useSessionAuth } from './useSessionAuth';

export type LlmBackendKind = 'ollama' | 'openai_compatible';

export interface LlmEndpointConfig {
  backend: LlmBackendKind;
  port: number;
  /** The API root on an OpenAI-compatible backend (`/v1`, or Lemonade's `/api/v1`); absent on Ollama. */
  basePath?: string;
  hostGateway: string;
  locked: boolean;
  endpoint: string;
  /** The server intentionally never returns the credential itself. */
  apiKeyConfigured: boolean;
}

export interface LlmEndpointUpdate {
  backend: LlmBackendKind;
  port: number;
  /** OpenAI-compatible only: where the server mounts its API; `/v1` when omitted. */
  basePath?: string;
  /** Write-only replacement for a saved OpenAI-compatible credential. */
  apiKey?: string;
  /** Removes the appliance-saved credential and falls back to runtime config. */
  clearApiKey?: boolean;
}

export interface LlmEndpointPreflight {
  backend: LlmBackendKind;
  endpoint: string;
  ok: boolean;
  models: string[];
  message?: string;
  status?: number;
}

export function useLlmEndpoint() {
  const { ready, headers } = useSessionAuth();
  const [config, setConfig] = useState<LlmEndpointConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preflight, setPreflight] = useState<LlmEndpointPreflight | null>(null);

  const fetchEndpoint = useCallback(async () => {
    if (!ready) {
      return null;
    }

    setLoading(true);
    setError(null);

    try {
      const data = await fetchJson<LlmEndpointConfig>('/api/llm/endpoint', {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          ...headers,
        },
      });

      if (data) {
        setConfig(data);
      }

      return data ?? null;
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load LLM endpoint settings.');

      return null;
    } finally {
      setLoading(false);
    }
  }, [ready, headers]);

  const saveEndpoint = useCallback(
    async (next: LlmEndpointUpdate) => {
      if (!ready) {
        return null;
      }

      setSaving(true);
      setError(null);

      try {
        const data = await fetchJson<LlmEndpointConfig>('/api/llm/endpoint', {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            ...headers,
          },
          body: JSON.stringify(next),
        });

        if (data) {
          setConfig(data);
        }

        return data ?? null;
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to save LLM endpoint settings.');

        return null;
      } finally {
        setSaving(false);
      }
    },
    [ready, headers],
  );

  const checkEndpoint = useCallback(async () => {
    if (!ready) {
      return null;
    }

    setTesting(true);
    setError(null);

    try {
      const data = await fetchJson<LlmEndpointPreflight>('/api/llm/endpoint/preflight', {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          ...headers,
        },
      });

      setPreflight(data ?? null);

      return data ?? null;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to check the inference server.';
      setError(message);
      setPreflight(null);

      return null;
    } finally {
      setTesting(false);
    }
  }, [ready, headers]);

  useEffect(() => {
    void fetchEndpoint();
  }, [fetchEndpoint]);

  return {
    config,
    loading,
    saving,
    testing,
    error,
    preflight,
    fetchEndpoint,
    saveEndpoint,
    checkEndpoint,
  };
}
