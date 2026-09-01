import { Suspense, useEffect, useState } from 'react';

import { isNativePlatform, LoadingPage } from '@ci/common';
import { Navigate, useLocation } from 'react-router-dom';

import { useAuth, useCurrentUser } from '@/hooks';

export function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const [{ expired, loading: authLoading }, { refresh }] = useAuth();
  const { user, loading: userLoading } = useCurrentUser();
  const [triedRecover, setTriedRecover] = useState(false);
  const canRecover = typeof refresh === 'function';

  useEffect(() => {
    if (!expired) {
      setTriedRecover(false);
    }
  }, [expired]);

  useEffect(() => {
    if (authLoading || userLoading || !expired || !canRecover || triedRecover) {
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
  }, [expired, canRecover, triedRecover, refresh, authLoading, userLoading]);

  if (authLoading || userLoading || (expired && canRecover && !triedRecover)) {
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
