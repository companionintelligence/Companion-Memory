import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  addAppUrlOpenListener,
  clearOutboxAfterSignOut,
  clearPersistedApiBaseUrl,
  countUnsentBeforeSignOut,
  createHookContext,
  drainOutboxBeforeSignOut,
  fetchJson,
  FetchJsonError,
  getApiBaseUrl,
  getPersistedApiBaseUrl,
  persistApiBaseUrl,
  setApiBaseUrl,
  syncNativeIntentConfig,
  getApiKey,
  getLaunchUrl,
  isIosPlatform,
  isNativePlatform,
  isTauriPlatform,
  claimNativeOidcCode,
  hasPendingNativeOidcSignIn,
  parseOidcCallbackUrl,
  resetIngestFinishState,
  secureStorageGet,
  secureStorageRemove,
  secureStorageSet,
  setApiKey,
  takePendingNativeOidcSignIn,
} from '@ci/common';
import { jwtDecode } from 'jwt-decode';
import { useNavigate, useLocation } from 'react-router-dom';

import { disconnectAndClearPowerSyncForLogout } from '@/api/powersync/session';
import { registerNativePushToken } from '@/lib/registerNativePushToken';

const authChannel = new BroadcastChannel('auth');

// On native the durable credential is an API key kept in the OS keystore — the
// cookie/JWT session does not survive cross-origin inside a webview. We store the
// raw key (sent as x-api-key) and its server id (for reference/future revocation).
const API_KEY_STORAGE = 'ci.apiKey';
const API_KEY_ID_STORAGE = 'ci.apiKeyId';
// What the stored key was minted with. Absent on a key issued before the app
// started asking, which is exactly the signal `storedApiKeyCapability` reports.
const API_KEY_CAPABILITY_STORAGE = 'ci.apiKeyCapability';
// The paired Memory origin, mirrored into the keystore for native consumers.
const API_BASE_URL_STORAGE = 'ci.apiBaseUrl';

/** Forget this device's stored key, its id and its capability. */
async function removeStoredDeviceKey(): Promise<void> {
  await secureStorageRemove(API_KEY_STORAGE);
  await secureStorageRemove(API_KEY_ID_STORAGE);
  await secureStorageRemove(API_KEY_CAPABILITY_STORAGE);
}

/**
 * The authority this device asks for, and why it is the widest one.
 *
 * A phone key is the user acting on their own appliance, not a delegated agent:
 * the app issues sixteen of the schema's destructive mutations (deleteNote,
 * deleteEvent, deleteTask, deletePerson, deleteTag, ...), and `capabilityAllows`
 * refuses every one of them below `full`. Minting at the inherited
 * DEFAULT_API_KEY_CAPABILITY of `write` meant the app worked only because the
 * GraphQL plane asks about capability nowhere — the gap CI-Server#1780 is about.
 * Closing that gap without this change would break deletes on every phone.
 *
 * Stated explicitly rather than inherited, for the reason ConnectService pins
 * its own literals: a default nobody chose should not decide what a device may
 * do, and should not move under it if the default changes.
 *
 * The cost is real and was accepted deliberately: these keys carry NO scopes, so
 * scope enforcement is skipped for them entirely and `full` is full authority
 * across the whole API — including the destructive intents and
 * `POST /maintenance/ingest/reset`. Narrowing that needs the GraphQL plane to
 * carry a scope so the key can be confined to it; until then the surface is the
 * whole API either way, and only the verb tier changes here.
 */
const NATIVE_KEY_CAPABILITY = 'full';

const CSRF_COOKIE_NAME = 'csrfToken';

/** Shown when the appliance is too old to bind a native sign-in to this app (see handleUrl). */
const SERVER_UPDATE_REQUIRED =
  'This Memory needs an update before the app can sign in with your Companion account. Sign in with your email and password instead.';

// Native clients run in a cross-origin webview and can neither read nor send the
// SameSite=Strict CSRF cookie, so they capture the token from the
// `/api/authenticate/csrf` response body and echo it as the header instead.
let nativeCsrfToken: string | null = null;

function getCsrfToken(): string | undefined {
  if (isNativePlatform()) {
    return nativeCsrfToken ?? undefined;
  }

  const match = document.cookie.split('; ').find((row) => row.startsWith(`${CSRF_COOKIE_NAME}=`));

  return match?.split('=').slice(1).join('=');
}

function withCsrfHeader(headers?: HeadersInit): HeadersInit {
  const token = getCsrfToken();

  if (!token) {
    return headers ?? {};
  }

  return {
    ...headers,
    'X-CSRF-Token': token,
  };
}

