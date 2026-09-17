import { useEffect, useRef, type ReactNode } from 'react';

import { Button } from '@ci/shadcn';
import { RotateCw } from '@ci/shadcn/icons';
import { ErrorBoundary } from '@sentry/react';
import { useLocation } from 'react-router-dom';

import { ErrorState } from '@/components/ErrorState';

interface CrashFallbackProps {
  resetError: () => void;
}

/**
 * What the user sees instead of a blank document.
 *
 * Sentry renders `fallback` through `createElement`, so this is a real
 * component and hooks are legal here.
 */
function CrashFallback({ resetError }: CrashFallbackProps) {
  const { pathname } = useLocation();
  // The route the crash happened on. The nav, rail and toaster stay mounted
  // behind this screen, so a user who clicks away has to get a working page
  // back — without this the boundary would hold the error screen up over the
  // route they just navigated to and every link would look dead.
  const crashedAt = useRef(pathname);

  useEffect(() => {
    if (pathname !== crashedAt.current) {
      resetError();
    }
  }, [pathname, resetError]);

  return (
    <ErrorState
      title="This page stopped working"
      description="Something went wrong while displaying this page. Nothing on your appliance was lost — reload, or pick another page from the menu."
      className="h-full"
    >
      <Button variant="outline" size="sm" onClick={() => window.location.reload()}>
        <RotateCw className="h-4 w-4" />
        Reload
      </Button>
    </ErrorState>
  );
}

/**
 * Sentry's capture is a no-op unless a client was initialised, and telemetry is
 * opt-out — most appliances run with no DSN at all. Log as well, so a crash is
 * still visible in the owner's devtools. Mirrors ViewCrashBoundary.
 */
function handleError(error: unknown, componentStack: string): void {
  console.error('AppErrorBoundary', error, componentStack);
}

interface AppErrorBoundaryProps {
  children: ReactNode;
}

/**
 * App-shell crash boundary — the one thing standing between a render throw on
 * any page and a white screen.
 *
 * Wraps the routed outlet only, never the chrome: when a page throws, the
 * navigation, the rail and the toaster stay mounted and the user can walk out
 * of it. `ViewCrashBoundary` still guards the Memory views individually, so a
 * crash there is contained to the view rather than taking the whole page.
 *
 * Safe with reporting disabled: `Sentry.ErrorBoundary` only calls `getClient()`
 * and `captureException`, both of which no-op without an initialised client
 * (see `lib/telemetry.ts` — the DSN is optional and consent is checked at
 * runtime). Nothing here depends on telemetry being on.
 */
export function AppErrorBoundary({ children }: AppErrorBoundaryProps) {
  return (
    <ErrorBoundary fallback={CrashFallback} onError={handleError}>
      {children}
    </ErrorBoundary>
  );
}
