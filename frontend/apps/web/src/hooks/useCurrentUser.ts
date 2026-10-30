import { useEffect, useSyncExternalStore } from 'react';

import { useQuery } from '@apollo/client';
import { getApiBaseUrl, isNativePlatform, subscribeApiBaseUrl } from '@ci/common';

import { gql } from '@/graphql';

import {
  isApplianceOutage,
  isProfileUnanswered,
  MEMORY_ANSWER_DEADLINE_MS,
  recallUser,
  rememberUser,
} from './rememberedUser';
import { useAuth } from './useAuth';

/** How often the profile is asked for again while Memory is not answering. */
const UNANSWERED_RETRY_MS = 5000;

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
    // A Memory that takes the request and never answers fails nothing; the deadline
    // (requestTimeoutLink.ts) turns that into the network error `unreachable` reads.
    context: { timeoutMs: MEMORY_ANSWER_DEADLINE_MS },
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

  // Signed in, but Memory did not answer `me`: that says nothing about who is signed in, so
  // ProtectedRoute must not read it as signed out. Ask again until it answers.
  const unreachable = !skip && !me && remembered == null && isProfileUnanswered(error);

  useEffect(() => {
    if (!unreachable) {
      return;
    }

    const timer = setInterval(() => {
      refetch().catch(() => undefined);
    }, UNANSWERED_RETRY_MS);

    return () => clearInterval(timer);
  }, [unreachable, refetch]);

  return {
    user: me ?? remembered,
    /** True when `user` is the profile kept from an earlier session because the appliance did not answer. */
    remembered: remembered != null,
    /** True when there is a session but Memory did not answer for its profile (and nothing kept stands in). */
    unreachable,
    loading: loading || (authenticated && !skip && data == null && !error),
    error,
    refetch,
  };
}
