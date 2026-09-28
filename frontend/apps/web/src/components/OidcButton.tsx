import type { ComponentProps, MouseEvent } from 'react';
import { useState } from 'react';

import {
  AuthSessionCancelledError,
  buildApiUrl,
  isIosPlatform,
  isNativePlatform,
  isTauriPlatform,
  OIDC_NATIVE_CLIENT_FLAG,
  openAuthSession,
  openExternalUrl,
} from '@ci/common';
import { Button } from '@ci/shadcn';

const OIDC_URL_PATH = '/api/authenticate/oidc';

type ButtonVariant = ComponentProps<typeof Button>['variant'];

/**
 * "Sign in with CI Portal" button. On web it's a plain anchor: the browser navigates
 * to the API, which 302s to the identity provider. On native — Capacitor (iOS/Android)
 * or Tauri (desktop) — OAuth/OIDC must not run in the app's own webview. iOS presents
 * an in-app Safari authentication sheet (`ASWebAuthenticationSession`) so App Review
 * does not see a jump to Safari, and the sheet hands `companion://` back to the app.
 * Android and desktop still open the system browser. The click adds `?client=native`
 * so the backend callback returns the result via the custom URL scheme
 * (`companion://oidc/callback`) — handled by the deep-link listener in useAuth —
 * instead of setting a browser session cookie.
 */
export function OidcButton({
  label,
  variant,
  redirect,
  signupCode,
}: {
  label: string;
  variant?: ButtonVariant;
  redirect?: string;
  /**
   * An invitation to an appliance that already has an owner. The backend
   * stashes it in a cookie on the initiate hop and burns it on the callback
   * (OidcController), so it rides the same round-trip as the sign-in itself —
   * there is no second request in which to present it.
   */
  signupCode?: string;
}) {
  // A rejected open is the difference between "signing you in" and nothing at
  // all, so it has to be visible. This was console.error only, which on the
  // desktop app means invisible: the button looked dead and gave the user
  // nothing to act on.
  const [openError, setOpenError] = useState<string | null>(null);

  // Optional post-login destination (a safe same-origin path the server re-validates),
  // carried through the full-page OIDC round-trip so the user lands back where they were.
  const params = new URLSearchParams();

  if (redirect) {
    params.set('redirect', redirect);
  }

  if (signupCode?.trim()) {
    params.set('signup_code', signupCode.trim());
  }

  // Web: same-origin path, anchor navigates normally (unchanged behavior).
  const webHref = buildApiUrl(`${OIDC_URL_PATH}${params.toString() ? `?${params.toString()}` : ''}`);

  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (isNativePlatform() || isTauriPlatform()) {
      event.preventDefault();
      const nativeParams = new URLSearchParams(params);
      nativeParams.set('client', OIDC_NATIVE_CLIENT_FLAG);
      const oidcPath = `${OIDC_URL_PATH}?${nativeParams.toString()}`;
      // Capacitor's native bootstrap calls setApiBaseUrl() before the app makes any
      // request, so buildApiUrl() is already absolute there. Tauri desktop never
      // calls setApiBaseUrl (nothing does on desktop boot), so buildApiUrl() would
      // hand the Rust opener a bare relative path — which open_external_url_command
      // rejects outright since it only accepts http(s) URLs. Resolve against the
      // page's own origin instead, which is always absolute once the bootstrap page
      // has navigated to http://127.0.0.1:8642.
      const oidcUrl = isTauriPlatform() ? `${window.location.origin}${oidcPath}` : buildApiUrl(oidcPath);

      setOpenError(null);
      const open = isIosPlatform() ? openAuthSession(oidcUrl) : openExternalUrl(oidcUrl);

      open.catch((err: unknown) => {
        // Dismissing the iOS sheet is a choice, not a broken button.
        if (err instanceof AuthSessionCancelledError) {
          return;
        }

        // A rejected native/Tauri open call (bad URL, ACL denial, no default
        // browser, ...) must not look like a successful click.
        console.error('Failed to open the Companion sign-in page', err);
        setOpenError('Could not open your browser to sign in. Use email and password instead.');
      });
    }
    // Web: let the anchor navigate normally.
  };

  return (
    <>
      <Button variant={variant} className="w-full" asChild>
        <a href={webHref} onClick={handleClick}>
          {label}
        </a>
      </Button>
      {/* `role="alert"` so the failure is announced: focus stays on the link
          after the click, and a paragraph appearing below it is otherwise
          silent — which is the same dead button, for a screen-reader user.
          Matches the inline-error shape used elsewhere (DeviceConnectPage,
          TaskSlate); `<Alert>` is this app's page-level banner, not this. */}
      {openError && (
        <p role="alert" className="mt-2 text-sm text-destructive">
          {openError}
        </p>
      )}
    </>
  );
}
