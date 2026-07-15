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
  const [{ authToken }] = useAuth();

  const { data, loading, error, refetch } = useQuery(USER_DATA_QUERY, {
    skip: !authToken,
  });

  return {
    user: data?.me || null,
    loading: loading || (!!authToken && !data && !error),
    error,
    refetch,
  };
}