/**
 * Set (or re-validate) the csrf cookie. The endpoint reuses a valid existing
 * token and only mints when the cookie is absent/invalid, so calling this can
 * never invalidate another tab or an open server-rendered form.
 */
async function primeCsrfCookie(): Promise<boolean> {
  // Native is cookie-less: its cross-origin webview can neither read nor send the
  // SameSite cookie, so it captures the signed token from the response BODY and
  // echoes it as the header (see getCsrfToken). The request must also be
  // uncredentialed, or it becomes a credentialed cross-origin call and requires an
  // Access-Control-Allow-Credentials the appliance/proxy may not send. Doing this
  // here rather than at each call site means login, logout and refresh all inherit it.
  //
  // Go through fetchJson (CapacitorHttp on native). WKWebView `fetch` against the
  // Memory origin is CORS-bound and fails silently here, leaving login with no
  // header → "Missing CSRF token".
  const native = isNativePlatform();

  try {
    const body = await fetchJson<{ csrfToken?: string }>('/api/authenticate/csrf', {
      method: 'GET',
      credentials: native ? 'omit' : 'include',
      skipApiKey: true,
    });

    if (native) {
      nativeCsrfToken = body?.csrfToken ?? null;

      return Boolean(nativeCsrfToken);
    }

    return true;
  } catch {
    return false;
  }
}

/**
 * POST /authenticate/logout with the double-submit CSRF header.
 *
 * Logout is CsrfGuard-protected so a cross-site POST cannot force it, which
 * means a stale or dropped csrf cookie would 403 the request and skip the
 * server-side teardown (invalidateSession + cookie clears) — leaving a
 * logged-out UI in front of a live 7-day session that the next mount refresh
 * would silently resume. Mirror refreshSession: prime the cookie when it is
 * missing, and on a 403 re-prime and retry exactly once so a request carrying a
 * valid session always tears that session down. Priming cannot help a
 * cross-site attacker — the primed cookie is sameSite=strict and unreadable
 * cross-origin — so this does not reopen the forced-logout hole.
 */
async function postLogout(): Promise<void> {
  if (!getCsrfToken()) {
    await primeCsrfCookie();
  }

  const first = await fetch('/api/authenticate/logout', {
    method: 'POST',
    headers: withCsrfHeader(),
    credentials: 'include',
  });

  if (first.ok || first.status !== 403) {
    if (!first.ok) {
      console.error('Logout request failed with status:', first.status);
    }

    return;
  }

  // A 403 means the cookie was absent or invalid (the SPA always sends the
  // cookie value as the header, so the two never merely mismatch), so a
  // *successful* prime re-issues — and thereby replaces — it with a valid token.
  // Gate the retry on that success (primeCsrfCookie returns res.ok): a failed
  // prime leaves the same rejected cookie in place, so the retry would only earn
  // a second 403.
  if (!(await primeCsrfCookie())) {
    console.error('Logout request failed with status:', first.status);

    return;
  }

  const retry = await fetch('/api/authenticate/logout', {
    method: 'POST',
    headers: withCsrfHeader(),
    credentials: 'include',
  });

  if (!retry.ok) {
    console.error('Logout retry failed with status:', retry.status);
  }
}

/**
 * POST /authenticate/refresh with the double-submit CSRF header.
 *
 * Primes the csrf cookie first when it is missing (e.g. a cleared cookie with a
 * still-valid session), and on a 403 — a stale/invalid CSRF token, such as one
 * signed with a rotated server secret — re-primes and retries exactly once.
 * A 401 (invalid session) is never retried: that must fall through to login.
 */
/**
 * If Traefik named a Hub person who does not match the Memory cookie, the
 * server replaces the session. Call this before refresh so the SPA never
 * hydrates the previous person's token / PowerSync replica.
 */
async function alignHubSession(): Promise<(AuthResponse & { replaced?: boolean }) | undefined> {
  if (isNativePlatform()) {
    return undefined;
  }

  try {
    if (!getCsrfToken()) {
      await primeCsrfCookie();
    }

    return await fetchJson<AuthResponse & { replaced?: boolean }>('/api/authenticate/hub-bridge', {
      method: 'POST',
      headers: withCsrfHeader(),
      credentials: 'include',
    });
  } catch {
    return undefined;
  }
}

