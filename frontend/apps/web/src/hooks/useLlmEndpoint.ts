import { useCallback, useEffect, useState } from 'react';

import { fetchJson } from '@ci/common';

import { useSessionAuth } from './useSessionAuth';

export type LlmBackendKind = 'ollama' | 'openai_compatible';

export interface LlmEndpointConfig {
  backend: LlmBackendKind;
  port: number;
  apiKey?: string;
  hostGateway: string;
  locked: boolean;
}

export function useLlmEndpoint() {
  const { ready, headers } = useSessionAuth();
  const [config, setConfig] = useState<LlmEndpointConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
    async (next: Pick<LlmEndpointConfig, 'backend' | 'port' | 'apiKey'>) => {
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

  useEffect(() => {
    void fetchEndpoint();
  }, [fetchEndpoint]);

  return {
    config,
    loading,
    saving,
    error,
    fetchEndpoint,
    saveEndpoint,
  };
}
