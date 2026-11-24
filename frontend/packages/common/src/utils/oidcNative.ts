/**
 * Shared constants and pure helpers for the native "Sign in with CI Portal" deep-link
 * return path. Kept Capacitor-free (no `@capacitor/*` import) so the web bundle is
 * unaffected — the actual `appUrlOpen` subscription lives in `nativeBridge.ts`.
 *
 * Flow recap (native only):
 *   1. `OidcButton` makes a PKCE verifier and a state value ({@link beginNativeOidcSignIn}),
 *      keeps them here, and opens `/api/authenticate/oidc?client=native&code_challenge=…
 *      &app_state=…` in the SYSTEM browser.
 *   2. The IdP redirects back to CI-Server's `/oidc/callback`, which — for a native
 *      client — 302-redirects to `companion://oidc/callback?code=<one-time-code>&state=…`.
 *   3. iOS/Android hand that URL to the app; `@capacitor/app` fires `appUrlOpen`.
 *   4. The app parses the URL here and accepts it only if its state matches the sign-in
 *      it started ({@link takePendingNativeOidcSignIn}). It then exchanges the one-time
 *      code, together with the verifier, for a real JWT and mints/stores an API key (same
 *      as the password path). No long-lived secret is ever placed in the URL, and a code
 *      that reached anyone else is useless without the verifier.
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
  /** The state value this app sent when it started the sign-in, echoed back by the appliance. */
  state?: string;
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
  const state = parsed.searchParams.get('state') ?? undefined;

  return state === undefined ? { code, error } : { code, error, state };
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

const PENDING_NATIVE_SIGN_IN_KEY = 'ci.oidc.pendingNativeSignIn';

/** As long as the appliance keeps its half of the sign-in (its cookies live ten minutes). */
const PENDING_NATIVE_SIGN_IN_TTL_MS = 10 * 60 * 1000;

interface PendingNativeSignIn {
  state: string;
  verifier: string;
  startedAt: number;
}

function base64Url(bytes: Uint8Array): string {
  let binary = '';

  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomBase64Url(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);

  crypto.getRandomValues(bytes);

  return base64Url(bytes);
}

/**
 * Persisted in both stores, as the Portal device-connect flow does: sessionStorage survives the
 * warm return from the browser, localStorage the iOS cold start from Safari's "Open in Memory".
 */
function writePending(pending: PendingNativeSignIn | null): void {
  for (const store of [sessionStorage, localStorage]) {
    try {
      if (pending) {
        store.setItem(PENDING_NATIVE_SIGN_IN_KEY, JSON.stringify(pending));
      } else {
        store.removeItem(PENDING_NATIVE_SIGN_IN_KEY);
      }
    } catch {
      // Private mode or a full quota: the other store may still hold it.
    }
  }
}

function readPending(): PendingNativeSignIn | null {
  for (const store of [sessionStorage, localStorage]) {
    try {
      const raw = store.getItem(PENDING_NATIVE_SIGN_IN_KEY);
      const parsed: unknown = raw ? JSON.parse(raw) : null;

      if (
        parsed &&
        typeof parsed === 'object' &&
        typeof (parsed as PendingNativeSignIn).state === 'string' &&
        typeof (parsed as PendingNativeSignIn).verifier === 'string' &&
        typeof (parsed as PendingNativeSignIn).startedAt === 'number'
      ) {
        return parsed as PendingNativeSignIn;
      }
    } catch {
      // Unreadable: treat as absent.
    }
  }

  return null;
}

/**
 * Start a native sign-in: make a PKCE verifier and a state value, keep them, and return what goes
 * on `/api/authenticate/oidc?client=native`. The appliance stores the challenge with the one-time
 * code and refuses to redeem it without the verifier, and echoes the state on the deep link so
 * {@link takePendingNativeOidcSignIn} can drop any callback this app did not ask for. Starting
 * again replaces an earlier attempt.
 */
export async function beginNativeOidcSignIn(): Promise<{ codeChallenge: string; appState: string }> {
  const verifier = randomBase64Url(32);
  const state = randomBase64Url(24);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));

  writePending({ state, verifier, startedAt: Date.now() });

  return { codeChallenge: base64Url(new Uint8Array(digest)), appState: state };
}

/**
 * Whether this app has a sign-in in flight that has not expired. Lets the deep-link handler tell
 * an appliance from before the state echo (it answers this app's own sign-in with no `state`)
 * from a link nobody asked for, so it can say why the sign-in cannot finish instead of doing
 * nothing. It never makes such a result redeemable.
 */
export function hasPendingNativeOidcSignIn(now: number = Date.now()): boolean {
  const pending = readPending();

  return pending != null && now - pending.startedAt <= PENDING_NATIVE_SIGN_IN_TTL_MS;
}

/**
 * Whether a callback carrying `state` is the result of the sign-in this app started. Returns that
 * sign-in's verifier and forgets it, or null for a link the app never asked for (no state, another
 * state, nothing pending) and for one that arrives after the attempt expired.
 *
 * A mismatch leaves the pending sign-in alone: a stray link must not be able to cancel the one the
 * person is in the middle of.
 */
export function takePendingNativeOidcSignIn(
  state: string | undefined,
  now: number = Date.now(),
): { verifier: string } | null {
  const pending = readPending();

  if (!pending || !state) {
    return null;
  }

  if (now - pending.startedAt > PENDING_NATIVE_SIGN_IN_TTL_MS) {
    writePending(null);

    return null;
  }

  if (pending.state !== state) {
    return null;
  }

  writePending(null);

  return { verifier: pending.verifier };
}
