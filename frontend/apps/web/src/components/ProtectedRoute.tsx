import { Suspense, useEffect, useRef, useState, type ReactNode } from 'react';

import { isNativePlatform, LoadingPage } from '@ci/common';
import { Button, Card } from '@ci/shadcn';
import { Navigate, useLocation } from 'react-router-dom';

import { useAuth, useCurrentUser } from '@/hooks';

export function ProtectedRoute({
  children,
  fallback = <LoadingPage />,
}: {
  children: ReactNode;
  /**
   * What shows while the page's own code downloads. Routes are lazy and the
   * router runs without transitions (see App.tsx), so a first visit always
   * shows this. The Memory hub passes the section's skeleton, so a tab does
   * not flash a spinner under its strip first (MemoryHubRoute).
   */
  fallback?: ReactNode;
}) {
  const location = useLocation();
  const [{ expired, loading: authLoading, authToken, unreachable: sessionUnreachable }, { refresh }] = useAuth();
  const { user, loading: userLoading, unreachable: profileUnreachable, refetch } = useCurrentUser();
  const [triedRecover, setTriedRecover] = useState(false);
  // Once the signed-in app has been shown, a later `me` refetch must not swap
  // this route for the loader or the login redirect. That unmounts onboarding
  // and the welcome typing starts over when the profile comes back.
  const shown = useRef(false);
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

  const recovering = expired && canRecover && hadSession && !triedRecover;
  const blocking = (authLoading || userLoading) && !user;

  if (!blocking && !recovering && user && !expired) {
    shown.current = true;
  }

  if (!shown.current && (blocking || recovering)) {
    return <LoadingPage />;
  }

  // Memory did not answer for the session or the profile. That is an outage, not a
  // sign-out: say so, and let the retries in useAuth and useCurrentUser bring the page
  // back, instead of sending a signed-in person to Log In.
  if (!user && (sessionUnreachable || profileUnreachable)) {
    return (
      <MemoryUnreachable
        onRetry={() => {
          if (profileUnreachable) {
            void refetch?.();
          } else if (canRecover) {
            void refresh();
          }
        }}
      />
    );
  }

  // A phone session stays valid when `me` blips to empty (no JWT to expire).
  // Sending that through the signed-out redirect reloads onboarding.
  if ((expired || !user) && !(shown.current && !expired)) {
    return (
      <Navigate
        to={isNativePlatform() ? '/device-connect' : '/login'}
        state={{ from: location.pathname + location.search }}
        replace
      />
    );
  }

  return <Suspense fallback={fallback}>{children}</Suspense>;
}

function MemoryUnreachable({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex h-lvh w-full items-center justify-center p-6 md:p-10">
      <Card className="w-full max-w-md rounded-2xl border">
        <Card.Header>
          <Card.Title className="text-center">Can't reach Memory</Card.Title>
        </Card.Header>
        <Card.Content className="space-y-4 text-center">
          <p className="text-muted-foreground">
            You're still signed in. This page opens as soon as Memory answers again.
          </p>
          <Button variant="outline" onClick={onRetry}>
            Try again
          </Button>
        </Card.Content>
      </Card>
    </div>
  );
}
