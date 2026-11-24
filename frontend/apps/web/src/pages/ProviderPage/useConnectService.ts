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
    apiKey: string | null;
    setApiKey: (apiKey: string) => void;
    /** The account to connect, for a provider whose key serves several (Signal: the number). */
    account: string | null;
    setAccount: (account: string) => void;
  },
  {
    connect: (providerId: string, endpoints: string[]) => Promise<void>;
  },
];

export function useConnectService(): ReturnType {
  const [{ authToken }] = useAuth();

  const [authorizationUrl, setAuthorizationUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<unknown | null>(null);
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [account, setAccount] = useState<string | null>(null);

  const connect = useCallback(
    async (providerId: string, endpoints: string[]) => {
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
          body: JSON.stringify({
            endpoints: endpoints || [],
            apiKey: apiKey || undefined,
            account: account?.trim() || undefined,
          }),
        });

        setAuthorizationUrl(response?.authorizationUrl ?? null);
      } catch (err: unknown) {
        setError(err);
      } finally {
        setLoading(false);
      }
    },
    [authToken, apiKey, account],
  );

  return [
    {
      authorizationUrl,
      loading,
      error,
      apiKey,
      setApiKey,
      account,
      setAccount,
    },
    {
      connect,
    },
  ];
}
