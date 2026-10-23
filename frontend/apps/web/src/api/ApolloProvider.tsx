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

import { createOfflineWriteLink } from './offlineWriteLink';

export function ApolloProvider({ children }: { children: ReactNode }) {
  const [{ authToken, authenticated }] = useAuth();

  const tokenRef = useRef(authToken);
  // Only wipe the cache when a session actually ends. The first frame of every
  // load has no JWT yet, and the phone never has one (the session is an API
  // key). Clearing on `authToken == null` deleted `me` after onboarding had
  // already started, the route fell back to the loader, and the welcome
  // typing played again.
  const hadSession = useRef(false);

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

    // The write guard sits in front of auth and transport: a mutation refused while the
    // appliance is unreachable never gets headers, never goes out (`offlineWriteLink.ts`).
    const offlineWriteLink = createOfflineWriteLink();

    return new ApolloClient({
      link: offlineWriteLink.concat(authLink).concat(httpLink),
      cache: new InMemoryCache({
        possibleTypes: introspectionResult.possibleTypes,
      }),
    });
  }, []);

  useEffect(() => {
    if (authenticated) {
      hadSession.current = true;

      return;
    }

    if (!hadSession.current) {
      return;
    }

    hadSession.current = false;
    void client.clearStore();
  }, [client, authenticated]);

  return <BaseApolloProvider client={client}>{children}</BaseApolloProvider>;
}
