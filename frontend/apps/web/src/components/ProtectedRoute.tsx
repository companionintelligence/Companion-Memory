import { LoadingPage } from '@ci/common';
import { Navigate } from 'react-router-dom';

import { useAuth, useCurrentUser } from '@/hooks';

export function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const [{ expired, authToken, loading: authLoading }] = useAuth();
  const { user, loading: userLoading } = useCurrentUser();

  if (authLoading || userLoading) {
    return <LoadingPage />;
  }

  if (authToken && !expired && !user) {
    return <LoadingPage />;
  }

  if (expired || !user) {
    return <Navigate to="/login" />;
  }

  return children;
}
