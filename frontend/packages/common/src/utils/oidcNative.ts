/**
 * Shared constants and pure helpers for the native "Sign in with CI Portal" deep-link
 * return path. Kept Capacitor-free (no `@capacitor/*` import) so the web bundle is
 * unaffected — the actual `appUrlOpen` subscription lives in `nativeBridge.ts`.
 *
 * Flow recap (native only):
 *   1. `OidcButton` opens `/api/authenticate/oidc?client=native` in the SYSTEM browser.
 *   2. The IdP redirects back to CI-Server's `/oidc/callback`, which — for a native
 *      client — 302-redirects to `companion://oidc/callback?code=<one-time-code>`.
 *   3. iOS/Android hand that URL to the app; `@capacitor/app` fires `appUrlOpen`.
 *   4. The app parses the URL here, then exchanges the short-lived one-time code for a
 *      real JWT at an authenticated endpoint, and mints/stores an API key (same as the
 *      password path). No long-lived secret is ever placed in the URL.
 */

/** Custom URL scheme registered in the native projects (iOS Info.plist / Android intent-filter). */
export const OIDC_NATIVE_SCHEME = 'companion';

/** Full deep-link the backend redirects to on native sign-in success. */
export const OIDC_NATIVE_CALLBACK_URL = `${OIDC_NATIVE_SCHEME}://oidc/callback`;

/**
 * Query flag appended by `OidcButton` when launching on native, so the backend callback
 * knows to return via the custom scheme instead of setting a browser session cookie.
 */
export const OIDC_NATIVE_CLIENT_FLAG = 'native';

/** Result of parsing an incoming `appUrlOpen` deep link for the OIDC callback. */
export interface OidcCallbackParams {
  /** Short-lived one-time code to exchange for a JWT. Present on success. */
  code?: string;
  /** Error code propagated from the backend/IdP. Present on failure. */
  error?: string;
}

/**
 * Parse a deep-link URL and, if it is our OIDC callback
 * (`companion://oidc/callback?...`), return its `code`/`error` params. Returns `null`
 * for any URL that is not our callback (other schemes, other hosts/paths, garbage), so
 * callers can safely ignore unrelated `appUrlOpen` events.
 *
 * Pure and dependency-free → unit-testable without a device.
 */
export function parseOidcCallbackUrl(url: string): OidcCallbackParams | null {
  let parsed: URL;

  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  // `new URL('companion://oidc/callback')` puts `oidc` in `host` and `/callback` in
  // `pathname`. Match defensively so a trailing slash or empty path still resolves.
  const isOurScheme = parsed.protocol === `${OIDC_NATIVE_SCHEME}:`;
  const path = `${parsed.host}${parsed.pathname}`.replace(/\/+$/, '');

  if (!isOurScheme || path !== 'oidc/callback') {
    return null;
  }

  const code = parsed.searchParams.get('code') ?? undefined;
  const error = parsed.searchParams.get('error') ?? undefined;

  return { code, error };
}

const SEEN_NATIVE_CODES_KEY = 'ci.oidc.seenNativeCodes';

/**
 * Claim a Memory-login one-time code so iOS `getLaunchUrl` cannot redeem it
 * again after a remount. Capacitor keeps the last deep link for the process;
 * the code is single-use on the appliance, so a replay is always
 * "Invalid or expired code". Returns false if this code was already claimed.
 */
export function claimNativeOidcCode(code: string): boolean {
  if (!code) {
    return false;
  }

  try {
    const raw = sessionStorage.getItem(SEEN_NATIVE_CODES_KEY);
    const prev: unknown = raw ? JSON.parse(raw) : [];
    const seen = Array.isArray(prev) ? prev.filter((item): item is string => typeof item === 'string') : [];

    if (seen.includes(code)) {
      return false;
    }

    seen.push(code);
    sessionStorage.setItem(SEEN_NATIVE_CODES_KEY, JSON.stringify(seen.slice(-16)));

    return true;
  } catch {
    return true;
  }
}
