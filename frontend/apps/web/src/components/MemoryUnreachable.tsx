import { isNativePlatform } from '@ci/common';
import { Button, Card } from '@ci/shadcn';
import { Link, useLocation } from 'react-router-dom';

/**
 * Set on the way to Log In from this card. While Memory still does not answer, the sign-in
 * page shows its form instead of this card again, so an outage that never clears (a 5xx that
 * stays) does not leave the person with nothing to do but wait.
 */
export interface PastOutageState {
  pastOutage?: boolean;
  from?: string;
}

export function isPastOutage(state: unknown): boolean {
  return (state as PastOutageState | null)?.pastOutage === true;
}

/**
 * Where the card's link goes. Log In and Sign up open their own form (an invite's `?code=`
 * kept). The splash goes to Log In. A page inside the app goes to Log In and comes back to
 * it after signing in.
 */
function wayIn(
  pathname: string,
  search: string,
  from: string | undefined,
): { to: string; label: string; state: PastOutageState; replace?: boolean } {
  const keepFrom = from ? { from } : {};

  if (pathname === '/login' || pathname === '/signup') {
    // The same page with its form: replace, so Back does not land on this card again.
    return {
      to: pathname + search,
      label: pathname === '/signup' ? 'Sign up' : 'Log In',
      state: { pastOutage: true, ...keepFrom },
      replace: true,
    };
  }

  if (pathname === '/') {
    return { to: '/login', label: 'Log In', state: { pastOutage: true } };
  }

  return {
    to: isNativePlatform() ? '/device-connect' : '/login',
    label: 'Log In',
    state: { pastOutage: true, from: pathname + search },
  };
}

/**
 * What a route shows while Memory does not answer, instead of a sign-in form that cannot
 * work. `signedIn` says whether the page knows there is a session, from a token or a profile.
 */
export function MemoryUnreachable({ onRetry, signedIn }: { onRetry: () => void; signedIn: boolean }) {
  const location = useLocation();
  const previous = location.state as PastOutageState | null;
  const way = wayIn(location.pathname, location.search, previous?.from);

  return (
    <div className="flex h-lvh w-full items-center justify-center p-6 md:p-10">
      <Card className="w-full max-w-md rounded-2xl border">
        <Card.Header>
          <Card.Title className="text-center">Can't reach Memory</Card.Title>
        </Card.Header>
        <Card.Content className="space-y-4 text-center">
          <p className="text-muted-foreground">
            {signedIn
              ? "You're still signed in. This page opens as soon as Memory answers again."
              : 'Memory is not answering. This page opens as soon as it answers again.'}
          </p>
          <div className="flex flex-col items-center gap-2">
            <Button variant="outline" onClick={onRetry}>
              Try again
            </Button>
            <Button asChild variant="link" size="sm">
              <Link to={way.to} state={way.state} replace={way.replace}>
                {way.label}
              </Link>
            </Button>
          </div>
        </Card.Content>
      </Card>
    </div>
  );
}
