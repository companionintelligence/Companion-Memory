import { LoadingPage } from '@ci/common';
import { Navigate } from 'react-router-dom';

import { useAuth, useCurrentUser } from '@/hooks';

export function RedirectKnownUser({ children }: { children: React.ReactNode }) {
  const [{ expired, authToken, loading: authLoading }] = useAuth();
  const { user, loading: userLoading } = useCurrentUser();

  if (authLoading || userLoading) {
    return <LoadingPage />;
  }

  if (expired) {
    return children;
  }

  if (authToken && !user) {
    return <LoadingPage />;
  }

  if (user) {
    if (user.onboarded) {
      return <Navigate to="/feed" />;
    }

    return <Navigate to="/onboarding" />;
  }

  return children;
}
