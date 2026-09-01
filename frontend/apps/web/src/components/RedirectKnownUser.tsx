import { isNativePlatform, LoadingPage } from '@ci/common';
import { Navigate } from 'react-router-dom';

import { useFeatures } from '@/common/feature';
import { useAuth, useCurrentUser } from '@/hooks';
import { appHomePath } from '@/lib/appHome';

export function RedirectKnownUser({ children }: { children: React.ReactNode }) {
  // `initializing`, not `loading`: the latter is also true while a login or
  // signup POST is in flight, and swapping in LoadingPage then unmounts the
  // very form awaiting the response — wiping the user's input and the local
  // state needed to attach the server's field errors.
  const [{ expired, authToken, authenticated, initializing }] = useAuth();
  const { user, loading: userLoading } = useCurrentUser();
  const { loading: featuresLoading } = useFeatures();

  if (initializing || userLoading || (user?.onboarded && featuresLoading)) {
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

  if (user) {
    if (user.onboarded) {
      return <Navigate to={appHomePath()} />;
    }

    return <Navigate to="/onboarding" />;
  }

  return children;
}
