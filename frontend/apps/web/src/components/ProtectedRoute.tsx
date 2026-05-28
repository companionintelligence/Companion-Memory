import { LoadingPage } from '@ci/common';
import { Navigate, useLocation } from 'react-router-dom';

import { useAuth, useCurrentUser } from '@/hooks';

export function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const location = useLocation();
  const [{ expired, authToken, loading: authLoading }] = useAuth();
  const { user, loading: userLoading } = useCurrentUser();

  if (authLoading || userLoading) {
    return <LoadingPage />;
  }

  if (authToken && !expired && !user) {
    return <LoadingPage />;
  }

  if (expired || !user) {
    return <Navigate to="/login" state={{ from: location.pathname + location.search }} replace />;
  }

  return children;
}
