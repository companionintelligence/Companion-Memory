import { useEffect, useState } from 'react';

import { fetchJson, isNativePlatform, LoadingPage } from '@ci/common';
import { Navigate } from 'react-router-dom';

import { useFeatures } from '@/common/feature';
import { useAuth, useCurrentUser } from '@/hooks';
import { appHomePath } from '@/lib/appHome';

function emailsEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  return Boolean(a && b && a.trim().toLowerCase() === b.trim().toLowerCase());
}

/** What `GET /api/authenticate/hub-identity` says about the Hub person behind this request. */
export interface HubIdentity {
  username: string | null;
  /** The Memory account the Hub person signs in as, when the Hub sends a stable id. */
  accountId: string | null;
}

/**
 * Whether Traefik named a Hub person other than the signed-in `user`.
 *
 * By account when the server could say which one the Hub person signs in as. Their address
 * may have changed on the Hub or here since they were linked, and proves nothing either way.
 * By address otherwise, which is all a Hub without stable ids gives to go on.
 */
export function hubNamesSomeoneElse(user: { id: string; email: string }, hub: HubIdentity): boolean {
  if (!hub.username) {
    return false;
  }

  if (hub.accountId) {
    return hub.accountId !== user.id;
  }

  return !emailsEqual(user.email, hub.username);
}

const NO_HUB_IDENTITY: HubIdentity = { username: null, accountId: null };

export function RedirectKnownUser({ children }: { children: React.ReactNode }) {
  // `initializing`, not `loading`: the latter is also true while a login or
  // signup POST is in flight, and swapping in LoadingPage then unmounts the
  // very form awaiting the response — wiping the user's input and the local
  // state needed to attach the server's field errors.
  const [{ expired, authToken, authenticated, initializing }] = useAuth();
  const { user, loading: userLoading } = useCurrentUser();
  const { loading: featuresLoading } = useFeatures();
  const [hubIdentity, setHubIdentity] = useState<HubIdentity | undefined>(undefined);

  useEffect(() => {
    if (isNativePlatform()) {
      setHubIdentity(NO_HUB_IDENTITY);

      return;
    }

    let cancelled = false;

    void fetchJson<Partial<HubIdentity>>('/api/authenticate/hub-identity', {
      credentials: 'include',
    })
      .then((body) => {
        if (!cancelled) {
          setHubIdentity({ username: body?.username ?? null, accountId: body?.accountId ?? null });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setHubIdentity(NO_HUB_IDENTITY);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  if (initializing || userLoading || hubIdentity === undefined || (user?.onboarded && featuresLoading)) {
    return <LoadingPage />;
  }

  if (expired && !authenticated) {
    return children;
  }

  // A valid token with no resolved user means the profile query failed or the
  // account no longer exists — do not spin forever (see ProtectedRoute).
  if ((authToken || authenticated) && !user) {
    return <Navigate to={isNativePlatform() ? '/device-connect' : '/login'} replace />;
  }

  // Traefik already named a different Hub person. Do not send them to the
  // previous Memory home / onboarding — wait for the session bridge to replace
  // the cookie, or fall through to the login children if it cannot.
  if (user && hubNamesSomeoneElse(user, hubIdentity)) {
    return children;
  }

  if (user) {
    if (user.onboarded) {
      return <Navigate to={appHomePath()} />;
    }

    return <Navigate to="/onboarding" />;
  }

  return children;
}
