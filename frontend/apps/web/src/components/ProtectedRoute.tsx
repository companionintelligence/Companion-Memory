import { Suspense, useEffect, useState } from 'react';

import { isNativePlatform, LoadingPage } from '@ci/common';
import { Navigate, useLocation } from 'react-router-dom';

import { useAuth, useCurrentUser } from '@/hooks';

export function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const [{ expired, loading: authLoading, authToken }, { refresh }] = useAuth();
  const { user, loading: userLoading } = useCurrentUser();
  const [triedRecover, setTriedRecover] = useState(false);
  const canRecover = typeof refresh === 'function';
  // A previously-seen access token means this browser HAD a session that then
  // aged out — worth one silent `refresh()` attempt. A plain visitor who never
  // authenticated (authToken always null) must not trigger it: a failed
  // refresh() writes the 401 into useAuth's `error`, which LoginPage renders as
  // a destructive alert, turning an ordinary "please sign in" into a spurious
  // failure message.
  const hadSession = authToken != null;

  useEffect(() => {
    if (!expired) {
      setTriedRecover(false);
    }
  }, [expired]);

  useEffect(() => {
    if (authLoading || userLoading || !expired || !canRecover || !hadSession || triedRecover) {
      return;
    }

    let cancelled = false;

    void refresh().finally(() => {
      if (!cancelled) {
        setTriedRecover(true);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [expired, canRecover, hadSession, triedRecover, refresh, authLoading, userLoading]);

  if (authLoading || userLoading || (expired && canRecover && hadSession && !triedRecover)) {
    return <LoadingPage />;
  }

  if (expired || !user) {
    return (
      <Navigate
        to={isNativePlatform() ? '/device-connect' : '/login'}
        state={{ from: location.pathname + location.search }}
        replace
      />
    );
  }

  return <Suspense fallback={<LoadingPage />}>{children}</Suspense>;
}
