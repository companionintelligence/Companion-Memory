import { useQuery } from '@apollo/client';

import { gql } from '@/graphql';

import { useAuth } from './useAuth';

const USER_DATA_QUERY = gql(`
  query GetUserData {
    me {
      id
      name
      email
      onboarded
      timezone

      entity {
        id
      }
    }
  }
`);

export function useCurrentUser() {
  // `authenticated` is true for a web JWT session OR a native API key, so the `me`
  // query runs (and gates "logged in") under either credential.
  const [{ authenticated }] = useAuth();

  const { data, loading, error, refetch } = useQuery(USER_DATA_QUERY, {
    skip: !authenticated,
  });

  return {
    user: data?.me || null,
    loading: loading || (authenticated && !data && !error),
    error,
    refetch,
  };
}
