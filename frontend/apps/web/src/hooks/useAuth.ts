import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  buildApiUrl,
  createHookContext,
  fetchJson,
  FetchJsonError,
  isNativePlatform,
  secureStorageGet,
  secureStorageRemove,
  secureStorageSet,
  setApiKey,
} from '@ci/common';
import { jwtDecode } from 'jwt-decode';
import { useNavigate, useLocation } from 'react-router-dom';

const authChannel = new BroadcastChannel('auth');

// On native the durable credential is an API key kept in the OS keystore — the
// cookie/JWT session does not survive cross-origin inside a webview. We store the
// raw key (sent as x-api-key) and its server id (for reference/future revocation).
const API_KEY_STORAGE = 'ci.apiKey';
const API_KEY_ID_STORAGE = 'ci.apiKeyId';

const CSRF_COOKIE_NAME = 'csrfToken';

function getCsrfToken(): string | undefined {
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
  try {
    const res = await fetch(buildApiUrl('/api/authenticate/csrf'), {
      credentials: 'include',
    });

    // The status matters: on a non-2xx the cookie was NOT (re)issued, so the
    // caller must not treat a retry as meaningfully different from the attempt
    // that just failed. Swallow the error rather than propagating — a priming
    // blip should not by itself log out a user whose session is still valid;
    // let the refresh attempt below decide that.
    return res.ok;
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

  const first = await fetch(buildApiUrl('/api/authenticate/logout'), {
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

  const retry = await fetch(buildApiUrl('/api/authenticate/logout'), {
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

// Exchange a freshly-issued JWT for a long-lived API key (the /api/keys endpoint is
// JWT-guarded, so this must run while we still hold the login JWT), persist it to the
// keystore, and activate it for subsequent requests. Returns the raw key, or null.
async function mintAndStoreApiKey(jwt: string): Promise<string | null> {
  const created = await fetchJson<CreateApiKeyResponse>('/api/keys', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${jwt}`,
    },
    body: JSON.stringify({
      name: `Companion mobile · ${new Date().toISOString().slice(0, 10)}`,
    }),
  });

  if (!created?.key) {
    return null;
  }

  await secureStorageSet(API_KEY_STORAGE, created.key);
  await secureStorageSet(API_KEY_ID_STORAGE, created.id);
  setApiKey(created.key);

  return created.key;
}

type ReturnValue = [
  {
    expired: boolean;
    authToken?: string | null;
    /** True when authenticated by EITHER a web JWT session or a native API key. */
    authenticated: boolean;
    loading: boolean;
    error: unknown | null;
  },
  {
    login: (username: string, password: string) => Promise<void>;
    logout: () => void;
    signup: (name: string, email: string, password: string, signup_code?: string) => Promise<void>;
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

  const decoded = useMemo(() => (accessToken ? jwtDecode<JwtPayload>(accessToken) : null), [accessToken]);
  const isExpired = useCallback(() => (decoded ? Date.now() >= decoded.exp * 1000 : true), [decoded]);

  const login = useCallback(
    async (email: string, password: string) => {
      setLoginLoading(true);
      setLoginError(null);

      try {
        // Obtain a pre-auth CSRF token before submitting credentials
        await primeCsrfCookie();

        const data = await fetchJson<AuthResponse>('/api/authenticate', {
          method: 'POST',
          headers: withCsrfHeader({
            'Content-Type': 'application/json',
          }),
          credentials: 'include',
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

  const logout = useCallback(async () => {
    if (isNativePlatform()) {
      // No cookie session to revoke. Clear the local credential; the API key stays
      // valid server-side (the /api/keys revoke endpoint is JWT-only, and we hold no
      // JWT here) and can be revoked from Settings → API Keys after re-login.
      setApiKey(null);
      await secureStorageRemove(API_KEY_STORAGE);
      await secureStorageRemove(API_KEY_ID_STORAGE);
      setNativeApiKey(null);
      setAccessToken(null);
      setLoginLoading(false);
      setLoginError(null);
      navigate('/');

      return;
    }

    try {
      await postLogout();
    } catch (error) {
      console.error('Logout failed on server:', error);
    }

    setAccessToken(null);
    setLoginLoading(false);
    setLoginError(null);

    authChannel.postMessage('logout');

    navigate('/');
  }, [navigate]);

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
          // Native restore: load the stored API key. No cookie refresh applies here.
          const storedKey = await secureStorageGet(API_KEY_STORAGE);

          if (storedKey) {
            setApiKey(storedKey);
            setNativeApiKey(storedKey);
          }

          return;
        }

        const data = await refreshSession();

        setAccessToken(data?.accessToken ?? null);
      } catch {
        // No valid session cookie, user will need to log in
      } finally {
        setInitializing(false);
      }
    })();
  }, []);

  useAutoRefreshToken(accessToken, refresh);

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

  return [
    {
      // A native API key never "expires" from the client's point of view (there is
      // no short-lived JWT to age out); web keeps the JWT expiry check.
      expired: nativeApiKey ? false : isExpired(),
      authToken: accessToken,
      authenticated: Boolean(accessToken) || Boolean(nativeApiKey),
      loading: loginLoading || initializing,
      error: loginError ?? refreshError,
    },
    {
      login,
      logout,
      signup,
    },
  ];
}

function useAutoRefreshToken(accessToken: string | null | undefined, onRefresh: () => Promise<void>) {
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!accessToken) {
      return;
    }

    const decoded = jwtDecode<JwtPayload>(accessToken);
    const exp = (decoded.exp || 0) * 1000;
    const now = Date.now();
    const refreshAt = exp - 60 * 1000;
    const delay = Math.max(refreshAt - now, 0);

    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }

    timeoutRef.current = setTimeout(() => {
      onRefresh();
    }, delay);

    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, [accessToken, onRefresh]);
}

const { Provider, useHookContext } = createHookContext(useAuth);

export { Provider as AuthProvider, useHookContext as useAuth };
