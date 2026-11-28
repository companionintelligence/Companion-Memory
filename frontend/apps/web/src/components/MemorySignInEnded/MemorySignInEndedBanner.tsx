import { isNativePlatform } from '@ci/common';
import { Button } from '@ci/shadcn';
import { KeyRound } from '@ci/shadcn/icons';
import { useNavigate } from 'react-router-dom';

import { useAuth } from '@/hooks/useAuth';

export const MEMORY_SIGN_IN_ENDED_NOTICE =
  'Memory no longer accepts this device’s sign-in, so nothing reaches it. Sign in again: anything waiting to upload is kept and goes up once you have.';

/**
 * One row above every page once Memory has confirmed it no longer takes this device's key
 * (`signInEnded` from `useAuth`, set by `@ci/common`'s request layer after asking Memory).
 *
 * Before it, the app carried on with a dead key: every page failed on its own terms, and through a
 * Hub the failure read as "invalid JSON", because the Hub turned each request away to its own
 * sign-in page. Signing out to recover deleted the queued captures, so the way back offered here is
 * signing in again, which keeps them (the outbox re-stamps an account's rows onto its new key).
 *
 * On the phone it opens device connect, which stays open while this is shown. On the desktop it
 * signs the window out first: the window's own sign-in page is where a new key comes from there,
 * and it has no capture queue to lose.
 */
export function MemorySignInEndedBanner() {
  const [{ signInEnded }, { logout }] = useAuth();
  const navigate = useNavigate();

  if (!signInEnded) {
    return null;
  }

  const signInAgain = () => {
    if (isNativePlatform()) {
      navigate('/device-connect');
    } else {
      void logout();
    }
  };

  return (
    <div
      data-testid="memory-sign-in-ended-notice"
      className="flex shrink-0 items-center gap-2 border-b border-border bg-card px-3 py-1.5 text-sm text-foreground"
    >
      <KeyRound className="h-4 w-4 shrink-0 text-muted-foreground" strokeWidth={1.5} aria-hidden />
      <p role="status" className="min-w-0 flex-1">
        {MEMORY_SIGN_IN_ENDED_NOTICE}
      </p>
      <Button type="button" size="sm" variant="outline" onClick={signInAgain}>
        Sign in again
      </Button>
    </div>
  );
}
