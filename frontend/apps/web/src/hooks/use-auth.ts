import { jwtDecode } from 'jwt-decode';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { createHookContext, fetchJson } from '@ci/common';

const CREDENTIAL_KEY = 'credentials';

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
  accessToken: string;
  user: User;
}

type Value = [
  {
    expired: boolean;
    user?: User;
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

  const credentials = localStorage.getItem(CREDENTIAL_KEY);
  const decoded = useMemo(() => (credentials ? jwtDecode<JwtPayload>(credentials) : null), [credentials]);
  const isExpired = useCallback(() => (decoded ? Date.now() >= decoded.exp * 1000 : true), [decoded]);

  const getSelfProfile = useCallback(async () => {
    if (credentials == null || isExpired()) {
      setLoading(false);
      return false;
    }

    setLoading(true);
    setError(null);

    try {
      const decoded = jwtDecode<JwtPayload>(credentials);
      const userId = decoded.sub;
      const data: User = await fetchJson(`/api/users/${userId}`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${credentials}`,
        },
      });

      setUser(data);
    } catch (error: unknown) {
      setUser(null);
      setError(error as Error);
    } finally {
      setLoading(false);
    }
  }, [setUser, setLoading, setError, credentials, isExpired]);

  const login = useCallback(
    async (email: string, password: string) => {
      setLoading(true);
      setError(null);

      try {
        const data: AuthResponse = await fetchJson('/api/authenticate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            strategy: "local",
            username: email,
            password,
          }),
        });

        localStorage.setItem(CREDENTIAL_KEY, data.accessToken);
        setUser(data.user);

        navigate('/');
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
    localStorage.removeItem(CREDENTIAL_KEY);

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

        localStorage.setItem(CREDENTIAL_KEY, data.accessToken);
        setUser(data.user);

        navigate('/');
      } catch (error: unknown) {
        setUser(null);
        setError(error as Error);
      } finally {
        setLoading(false);
      }
    },
    [setUser, setError, setLoading],
  );

  useEffect(() => {
    // only try to fetch self-profile on first load
    if (user == null && credentials != null && !isExpired()) {
      getSelfProfile();
    } else {
      setLoading(false);
    }
  }, []);

  return [
    {
      expired: isExpired(),
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

const { Provider, useHookContext } = createHookContext(useAuth);

export { Provider as AuthProvider, useHookContext as useAuth };