async function refreshSession(): Promise<AuthResponse | undefined> {
  if (!getCsrfToken()) {
    await primeCsrfCookie();
  }

  try {
    return await fetchJson<AuthResponse>('/api/authenticate/refresh', {
      method: 'POST',
      headers: withCsrfHeader(),
      credentials: 'include',
    });
  } catch (err: unknown) {
    if (!(err instanceof FetchJsonError) || err.status !== 403) {
      throw err;
    }

    // A 403 means the cookie was absent or invalid (the SPA always sends the
    // cookie value as the header, so the two never merely mismatch), so a
    // *successful* prime re-issues — and thereby replaces — it with a valid
    // token. Gate the retry on that success (primeCsrfCookie returns res.ok): a
    // failed prime leaves the same rejected cookie in place, so the retry would
    // only burn the one-shot budget on a certain second 403 and log the user out.
    if (!(await primeCsrfCookie())) {
      throw err;
    }

    return fetchJson<AuthResponse>('/api/authenticate/refresh', {
      method: 'POST',
      headers: withCsrfHeader(),
      credentials: 'include',
    });
  }
}

interface JwtPayload {
  sub: string;
  iat: number;
  exp: number;
}

interface AuthResponse {
  accessToken: string;
}

interface CreateApiKeyResponse {
  id: string;
  key: string;
}

// Keystore restore is async. Logout and a new device connect have to win if
// they finish while that read is still in flight, or the previous box's key
// comes back and the next `me` is Unauthorized.
let nativeCredentialEpoch = 0;

function bumpNativeCredentialEpoch(): void {
  nativeCredentialEpoch += 1;
}

// Exchange a freshly-issued JWT for a long-lived API key (the /api/keys endpoint is
// JWT-guarded, so this must run while we still hold the login JWT), persist it to the
// keystore, and activate it for subsequent requests. Returns the raw key, or null.
async function mintAndStoreApiKey(jwt: string, memoryOrigin?: string): Promise<string | null> {
  const origin = memoryOrigin || getApiBaseUrl();
  const keysUrl = /^https?:\/\//i.test(origin) ? `${origin.replace(/\/+$/, '')}/api/keys` : '/api/keys';
  const created = await fetchJson<CreateApiKeyResponse>(keysUrl, {
    method: 'POST',
    skipApiKey: true,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${jwt}`,
    },
    body: JSON.stringify({
      name: `Companion mobile · ${new Date().toISOString().slice(0, 10)}`,
      capability: NATIVE_KEY_CAPABILITY,
      // A signed-in device, not a key handed to a tool: a password change, "Sign out
      // everywhere" and this app's own sign-out revoke it.
      sign_in: true,
    }),
  });

  if (!created?.key) {
    return null;
  }

  await secureStorageSet(API_KEY_STORAGE, created.key);
  await secureStorageSet(API_KEY_ID_STORAGE, created.id);
  await secureStorageSet(API_KEY_CAPABILITY_STORAGE, NATIVE_KEY_CAPABILITY);
  setApiKey(created.key);

  return created.key;
}

/**
 * Decide what the keystore's copy of the Memory origin may do at launch. Resolves false when
 * the person declined it and the stored credential was dropped instead.
 *
 * The origin the app paired with lives in localStorage, which only the app's own pages can
 * write; `initApiBaseUrl` has already applied it. The keystore copy is a mirror for native
 * App Intents (`syncNativeIntentConfig`), and the LocalHub plugin writes it for any caller
 * that reaches the bridge. On Android's legacy bridge that includes a cross-origin iframe,
 * and an origin planted there would, on the next launch, be where the device API key went.
 *
 * So the keystore never replaces a paired origin: a copy that disagrees is overwritten from
 * localStorage. It only fills in an origin the app does not have (localStorage lost while
 * the Keychain survived, as across an iOS reinstall), and only after the person agrees.
 */
async function adoptKeystoreOrigin(storedOrigin: string | null): Promise<boolean> {
  const pairedOrigin = getPersistedApiBaseUrl();
  const stored = storedOrigin?.replace(/\/+$/, '') || null;

  if (pairedOrigin) {
    if (stored !== pairedOrigin) {
      await syncNativeIntentConfig();
    }

    return true;
  }

  if (!stored) {
    return true;
  }

  // An origin with no key is what a sign-out cut short leaves (the key goes first). There is
  // nothing to sign back in with, and a saved origin makes iOS skip the device picker, so
  // the next sign-in would go to this box. Finish the sign-out instead of asking.
  if (!(await secureStorageGet(API_KEY_STORAGE))) {
    await secureStorageRemove(API_BASE_URL_STORAGE);

    return true;
  }

  // Pairing only ever stores an http(s) address. Anything else (another scheme, or text with
  // line breaks written to read as part of the question) came from somewhere else, so it is
  // dropped like a declined one rather than shown in the prompt.
  if (isHttpAddress(stored) && window.confirm(`Sign back in to your Memory at ${stored}?`)) {
    persistApiBaseUrl(stored);

    return true;
  }

  // Declined: drop the credential that came with it, so the app starts at device connect
  // instead of quietly reusing a key for a server the person did not recognise.
  await secureStorageRemove(API_BASE_URL_STORAGE);
  await removeStoredDeviceKey();

  return false;
}

/** An http(s) URL with no whitespace anywhere in it. */
function isHttpAddress(value: string): boolean {
  if (/\s/.test(value)) {
    return false;
  }

  try {
    const { protocol } = new URL(value);

    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/** This device's stored key, or null when there is none or the store cannot be read. */
async function storedDeviceKey(): Promise<string | null> {
  try {
    return await secureStorageGet(API_KEY_STORAGE);
  } catch {
    return null;
  }
}

/**
 * Give this device's key up on the server: how the phone and desktop apps sign out. Best
 * effort and bounded, because signing out must finish whether or not the appliance answers;
 * a key that could not be revoked here is still listed under Settings > API keys.
 */
async function revokeDeviceKey(key: string): Promise<void> {
  try {
    await fetchJson('/api/keys/current', {
      method: 'DELETE',
      skipApiKey: true,
      headers: { 'x-api-key': key },
      timeout: 5_000,
    });
  } catch (error) {
    console.warn('Could not revoke this device key on the server', error);
  }
}

interface OidcNativeExchangeResponse {
  accessToken: string;
}

// Native OIDC return path: exchange the short-lived one-time code carried by the
// `companion://oidc/callback?code=...` deep link for a real JWT, then trade that JWT
// for a durable API key — identical to the password path. The one-time code is single
// use and short-lived, and redeemable only with the PKCE verifier this app kept when it
// started the sign-in; no long-lived secret ever travels in the deep-link URL.
async function completeOidcNativeSignIn(code: string, codeVerifier: string): Promise<string | null> {
  const data = await fetchJson<OidcNativeExchangeResponse>('/api/authenticate/oidc/native/exchange', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ code, code_verifier: codeVerifier }),
  });

  const jwt = data?.accessToken ?? null;

  if (!jwt) {
    return null;
  }

  return mintAndStoreApiKey(jwt);
}

