import { LoadingPage } from '@ci/common';
import { Navigate } from 'react-router-dom';

import { useAuth } from '../hooks';

export function RedirectKnownUser({ children }: { children: React.ReactNode }) {
  const [{ expired, user, loading }] = useAuth();

  if (expired) {
    return children;
  }

  if (loading) {
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
