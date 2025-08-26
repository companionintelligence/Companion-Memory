import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { createHookContext, fetchJson } from '@ci/common';
import { jwtDecode } from 'jwt-decode';
import { useNavigate } from 'react-router-dom';

const ACCESS_TOKEN_KEY = 'accessToken';
const SESSION_TOKEN_KEY = 'sessionToken';

interface JwtPayload {
  sub: string;
  iat: number;
  exp: number;
}

interface User {
  id: string;
  name: string;
  email: string;
}

interface AuthResponse {
  sessionToken: string;
  accessToken: string;
  user: User;
}

type Value = [
  {
    expired: boolean;
    authToken?: string | null;
    user?: User | null;
    loading: boolean;
    error: Error | null;
  },
  {
    login: (username: string, password: string) => void;
    logout: () => void;
    signup: (name: string, email: string, password: string) => void;
  },
];

function useAuth(): Value {
  const navigate = useNavigate();

  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<Error | null>(null);

  const accessToken = localStorage.getItem(ACCESS_TOKEN_KEY);
  const sessionToken = localStorage.getItem(SESSION_TOKEN_KEY);

  const decoded = useMemo(() => (accessToken ? jwtDecode<JwtPayload>(accessToken) : null), [accessToken]);
  const isExpired = useCallback(() => (decoded ? Date.now() >= decoded.exp * 1000 : true), [decoded]);

  const getSelfProfile = useCallback(async () => {
    if (accessToken == null || isExpired() || (decoded && decoded.sub === user?.id)) {
      setLoading(false);

      return false;
    }

    setLoading(true);
    setError(null);

    try {
      const data: User = await fetchJson('/api/users/me', {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
      });

      setUser(data);
    } catch (error: unknown) {
      setUser(null);
      setError(error as Error);
    } finally {
      setLoading(false);
    }
  }, [setUser, setLoading, setError, isExpired, decoded, user, loading]);

  const login = useCallback(
    async (email: string, password: string) => {
      setLoading(true);
      setError(null);

      try {
        const data: AuthResponse = await fetchJson('/api/authenticate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: email,
            password,
          }),
        });
        const accessDecoded = jwtDecode(data.accessToken);
        document.cookie = `CI_accessToken=${data.accessToken}; SameSite=None; Secure; expires=${new Date(accessDecoded.exp! * 1000).toUTCString()}`;
        const sessionDecoded = jwtDecode(data.accessToken);
        document.cookie = `CI_sessionToken=${data.sessionToken}; SameSite=None; Secure; expires=${new Date(sessionDecoded.exp! * 1000).toUTCString()}`;

        localStorage.setItem(ACCESS_TOKEN_KEY, data.accessToken);
        localStorage.setItem(SESSION_TOKEN_KEY, data.sessionToken);
        setUser(data.user);

        navigate('/feed');
      } catch (error: unknown) {
        setUser(null);
        setError(error as Error);
      } finally {
        setLoading(false);
      }
    },
    [setUser, setError, setLoading],
  );

  const logout = useCallback(() => {
    localStorage.removeItem(ACCESS_TOKEN_KEY);
    // TODO: This isn't good enough, we need to POST to the API to destroy the session.
    localStorage.removeItem(SESSION_TOKEN_KEY);

    setUser(null);
    setLoading(false);
    setError(null);

    navigate('/');
  }, [setUser, setLoading, setError]);

  const signup = useCallback(
    async (name: string, email: string, password: string) => {
      setLoading(true);
      setError(null);

      try {
        const data: AuthResponse = await fetchJson('/api/signup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name,
            email,
            password,
          }),
        });

        localStorage.setItem(ACCESS_TOKEN_KEY, data.accessToken);
        localStorage.setItem(SESSION_TOKEN_KEY, data.sessionToken);
        setUser(data.user);

        navigate('/dashboard');
      } catch (error: unknown) {
        setUser(null);
        setError(error as Error);
      } finally {
        setLoading(false);
      }
    },
    [setUser, setError, setLoading],
  );

  const refresh = useCallback(async () => {
    const data: AuthResponse = await fetchJson('/api/authenticate/refresh', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${sessionToken}`,
      },
    });

    localStorage.setItem(ACCESS_TOKEN_KEY, data.accessToken);
    localStorage.setItem(SESSION_TOKEN_KEY, data.sessionToken);
    setUser(data.user);
  }, [setUser]);

  useAutoRefreshToken(accessToken, sessionToken, refresh);

  useEffect(() => {
    getSelfProfile();
  }, [decoded]);

  return [
    {
      expired: isExpired(),
      authToken: accessToken,
      user,
      loading,
      error,
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
  onRefresh: (refreshToken: string) => Promise<void>,
) {
  const timeoutRef = useRef<ReturnType<typeof setTimeout>>(null);

  useEffect(() => {
    if (!accessToken || !refreshToken) {
      return;
    }

    const decoded = jwtDecode(accessToken);
    const exp = (decoded.exp || 0) * 1000;
    const now = Date.now();
    const refreshAt = exp - 60 * 1000;
    const delay = Math.max(refreshAt - now, 0);

    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }

    timeoutRef.current = setTimeout(() => {
      onRefresh(refreshToken);
    }, delay);

    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, [accessToken, refreshToken, onRefresh]);
}

const { Provider, useHookContext } = createHookContext(useAuth);

export { Provider as AuthProvider, useHookContext as useAuth };