/** What a caller of `logout` can ask for. */
export interface LogoutOptions {
  /**
   * Sign out without asking about captures that never uploaded, and delete them. Only for a
   * caller whose own confirmation already covered them: account deletion, after which the
   * key no longer works and the captures could never upload anyway.
   */
  discardUnsentCaptures?: boolean;
}

export interface SignOutPrompt {
  open: boolean;
  /** Queued captures of this account that signing out would delete. */
  unsentCaptures: number;
}

type ReturnValue = [
  {
    expired: boolean;
    authToken?: string | null;
    /**
     * Who the current session token belongs to (its `sub` claim), or null when
     * there is no JWT — including on native, which authenticates with a keystore
     * API key instead. Unlike `authToken` this is stable across the rotation
     * `useAutoRefreshToken` performs, so per-user caches keyed on it survive a
     * token refresh and drop only on a real identity change.
     */
    subject: string | null;
    /** True when authenticated by EITHER a web JWT session or a native API key. */
    authenticated: boolean;
    loading: boolean;
    /**
     * True only while the mount-time session handshake is in flight — unlike
     * `loading`, it stays false during a login/signup POST. Route gates must
     * use this: swapping the tree out mid-submit unmounts the form that is
     * awaiting the response, discarding what the user typed along with any
     * error the response was meant to surface.
     */
    initializing: boolean;
    error: unknown | null;
    /**
     * The question a phone sign-out asks when captures are still queued after its last
     * upload try (`UnsentCapturesSignOutDialog` shows it). `unsentCaptures` keeps its value
     * after the answer, so the closing dialog does not change its text.
     */
    signOutPrompt: SignOutPrompt;
  },
  {
    login: (username: string, password: string) => Promise<void>;
    /**
     * Sign out. On a phone with captures that never reached this account, it asks first:
     * `signOutPrompt` opens, and nothing is signed out or deleted until `confirmSignOut`.
     */
    logout: (options?: LogoutOptions) => Promise<void>;
    /** "Sign out" on the `signOutPrompt` question: delete the unsent captures and sign out. */
    confirmSignOut: () => Promise<void>;
    /** "Cancel" on the `signOutPrompt` question: stay signed in, with the queue as it is. */
    cancelSignOut: () => void;
    signup: (name: string, email: string, password: string, signup_code?: string) => Promise<void>;
    /**
     * After Portal cloud-connect: trade a portal OIDC bearer for a Memory API
     * key so the phone does not do a second Safari/login hop.
     */
    completePortalMemoryConnect: (portalBearer: string, memoryOrigin?: string) => Promise<boolean>;
    /**
     * Fallback when the Portal bearer is rejected (401): sign in with the same
     * Memory email/password the browser uses, then mint a key from that JWT.
     */
    completeMemoryPasswordConnect: (
      email: string,
      password: string,
      memoryOrigin: string,
    ) => Promise<boolean>;
    /**
     * Re-mint the access JWT from the 7-day session cookie. Safe to call when
     * a background tab missed the scheduled refresh and the short-lived token
     * has already expired.
     */
    refresh: () => Promise<void>;
  },
];

