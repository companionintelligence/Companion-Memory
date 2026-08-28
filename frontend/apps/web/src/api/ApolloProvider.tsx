import { useEffect, useMemo, useRef, type ReactNode } from 'react';

import {
  ApolloClient,
  ApolloProvider as BaseApolloProvider,
  InMemoryCache,
  createHttpLink,
} from '@apollo/client';
import { setContext } from '@apollo/client/link/context';
import { apiFetch, apiKeyHeaders, buildApiUrl } from '@ci/common';

import introspectionResult from '@/graphql/possibleTypes';
import { useAuth } from '@/hooks';

export function ApolloProvider({ children }: { children: ReactNode }) {
  const [{ authToken }] = useAuth();

  const tokenRef = useRef(authToken);

  tokenRef.current = authToken;

  const client = useMemo(() => {
    // Resolve the Memory origin per request. Pairing writes the origin after
    // this client is created; a baked-in URI would keep hitting Vite / leftover
    // localhost. Native `fetch` is also CORS-bound — apiFetch uses CapacitorHttp.
    const httpLink = createHttpLink({
      uri: () => buildApiUrl('/api/graphql'),
      fetch: apiFetch,
    });

    const authLink = setContext((_, { headers }) => {
      return {
        headers: {
          ...headers,
          // x-api-key authenticates the native app (empty on web); the JWT Bearer
          // authenticates the web session. The guard accepts whichever is present.
          ...apiKeyHeaders(),
          authorization: tokenRef.current ? `Bearer ${tokenRef.current}` : '',
        },
      };
    });

    return new ApolloClient({
      link: authLink.concat(httpLink),
      cache: new InMemoryCache({
        possibleTypes: introspectionResult.possibleTypes,
      }),
    });
  }, []);

  useEffect(() => {
    if (authToken == null) {
      client.clearStore();
    }
  }, [client, authToken]);

  return <BaseApolloProvider client={client}>{children}</BaseApolloProvider>;
}
