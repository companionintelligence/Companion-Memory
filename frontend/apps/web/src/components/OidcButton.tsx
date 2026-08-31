import type { ComponentProps, MouseEvent } from 'react';

import { buildApiUrl, isNativePlatform, isTauriPlatform, OIDC_NATIVE_CLIENT_FLAG, openExternalUrl } from '@ci/common';
import { Button } from '@ci/shadcn';

const OIDC_URL_PATH = '/api/authenticate/oidc';

type ButtonVariant = ComponentProps<typeof Button>['variant'];

/**
 * "Sign in with CI Portal" button. On web it's a plain anchor: the browser navigates
 * to the API, which 302s to the identity provider. On native — Capacitor (iOS/Android)
 * or Tauri (desktop) — OAuth/OIDC must run in the SYSTEM browser (not the app's own
 * webview: an embedded browser is both a weaker trust boundary for the user's
 * credentials and, for the desktop shell specifically, unable to run a real OS-level
 * OAuth redirect at all), so the click opens it externally and adds `?client=native`
 * so the backend callback returns the result via the custom URL scheme
 * (`companion://oidc/callback`) — handled by the deep-link listener in useAuth —
 * instead of setting a browser session cookie.
 */
export function OidcButton({
  label,
  variant,
  redirect,
}: {
  label: string;
  variant?: ButtonVariant;
  redirect?: string;
}) {
  // Optional post-login destination (a safe same-origin path the server re-validates),
  // carried through the full-page OIDC round-trip so the user lands back where they were.
  const params = new URLSearchParams();

  if (redirect) {
    params.set('redirect', redirect);
  }

  // Web: same-origin path, anchor navigates normally (unchanged behavior).
  const webHref = buildApiUrl(`${OIDC_URL_PATH}${params.toString() ? `?${params.toString()}` : ''}`);

  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (isNativePlatform() || isTauriPlatform()) {
      event.preventDefault();
      const nativeParams = new URLSearchParams(params);
      nativeParams.set('client', OIDC_NATIVE_CLIENT_FLAG);
      void openExternalUrl(buildApiUrl(`${OIDC_URL_PATH}?${nativeParams.toString()}`));
    }
    // Web: let the anchor navigate normally.
  };

  return (
    <Button variant={variant} className="w-full" asChild>
      <a href={webHref} onClick={handleClick}>
        {label}
      </a>
    </Button>
  );
}
