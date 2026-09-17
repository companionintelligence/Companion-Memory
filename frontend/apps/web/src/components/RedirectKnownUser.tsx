import { useEffect, useState } from 'react';

import { fetchJson, isNativePlatform, LoadingPage } from '@ci/common';
import { Navigate } from 'react-router-dom';

import { useFeatures } from '@/common/feature';
import { useAuth, useCurrentUser } from '@/hooks';
import { appHomePath } from '@/lib/appHome';

function emailsEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  return Boolean(a && b && a.trim().toLowerCase() === b.trim().toLowerCase());
}

export function RedirectKnownUser({ children }: { children: React.ReactNode }) {
  // `initializing`, not `loading`: the latter is also true while a login or
  // signup POST is in flight, and swapping in LoadingPage then unmounts the
  // very form awaiting the response — wiping the user's input and the local
  // state needed to attach the server's field errors.
  const [{ expired, authToken, authenticated, initializing }] = useAuth();
  const { user, loading: userLoading } = useCurrentUser();
  const { loading: featuresLoading } = useFeatures();
  const [hubUsername, setHubUsername] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    if (isNativePlatform()) {
      setHubUsername(null);

      return;
    }

    let cancelled = false;

    void fetchJson<{ username: string | null }>('/api/authenticate/hub-identity', {
      credentials: 'include',
    })
      .then((body) => {
        if (!cancelled) {
          setHubUsername(body?.username ?? null);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setHubUsername(null);
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  if (initializing || userLoading || hubUsername === undefined || (user?.onboarded && featuresLoading)) {
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
  if (user && hubUsername && !emailsEqual(user.email, hubUsername)) {
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
