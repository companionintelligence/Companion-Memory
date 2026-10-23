import { useEffect, useSyncExternalStore } from 'react';

import { useQuery } from '@apollo/client';
import { getApiBaseUrl, isNativePlatform, subscribeApiBaseUrl } from '@ci/common';

import { gql } from '@/graphql';

import { isApplianceOutage, recallUser, rememberUser } from './rememberedUser';
import { useAuth } from './useAuth';

const USER_DATA_QUERY = gql(`
  query GetUserData {
    me {
      id
      name
      email
      onboarded
      needsIdentityStep
      timezone
      avatarUrl
      isAdmin

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
  const origin = useSyncExternalStore(subscribeApiBaseUrl, getApiBaseUrl, getApiBaseUrl);
  // Native CapacitorHttp rejects relative `/api/graphql`. A restored API key with
  // no Memory origin (cleared WebView storage, mid cloud-connect) must not fire.
  const skip = !authenticated || (isNativePlatform() && !origin);

  const { data, loading, error, refetch } = useQuery(USER_DATA_QUERY, {
    skip,
    // `entity` resolves independently; a graph lookup failure must not discard
    // the rest of `me` and strand the session behind an infinite spinner.
    errorPolicy: 'all',
  });

  // A phone keeps the profile the appliance last gave it, and answers with it while the
  // appliance cannot be reached: its key does not expire, and the phone's own copy of the
  // user's memory is there to be used. See rememberedUser.ts.
  const native = isNativePlatform();
  const me = data?.me ?? null;

  useEffect(() => {
    if (native && me && origin) {
      rememberUser(origin, me);
    }
  }, [native, me, origin]);

  const remembered =
    native && !skip && !me && isApplianceOutage(error) ? recallUser<typeof me>(origin) : null;

  return {
    user: me ?? remembered,
    /** True when `user` is the profile kept from an earlier session because the appliance did not answer. */
    remembered: remembered != null,
    loading: loading || (authenticated && !skip && data == null && !error),
    error,
    refetch,
  };
}
