import { useCallback, useState } from 'react';

import { fetchJson } from '@ci/common';

import { useAuth } from '@/hooks';

interface ConnectResponse {
  authorizationUrl: string;
}

type ReturnType = [
  {
    authorizationUrl: string | null;
    loading: boolean;
    error: unknown | null;
    endpoints: string[];
    apiKey: string | null;
    setEndpoints: (endpoints: string[]) => void;
    setApiKey: (apiKey: string) => void;
  },
  {
    connect: (providerId: string) => Promise<void>;
  },
];

export function useConnectService(): ReturnType {
  const [{ authToken }] = useAuth();

  const [authorizationUrl, setAuthorizationUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<unknown | null>(null);
  const [endpoints, setEndpoints] = useState<string[]>([]);
  const [apiKey, setApiKey] = useState<string | null>(null);

  const connect = useCallback(
    async (providerId: string) => {
      setAuthorizationUrl(null);
      setLoading(true);
      setError(null);

      try {
        const response = await fetchJson<ConnectResponse>(`/api/providers/${providerId}`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${authToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ endpoints: endpoints || [], apiKey: apiKey || undefined }),
        });

        setAuthorizationUrl(response.authorizationUrl);
      } catch (err: unknown) {
        setError(err);
      } finally {
        setLoading(false);
      }
    },
    [authToken, endpoints, apiKey],
  );

  return [
    {
      authorizationUrl,
      loading,
      error,
      endpoints,
      setEndpoints,
      apiKey,
      setApiKey,
    },
    {
      connect,
    },
  ];
}
