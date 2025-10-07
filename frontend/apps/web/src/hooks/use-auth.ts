import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { createHookContext, fetchJson } from '@ci/common';
import { jwtDecode } from 'jwt-decode';
import { useNavigate } from 'react-router-dom';

const ACCESS_TOKEN_KEY = 'accessToken';
const SESSION_TOKEN_KEY = 'sessionToken';
const ACCESS_TOKEN_COOKIE = 'CI_accessToken';
const SESSION_TOKEN_COOKIE = 'CI_sessionToken';

interface JwtPayload {
  sub: string;
  iat: number;
  exp: number;
}

interface User {
  id: string;
  name: string;
  email: string;
  onboarded: boolean;
}

interface AuthResponse {
  sessionToken: string;
  accessToken: string;
  user: User;
}

type ReturnValue = [
  {
    expired: boolean;
    authToken?: string | null;
    user?: User | null;
    loading: boolean;
    error: unknown | null;
  },
  {
    login: (username: string, password: string) => Promise<void>;
    logout: () => void;
    signup: (name: string, email: string, password: string, signup_code: string) => Promise<void>;
  },
];

function useAuth(): ReturnValue {
  const navigate = useNavigate();

  const [user, setUser] = useState<User | null>(null);
  const [loginLoading, setLoginLoading] = useState<boolean>(false);
  const [loginError, setLoginError] = useState<unknown | null>(null);
  const [refreshError, setRefreshError] = useState<unknown | null>(null);
  const [initialLoading, setInitialLoading] = useState<boolean>(true);

  const [accessToken, setAccessToken] = useState<string | null>(
    localStorage.getItem(ACCESS_TOKEN_KEY) ?? null,
  );

  const [sessionToken, setSessionToken] = useState<string | null>(
    localStorage.getItem(SESSION_TOKEN_KEY) ?? null,
  );

  const decoded = useMemo(() => (accessToken ? jwtDecode<JwtPayload>(accessToken) : null), [accessToken]);
  const isExpired = useCallback(() => (decoded ? Date.now() >= decoded.exp * 1000 : true), [decoded]);

  const updateAccessToken = useCallback((token: string | null) => {
    if (token) {
      const decoded = jwtDecode<JwtPayload>(token);

      setAccessToken(token);
      localStorage.setItem(ACCESS_TOKEN_KEY, token);
      document.cookie = `${ACCESS_TOKEN_COOKIE}=${token}; SameSite=None; Secure; expires=${new Date(decoded.exp * 1000).toUTCString()}`;
    } else {
      setAccessToken(null);
      localStorage.removeItem(ACCESS_TOKEN_KEY);
      deleteCookie(ACCESS_TOKEN_COOKIE);
    }
  }, []);

  const updateSessionToken = useCallback((token: string | null) => {
    if (token) {
      const decoded = jwtDecode<JwtPayload>(token);

      setSessionToken(token);
      localStorage.setItem(SESSION_TOKEN_KEY, token);
      document.cookie = `${SESSION_TOKEN_COOKIE}=${token}; SameSite=None; Secure; expires=${new Date(decoded.exp * 1000).toUTCString()}`;
    } else {
      setSessionToken(null);
      localStorage.removeItem(SESSION_TOKEN_KEY);
      deleteCookie(SESSION_TOKEN_COOKIE);
    }
  }, []);

  const login = useCallback(
    async (email: string, password: string) => {
      setLoginLoading(true);
      setLoginError(null);

      try {
        const data: AuthResponse = await fetchJson('/api/authenticate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: email,
            password,
          }),
        });

        updateAccessToken(data.accessToken);
        updateSessionToken(data.sessionToken);
        setUser(data.user);
        setInitialLoading(false);

        navigate('/');
      } catch (err: unknown) {
        setUser(null);
        setLoginError(err);
      } finally {
        setLoginLoading(false);
      }
    },
    [navigate, updateAccessToken, updateSessionToken],
  );

  const logout = useCallback(() => {
    // TODO: This isn't good enough, we need to POST to the API to destroy the session.
    updateAccessToken(null);
    updateSessionToken(null);
    setUser(null);
    setLoginLoading(false);
    setLoginError(null);
    setInitialLoading(false);

    navigate('/');
  }, [navigate, updateAccessToken, updateSessionToken]);

  const signup = useCallback(
    async (name: string, email: string, password: string, signup_code: string) => {
      setLoginLoading(true);
      setLoginError(null);

      try {
        const data: AuthResponse = await fetchJson('/api/signup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name,
            email,
            password,
            signup_code,
          }),
        });

        updateAccessToken(data.accessToken);
        updateSessionToken(data.sessionToken);
        setUser(data.user);

        navigate('/feed');
      } catch (error: unknown) {
        setUser(null);
        setLoginError(error);
      } finally {
        setLoginLoading(false);
      }
    },
    [setUser, updateAccessToken, updateSessionToken],
  );

  const refresh = useCallback(async () => {
    setRefreshError(null);

    try {
      const data: AuthResponse = await fetchJson('/api/authenticate/refresh', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${sessionToken}`,
        },
      });

      setUser(data.user);
      updateAccessToken(data.accessToken);
      updateSessionToken(data.sessionToken);
    } catch (err: unknown) {
      setRefreshError(err);

      setUser(null);
      updateAccessToken(null);
      updateSessionToken(null);
    }
  }, [sessionToken, updateAccessToken, updateSessionToken]);

  const fetchUser = useCallback(async () => {
    try {
      const data: User = await fetchJson('/api/users/me', {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });

      setUser(data);
    } catch {
      if (sessionToken) {
        await refresh();
      }
    }
  }, [accessToken, sessionToken, refresh]);

  useAutoRefreshToken(accessToken, sessionToken, refresh);

  useEffect(() => {
    (async () => {
      if (accessToken && !isExpired()) {
        await fetchUser();
      } else if (sessionToken) {
        await refresh();
      }

      setInitialLoading(false);
    })();
  }, []);

  return [
    {
      expired: isExpired(),
      authToken: accessToken,
      user,
      loading: initialLoading || loginLoading,
      error: loginError ?? refreshError,
    },
    {
      login,
      logout,
      signup,
    },
  ];
}

function useAutoRefreshToken(
  accessToken: string | null | undefined,
  refreshToken: string | null | undefined,
  onRefresh: () => Promise<void>,
) {
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!accessToken || !refreshToken) {
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
  }, [accessToken, refreshToken, onRefresh]);
}

function deleteCookie(name: string) {
  document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/; SameSite=None; Secure;`;
}

const { Provider, useHookContext } = createHookContext(useAuth);

export { Provider as AuthProvider, useHookContext as useAuth };
