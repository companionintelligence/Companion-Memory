import { useState } from 'react';

import { Button, Input } from '@ci/shadcn';
import { Link } from 'react-router-dom';

import { OidcButton } from '@/components/OidcButton';
import { QrCode } from '@/components/QrCode';
import { useAuth } from '@/hooks';
import { BrainMark, Reveal, SplashShell } from '@/pages/SplashPage/SplashChrome';

/**
 * What the browser round-trip came back with, in words. `useAuth` turns the
 * deep link's `error=` into an Error whose message is the raw code; every one
 * of them used to end here unread, so a rejected sign-in looked exactly like a
 * button that had done nothing — the browser opened, the user came back, and
 * the screen had not changed.
 */
function describeSignInError(error: unknown): { message: string; needsInvitation: boolean } {
  const code = error instanceof Error ? error.message : '';

  if (code === 'signup_code_required') {
    return {
      message: 'This Memory already belongs to someone. Ask its owner for an invitation and enter it below.',
      needsInvitation: true,
    };
  }

  return { message: 'Sign in failed. Please try again.', needsInvitation: false };
}

/**
 * The desktop app's first screen.
 *
 * The marketing hero used to sit here, which is the wrong job for it: someone
 * who has already downloaded the app, waited for a stack to come up, and is
 * looking at their own appliance does not need to be sold on it — they need to
 * get in. So this is a sign-in screen, and the pitch stays on the web splash
 * where a visitor who has not decided yet can still see it.
 *
 * Sign-in opens the SYSTEM browser rather than this webview. That is not a
 * detail: an embedded webview is a weaker trust boundary for someone's
 * credentials, it cannot reuse the Portal session they are probably already
 * signed into, and the desktop shell cannot run a real OS-level OAuth redirect
 * inside itself. The browser returns the result through the `companion://`
 * deep link, which useAuth already listens for.
 */
export function DesktopSignInPage() {
  const [{ error }] = useAuth();
  const [showPairing, setShowPairing] = useState(false);
  // An invitation travels inside the OIDC round-trip (see OidcButton's
  // signupCode), which is the only way a SECOND person can get into an
  // appliance through Portal sign-in: the callback has nowhere else to learn
  // they were invited. The field appears when the server asks for one, or when
  // the person already knows they have one.
  const [inviteCode, setInviteCode] = useState('');
  const [showInvite, setShowInvite] = useState(false);
  const signInError = error == null ? null : describeSignInError(error);
  const inviteVisible = showInvite || signInError?.needsInvitation === true;
  // The address this appliance is reachable at — the same origin the shell
  // redirected to once the stack was healthy.
  const applianceUrl = typeof window === 'undefined' ? '' : window.location.origin;

  return (
    <SplashShell>
      <div className="relative z-10 flex h-full flex-col items-center justify-center gap-8 overflow-y-auto px-8 pt-[max(2rem,env(safe-area-inset-top))] pb-[max(2rem,env(safe-area-inset-bottom))]">
        <Reveal delay={0} className="flex shrink-0 flex-col items-center">
          <BrainMark />
          <p className="-mt-4 text-sm font-semibold tracking-[0.2em] text-muted-foreground uppercase md:-mt-10">
            Companion Memory
          </p>
        </Reveal>

        <Reveal delay={120} className="flex w-full max-w-sm flex-col items-center gap-4">
          <h1 className="text-center text-2xl font-bold tracking-tight">Sign in to your memory</h1>

          {signInError && (
            <p role="alert" className="text-center text-sm text-destructive">
              {signInError.message}
            </p>
          )}

          {inviteVisible && (
            <label className="flex w-full flex-col gap-1 text-sm">
              <span className="text-muted-foreground">Invitation</span>
              <Input
                value={inviteCode}
                onChange={(event) => setInviteCode(event.target.value)}
                autoComplete="off"
                spellCheck={false}
                placeholder="Paste the invitation from this Memory's owner"
              />
            </label>
          )}

          <div className="flex w-full flex-col gap-2">
            <OidcButton label="Sign in with Companion account" signupCode={inviteCode} />
            <p className="text-center text-xs text-muted-foreground">Opens your browser to sign in.</p>
          </div>

          <div className="flex w-full flex-col items-center gap-1">
            <Button asChild variant="link" className="text-muted-foreground">
              <Link to="/login">Use email and password instead</Link>
            </Button>

            {!inviteVisible && (
              <Button variant="link" className="text-muted-foreground" onClick={() => setShowInvite(true)}>
                I have an invitation
              </Button>
            )}

            {/* Pairing, not sign-in. The code carries this appliance's address so a
                phone can reach it; it cannot sign this machine in, because the
                OAuth result comes back through a deep link to THIS device. A
                scan-to-sign-in-here flow would need device authorization on the
                server, which does not exist yet. */}
            <Button
              variant="link"
              className="text-muted-foreground"
              onClick={() => setShowPairing((shown) => !shown)}
            >
              {showPairing ? 'Hide phone setup' : 'Set up your phone'}
            </Button>
          </div>

          {showPairing && (
            <QrCode
              value={applianceUrl}
              fallback={applianceUrl}
              caption="Scan in the Companion Memory app on your phone to connect it to this Memory."
              mark
            />
          )}
        </Reveal>
      </div>
    </SplashShell>
  );
}