function useAuth(): ReturnValue {
  const navigate = useNavigate();
  const location = useLocation();

  const [loginLoading, setLoginLoading] = useState<boolean>(false);
  const [loginError, setLoginError] = useState<unknown | null>(null);
  const [refreshError, setRefreshError] = useState<unknown | null>(null);
  const [initializing, setInitializing] = useState<boolean>(true);

  const [accessToken, setAccessToken] = useState<string | null>(null);
  // Native-only: present once the keystore API key is loaded/minted. Drives the
  // authenticated state on native, where there is no JWT in `accessToken`.
  const [nativeApiKey, setNativeApiKey] = useState<string | null>(null);
  const [signOutPrompt, setSignOutPrompt] = useState<SignOutPrompt>({ open: false, unsentCaptures: 0 });

  const decoded = useMemo(() => (accessToken ? jwtDecode<JwtPayload>(accessToken) : null), [accessToken]);
  const isExpired = useCallback(() => (decoded ? Date.now() >= decoded.exp * 1000 : true), [decoded]);

  const login = useCallback(
    async (email: string, password: string) => {
      setLoginLoading(true);
      setLoginError(null);

      try {
        // Obtain a pre-auth CSRF token before submitting credentials. On native this
        // also captures the token from the response body (primeCsrfCookie handles the
        // cookie-less path), so `withCsrfHeader` below finds it either way.
        const native = isNativePlatform();

        await primeCsrfCookie();

        const data = await fetchJson<AuthResponse>('/api/authenticate', {
          method: 'POST',
          headers: withCsrfHeader({
            'Content-Type': 'application/json',
          }),
          credentials: native ? 'omit' : 'include',
          body: JSON.stringify({
            username: email,
            password,
          }),
        });

        const jwt = data?.accessToken ?? null;

        if (jwt && isNativePlatform()) {
          // Native: trade the JWT for a durable API key and authenticate via that.
          setNativeApiKey(await mintAndStoreApiKey(jwt));
        } else {
          setAccessToken(jwt);
        }

        const returnTo = (location.state as { from?: string })?.from ?? '/';
        navigate(returnTo, { replace: true });
      } catch (err: unknown) {
        setLoginError(err);
      } finally {
        setLoginLoading(false);
      }
    },
    [navigate, location.state],
  );

  const completePortalMemoryConnect = useCallback(
    async (portalBearer: string, memoryOrigin?: string): Promise<boolean> => {
      // Do not point the app at the picked server until its key is stored.
      // The picker can still be "authenticated" by the previous box's key
      // (a keystore read that landed after logout). Setting the origin first
      // makes `me` run with that key, and the new server answers Unauthorized
      // even though minting a key for this account succeeded.
      bumpNativeCredentialEpoch();
      const previousOrigin = getApiBaseUrl();

      try {
        const key = await mintAndStoreApiKey(portalBearer, memoryOrigin);

        if (!key) {
          throw new Error('Memory Server did not return an API key.');
        }

        if (memoryOrigin) {
          persistApiBaseUrl(memoryOrigin);
          void syncNativeIntentConfig();
        }

        setNativeApiKey(key);

        return true;
      } catch (err) {
        setApiBaseUrl(previousOrigin);
        throw err;
      }
    },
    [],
  );

  const completeMemoryPasswordConnect = useCallback(
    async (email: string, password: string, memoryOrigin: string) => {
      persistApiBaseUrl(memoryOrigin);
      await primeCsrfCookie();

      const native = isNativePlatform();
      const data = await fetchJson<AuthResponse>('/api/authenticate', {
        method: 'POST',
        headers: withCsrfHeader({
          'Content-Type': 'application/json',
        }),
        credentials: native ? 'omit' : 'include',
        body: JSON.stringify({
          username: email,
          password,
        }),
      });

      const jwt = data?.accessToken ?? null;

      if (!jwt) {
        throw new Error('Memory Server did not return a session.');
      }

      if (native) {
        const key = await mintAndStoreApiKey(jwt, memoryOrigin);

        if (!key) {
          throw new Error('Memory Server did not return an API key.');
        }

        setNativeApiKey(key);
      } else {
        setAccessToken(jwt);
      }

      return true;
    },
    [],
  );

  // The sign-out itself, once there is nothing left to ask. `logout` decides whether to ask.
  const signOut = useCallback(async () => {
    // The key this device signs in with (phone and desktop), read before it is dropped below.
    // The stored copy when none is in memory: the desktop never loads its stored key back on
    // start, and a phone can sign out before the keystore restore lands. Deleting that copy
    // below without revoking it would leave a working key on the server that no device holds.
    const deviceKey =
      getApiKey() ?? (isNativePlatform() || isTauriPlatform() ? await storedDeviceKey() : null);

    // Drop the in-memory key before the replica wipe. A late keystore restore
    // must not put the previous box's key back under the next account.
    bumpNativeCredentialEpoch();

    if (isNativePlatform() || isTauriPlatform()) {
      setApiKey(null);
      setNativeApiKey(null);
    }

    // Revoke it on the server while the app still knows which server that is (the
    // native branch below forgets the origin). Without this, signing out only forgot
    // the key on this device and it kept working for whoever else had a copy.
    if (deviceKey) {
      await revokeDeviceKey(deviceKey);
    }

    // Bounded: a replica that cannot be dropped (worker never came up) must not
    // leave the user stuck signed in. Everything below still runs on timeout.
    await disconnectAndClearPowerSyncForLogout();

    if (isTauriPlatform()) {
      // The desktop keeps its key in this page's storage; a revoked key left there
      // would only be read back as a credential that no longer works.
      await removeStoredDeviceKey();
    }

    if (isNativePlatform()) {
      // No cookie session to revoke; the key was revoked above. Clear the local copy.
      setApiKey(null);
      await removeStoredDeviceKey();
      // A saved public origin makes iOS skip the device picker, so the next
      // Companion login would still talk to the previous box and never list
      // the new account's Memory servers. Drop the pairing with the key.
      clearPersistedApiBaseUrl();
      await syncNativeIntentConfig();
      // The Local Hub outbox outlives the session. Rows still queued belong to
      // the account that just left (`logout` asked before deleting its unsent
      // ones), and would otherwise upload into whichever account signs in next
      // on this phone.
      await clearOutboxAfterSignOut();
      setNativeApiKey(null);
      setAccessToken(null);
      setLoginLoading(false);
      setLoginError(null);
      navigate('/');

      return;
    }

    try {
      // Web only — the native branch above already returned. postLogout carries the
      // prime-and-retry-once handling that keeps a stale CSRF cookie from skipping the
      // server-side session teardown.
      await postLogout();
    } catch (error) {
      console.error('Logout failed on server:', error);
    }

    // Enrichment this account still owes must not be requested under the next one.
    resetIngestFinishState();
    setAccessToken(null);
    setLoginLoading(false);
    setLoginError(null);

    authChannel.postMessage('logout');

    navigate('/');
  }, [navigate]);

  // The logout already under way. On a phone it can spend up to SIGN_OUT_DRAIN_TIMEOUT_MS on
  // its last upload with nothing on screen, and a second tap on Log out in that time must
  // not start a second drain, or a second sign-out alongside the first.
  const logoutInFlight = useRef<Promise<void> | null>(null);

  const logout = useCallback(
    (options: LogoutOptions = {}) => {
      if (logoutInFlight.current) {
        return logoutInFlight.current;
      }

      const run = (async () => {
        // Discarding: the captures can never upload (the account is gone), so there is
        // nothing to upload first and nothing to ask about.
        if (isNativePlatform() && !options.discardUnsentCaptures) {
          // One last, bounded upload of what this account queued while offline, while its
          // key is still the one requests carry.
          await drainOutboxBeforeSignOut();

          // Signing out deletes whatever is still queued. When some of it is this account's,
          // ask first, and touch nothing until the answer: Cancel keeps the session and the
          // queue, so the captures can still upload once the phone is back online.
          const unsentCaptures = await countUnsentBeforeSignOut();

          if (unsentCaptures > 0) {
            setSignOutPrompt({ open: true, unsentCaptures });

            return;
          }
        }

        await signOut();
      })().finally(() => {
        logoutInFlight.current = null;
      });

      logoutInFlight.current = run;

      return run;
    },
    [signOut],
  );

  const confirmSignOut = useCallback(async () => {
    setSignOutPrompt((prompt) => ({ ...prompt, open: false }));
    await signOut();
  }, [signOut]);

  const cancelSignOut = useCallback(() => {
    setSignOutPrompt((prompt) => ({ ...prompt, open: false }));
  }, []);

  const signup = useCallback(
    async (name: string, email: string, password: string, signup_code?: string) => {
      setLoginLoading(true);
      setLoginError(null);

      try {
        // Obtain a pre-auth CSRF token before submitting signup
        await primeCsrfCookie();

        const data = await fetchJson<AuthResponse>('/api/signup', {
          method: 'POST',
          headers: withCsrfHeader({
            'Content-Type': 'application/json',
          }),
          credentials: 'include',
          body: JSON.stringify({
            name,
            email,
            password,
            signup_code,
          }),
        });

        const jwt = data?.accessToken ?? null;

        if (jwt && isNativePlatform()) {
          setNativeApiKey(await mintAndStoreApiKey(jwt));
        } else {
          setAccessToken(jwt);
        }

        navigate('/');
      } catch (err: unknown) {
        setLoginError(err);
      } finally {
        setLoginLoading(false);
      }
    },
    [navigate],
  );

  const refresh = useCallback(async () => {
    setRefreshError(null);

    try {
      const data = await refreshSession();

      setAccessToken(data?.accessToken ?? null);
    } catch (err: unknown) {
      setRefreshError(err);
      setAccessToken(null);
    }
  }, []);

  useEffect(() => {
    (async () => {
      try {
        if (isNativePlatform()) {
          // Native restore: origin first, then the API key. A key without an
          // origin makes every `/api/...` call relative, which CapacitorHttp
          // rejects — the cloud-connect picker then looks like a failed mint.
          const epoch = nativeCredentialEpoch;
          const storedOrigin = await secureStorageGet('ci.apiBaseUrl');

          if (epoch !== nativeCredentialEpoch) {
            return;
          }

          if (!(await adoptKeystoreOrigin(storedOrigin))) {
            return;
          }

          const storedKey = await secureStorageGet(API_KEY_STORAGE);

          if (epoch !== nativeCredentialEpoch) {
            return;
          }

          if (storedKey) {
            setApiKey(storedKey);
            setNativeApiKey(storedKey);
          }

          return;
        }

        const bridged = await alignHubSession();

        if (bridged?.replaced && bridged.accessToken) {
          // Stale PowerSync replica belongs to the previous Memory person.
          await disconnectAndClearPowerSyncForLogout();
          setAccessToken(bridged.accessToken);
        } else {
          const data = await refreshSession();
          setAccessToken(data?.accessToken ?? null);
        }
      } catch {
        // No valid session cookie, user will need to log in
      } finally {
        setInitializing(false);
      }
    })();
  }, []);

  useAutoRefreshToken(accessToken, refresh);

  // Native only — Capacitor (iOS/Android) or Tauri (desktop): complete "Sign in with
  // CI Portal" when the system browser redirects back into the app via the
  // `companion://oidc/callback?...` deep link. Unrelated deep links (other
  // schemes/paths) parse to null and are ignored. iOS often cold-starts from
  // Safari's "Open with Companion", so we also consume `getLaunchUrl` there — web
  // and Android keep the live listener only. Desktop's cold-start equivalent is
  // handled entirely inside addAppUrlOpenListener itself (main.rs unifies cold- and
  // warm-start delivery on that side), so no separate call is needed here for it.
  useEffect(() => {
    if (!isNativePlatform() && !isTauriPlatform()) {
      return;
    }

    let unsubscribe = () => {};

    let cancelled = false;
    const seenCodes = new Set<string>();

    const handleUrl = (url: string) => {
      const params = parseOidcCallbackUrl(url);

      if (!params) {
        return;
      }

      // Only the result of a sign-in THIS app started counts, failures included: the
      // state on the link must be the one `OidcButton` kept. Any other
      // `companion://oidc/callback` link (one somebody sent, one another app opened) is
      // dropped before it can sign the app into anyone's account, replace the key it
      // holds, or put its own text on the login screen.
      const pending = takePendingNativeOidcSignIn(params.state);

      if (!pending) {
        // An appliance from before the state echo answers this app's own sign-in with no
        // state. Its code is still not redeemed (nothing ties it to this app), but the
        // person is told why the sign-in did not finish rather than left watching nothing.
        if (!params.state && hasPendingNativeOidcSignIn()) {
          setLoginError(new Error(SERVER_UPDATE_REQUIRED));

          return;
        }

        console.warn('Ignoring a sign-in link this app did not start');

        return;
      }

      if (params.error || !params.code) {
        setLoginError(new Error(params.error || 'oidc_failed'));

        return;
      }

      if (seenCodes.has(params.code) || !claimNativeOidcCode(params.code)) {
        return;
      }

      seenCodes.add(params.code);
      const { code } = params;

      void (async () => {
        try {
          const key = await completeOidcNativeSignIn(code, pending.verifier);

          if (!key) {
            setLoginError(new Error('oidc_exchange_failed'));

            return;
          }

          setNativeApiKey(key);
          navigate('/', { replace: true });
        } catch (err: unknown) {
          setLoginError(err);
        }
      })();
    };

    void (async () => {
      // Subscribe first. iOS can deliver the Safari return as `appUrlOpen`
      // while `getLaunchUrl` is still awaiting; that event is dropped if the
      // listener is not up yet. Duplicate URLs are de-duped via `seenCodes`.
      const cleanup = await addAppUrlOpenListener(handleUrl);

      if (cancelled) {
        cleanup();

        return;
      }

      unsubscribe = cleanup;

      // iOS ONLY. The effect above already returned unless native, so checking
      // `isNativePlatform()` here was always true and Android consumed the
      // launch URL too — contradicting the contract three lines up, which says
      // web and Android keep the live listener only. Android delivers the
      // callback through `appUrlOpen`; reading the launch URL there re-handles
      // a deep link the listener has already taken.
      if (isIosPlatform()) {
        const launched = await getLaunchUrl();

        if (!cancelled && launched) {
          handleUrl(launched);
        }
      }
    })();

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [navigate]);

  useEffect(() => {
    if (!isNativePlatform() || (!nativeApiKey && !accessToken)) {
      return;
    }

    void registerNativePushToken();
  }, [nativeApiKey, accessToken]);

  useEffect(() => {
    const handleAuthMessage = (event: MessageEvent) => {
      if (event.data === 'logout') {
        setAccessToken(null);
      }
    };

    authChannel.addEventListener('message', handleAuthMessage);

    return () => {
      authChannel.removeEventListener('message', handleAuthMessage);
    };
  }, []);

  // A failed attempt belongs to the page it was made on. This hook's state is
  // app-wide (it lives in a provider above the router), so without this a
  // rejected login left "Invalid credentials" sitting on the signup form the
  // user then navigated to — an error about a form they had not submitted,
  // above fields they had just filled in.
  //
  // Keyed on pathname alone, not the whole location: the OIDC callback rewrites
  // `search` on the same route while reporting its own failure through this same
  // slot, and reacting to that would clear the message before it could be read.
  //
  // `refreshError` is deliberately left alone. It says the session expired,
  // which stays true wherever the user navigates.
  const pathname = location.pathname;

  useEffect(() => {
    // Native cold-start from Safari lands on `/` then hops to `/login`. Do not
    // drop an OIDC error that was raised on the first path of that hop.
    if (pathname === '/login') {
      return;
    }

    setLoginError(null);
  }, [pathname]);

  return [
    {
      // A native API key never "expires" from the client's point of view (there is
      // no short-lived JWT to age out); web keeps the JWT expiry check.
      expired: nativeApiKey ? false : isExpired(),
      authToken: accessToken,
      subject: decoded?.sub ?? null,
      authenticated: Boolean(accessToken) || Boolean(nativeApiKey),
      loading: loginLoading || initializing,
      initializing,
      error: loginError ?? refreshError,
      signOutPrompt,
    },
    {
      login,
      logout,
      confirmSignOut,
      cancelSignOut,
      signup,
      completePortalMemoryConnect,
      completeMemoryPasswordConnect,
      refresh,
    },
  ];
}

function tokenRefreshAt(accessToken: string): number {
  const decoded = jwtDecode<JwtPayload>(accessToken);

  return (decoded.exp || 0) * 1000 - 60 * 1000;
}

function useAutoRefreshToken(accessToken: string | null | undefined, onRefresh: () => Promise<void>) {
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onRefreshRef = useRef(onRefresh);

  onRefreshRef.current = onRefresh;

  useEffect(() => {
    if (!accessToken) {
      return;
    }

    const schedule = () => {
      const delay = Math.max(tokenRefreshAt(accessToken) - Date.now(), 0);

      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }

      timeoutRef.current = setTimeout(() => {
        void onRefreshRef.current();
      }, delay);
    };

    // Background tabs throttle setTimeout. When the user comes back, recover
    // immediately if the access JWT is inside (or past) the refresh window.
    const recoverIfDue = () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        return;
      }

      if (Date.now() >= tokenRefreshAt(accessToken)) {
        void onRefreshRef.current();

        return;
      }

      schedule();
    };

    schedule();
    document.addEventListener('visibilitychange', recoverIfDue);
    window.addEventListener('focus', recoverIfDue);
    window.addEventListener('pageshow', recoverIfDue);

    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }

      document.removeEventListener('visibilitychange', recoverIfDue);
      window.removeEventListener('focus', recoverIfDue);
      window.removeEventListener('pageshow', recoverIfDue);
    };
  }, [accessToken]);
}

const { Provider, useHookContext } = createHookContext(useAuth);

export { Provider as AuthProvider, useHookContext as useAuth };
