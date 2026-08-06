import { type ReactNode } from 'react';

import { act, renderHook, waitFor } from '@testing-library/react';
import { jwtDecode } from 'jwt-decode';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthProvider, useAuth } from './useAuth';

vi.mock('jwt-decode', () => ({ jwtDecode: vi.fn() }));

const futureExp = () => Math.floor(Date.now() / 1000) + 3600;
const pastExp = () => Math.floor(Date.now() / 1000) - 3600;

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, text: async () => JSON.stringify(body) } as Response;
}

function emptyResponse(ok = true, status = 200): Response {
  return { ok, status, text: async () => '' } as Response;
}

// The native CSRF fetch reads the signed token via `response.json()` (not the cookie),
// so it needs a real `json()` in addition to `text()`.
function jsonBodyResponse(body: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) } as Response;
}

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;

function setFetch(handler: Handler) {
  const mock = vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
    Promise.resolve(handler(String(input), init)),
  );
  vi.stubGlobal('fetch', mock);

  return mock;
}

const wrapper = ({ children }: { children: ReactNode }) => (
  <MemoryRouter>
    <AuthProvider args={[]}>{children}</AuthProvider>
  </MemoryRouter>
);

beforeEach(() => {
  vi.mocked(jwtDecode).mockReturnValue({ sub: 'u1', iat: 0, exp: futureExp() });
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.cookie = 'csrfToken=; expires=Thu, 01 Jan 1970 00:00:00 GMT';
  // Drop the native runtime stub so the web-path tests aren't seen as native.
  delete (window as unknown as { Capacitor?: unknown }).Capacitor;
});

describe('useAuth', () => {
  it('mints an access token from the session on mount', async () => {
    setFetch((url) =>
      url.endsWith('/api/authenticate/refresh')
        ? jsonResponse({ accessToken: 'refreshed' })
        : emptyResponse(),
    );

    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => expect(result.current[0].authToken).toBe('refreshed'));
    expect(result.current[0].loading).toBe(false);
    expect(result.current[0].expired).toBe(false);
  });

  it('stays logged out when there is no valid session', async () => {
    setFetch((url) =>
      url.endsWith('/api/authenticate/refresh') ? emptyResponse(false, 401) : emptyResponse(),
    );

    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => expect(result.current[0].loading).toBe(false));
    expect(result.current[0].authToken).toBeNull();
    expect(result.current[0].expired).toBe(true); // no token decodes as expired
  });

  it('logs in, sending the CSRF token from the cookie', async () => {
    document.cookie = 'csrfToken=csrf-abc';

    const fetchMock = setFetch((url) => {
      if (url.endsWith('/api/authenticate/refresh')) {
        return emptyResponse(false, 401);
      }

      if (url.endsWith('/api/authenticate/csrf')) {
        return emptyResponse();
      }

      if (url.endsWith('/api/authenticate')) {
        return jsonResponse({ accessToken: 'logged-in' });
      }

      return emptyResponse();
    });

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current[0].loading).toBe(false));

    await act(async () => {
      await result.current[1].login('jsmith@example.com', 'pw');
    });

    expect(result.current[0].authToken).toBe('logged-in');
    expect(result.current[0].error).toBeNull();

    const authCall = fetchMock.mock.calls.find(([input]) => String(input).endsWith('/api/authenticate'));
    expect(authCall?.[1]?.headers).toMatchObject({ 'X-CSRF-Token': 'csrf-abc' });
  });

  it('native: logs in cookie-less — body CSRF token, credentials:omit, and mints an API key', async () => {
    // Simulate the Capacitor native runtime: isNativePlatform() → true, plus a keystore.
    // In the cross-origin webview the SameSite CSRF cookie can't be used, so the token
    // must come from the response body and the request must not be credentialed.
    const secureStore = new Map<string, string>();
    (window as unknown as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => true,
      Plugins: {
        SecureStoragePlugin: {
          get: vi.fn(async ({ key }: { key: string }) => {
            if (!secureStore.has(key)) {
              throw new Error('not found'); // no stored key on mount → logged out
            }

            return { value: secureStore.get(key) };
          }),
          set: vi.fn(async ({ key, value }: { key: string; value: string }) => {
            secureStore.set(key, value);

            return { value: true };
          }),
          remove: vi.fn(async () => ({ value: true })),
        },
      },
    };

    const fetchMock = setFetch((url) => {
      if (url.endsWith('/api/authenticate/csrf')) {
        return jsonBodyResponse({ csrfToken: 'native-csrf' });
      }

      if (url.endsWith('/api/authenticate')) {
        return jsonResponse({ accessToken: 'native-jwt' });
      }

      if (url.endsWith('/api/keys')) {
        return jsonResponse({ id: 'key-1', key: 'stored-api-key' });
      }

      return emptyResponse();
    });

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current[0].loading).toBe(false));

    await act(async () => {
      await result.current[1].login('jsmith@example.com', 'pw');
    });

    // Authenticated via the native API key (no JWT lands in authToken on native).
    expect(result.current[0].authenticated).toBe(true);
    expect(result.current[0].error).toBeNull();

    // CSRF token came from the body (not the cookie) and rode as the header; the request
    // was NOT credentialed, so it doesn't require Access-Control-Allow-Credentials.
    const authCall = fetchMock.mock.calls.find(([input]) => String(input).endsWith('/api/authenticate'));
    expect(authCall?.[1]?.headers).toMatchObject({ 'X-CSRF-Token': 'native-csrf' });
    expect(authCall?.[1]?.credentials).toBe('omit');

    // The JWT was traded for a durable API key, minted via /api/keys and stored.
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith('/api/keys'))).toBe(true);
    expect(secureStore.get('ci.apiKey')).toBe('stored-api-key');
  });

  it('captures the error when login fails', async () => {
    setFetch((url) => {
      if (url.endsWith('/api/authenticate/refresh')) {
        return emptyResponse(false, 401);
      }

      if (url.endsWith('/api/authenticate/csrf')) {
        return emptyResponse();
      }

      if (url.endsWith('/api/authenticate')) {
        return emptyResponse(false, 401);
      }

      return emptyResponse();
    });

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current[0].loading).toBe(false));

    await act(async () => {
      await result.current[1].login('jsmith@example.com', 'wrong');
    });

    expect(result.current[0].authToken).toBeNull();
    expect(result.current[0].error).toBeTruthy();
  });

  it('drops a login error when the user navigates to another page', async () => {
    // This state lives in a provider above the router, so a rejected login used
    // to follow the user: failing on /login left "Invalid credentials" on the
    // signup form they moved to next, above fields they had not submitted.
    setFetch((url) => {
      if (url.endsWith('/api/authenticate/refresh')) {
        return emptyResponse(false, 401);
      }

      if (url.endsWith('/api/authenticate/csrf')) {
        return emptyResponse();
      }

      if (url.endsWith('/api/authenticate')) {
        return emptyResponse(false, 401);
      }

      return emptyResponse();
    });

    const { result } = renderHook(() => ({ auth: useAuth(), navigate: useNavigate() }), {
      wrapper: ({ children }: { children: ReactNode }) => (
        <MemoryRouter initialEntries={['/login']}>
          <AuthProvider args={[]}>{children}</AuthProvider>
        </MemoryRouter>
      ),
    });

    await waitFor(() => expect(result.current.auth[0].loading).toBe(false));

    await act(async () => {
      await result.current.auth[1].login('jsmith@example.com', 'wrong');
    });

    expect(result.current.auth[0].error).toBeTruthy();

    await act(async () => {
      result.current.navigate('/signup');
    });

    await waitFor(() => expect(result.current.auth[0].error).toBeNull());
  });

  it('logs out, clearing the token and calling the logout endpoint', async () => {
    const fetchMock = setFetch((url) => {
      if (url.endsWith('/api/authenticate/refresh')) {
        return jsonResponse({ accessToken: 'live' });
      }

      return emptyResponse();
    });

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current[0].authToken).toBe('live'));

    await act(async () => {
      await result.current[1].logout();
    });

    expect(result.current[0].authToken).toBeNull();
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith('/api/authenticate/logout'))).toBe(
      true,
    );
  });

  it('re-primes and retries logout once on a 403 so the server session is torn down', async () => {
    // Logout is CsrfGuard-protected, so a stale/dropped csrf cookie 403s and the
    // server-side invalidateSession + cookie clears are skipped — leaving a live
    // 7-day session behind a logged-out UI. Priming + one retry recovers it.
    document.cookie = 'csrfToken=stale-token';
    let logoutCalls = 0;

    const fetchMock = setFetch((url) => {
      if (url.endsWith('/api/authenticate/refresh')) {
        return jsonResponse({ accessToken: 'live' });
      }

      if (url.endsWith('/api/authenticate/logout')) {
        logoutCalls += 1;

        return logoutCalls === 1 ? emptyResponse(false, 403) : emptyResponse();
      }

      return emptyResponse();
    });

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current[0].authToken).toBe('live'));

    await act(async () => {
      await result.current[1].logout();
    });

    expect(logoutCalls).toBe(2);
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith('/api/authenticate/csrf'))).toBe(
      true,
    );
    expect(result.current[0].authToken).toBeNull();
  });

  it('does not retry logout when re-priming failed, but still clears local state', async () => {
    // A failed prime leaves the same stale token in place; retrying would re-send
    // the byte-identical request for a certain second 403. The client still tears
    // down its own state so the UI does not strand the user "logged in".
    document.cookie = 'csrfToken=stale-token';
    let logoutCalls = 0;

    setFetch((url) => {
      if (url.endsWith('/api/authenticate/refresh')) {
        return jsonResponse({ accessToken: 'live' });
      }

      if (url.endsWith('/api/authenticate/logout')) {
        logoutCalls += 1;

        return emptyResponse(false, 403);
      }

      if (url.endsWith('/api/authenticate/csrf')) {
        return emptyResponse(false, 503);
      }

      return emptyResponse();
    });

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current[0].authToken).toBe('live'));

    await act(async () => {
      await result.current[1].logout();
    });

    expect(logoutCalls).toBe(1);
    expect(result.current[0].authToken).toBeNull();
  });

  it('reports an expired token from its decoded exp', async () => {
    vi.mocked(jwtDecode).mockReturnValue({ sub: 'u1', iat: 0, exp: pastExp() });
    setFetch((url) =>
      url.endsWith('/api/authenticate/refresh') ? jsonResponse({ accessToken: 'stale' }) : emptyResponse(),
    );

    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => expect(result.current[0].authToken).toBe('stale'));
    expect(result.current[0].expired).toBe(true);
  });

  it('primes the csrf cookie before the mount refresh when the cookie is absent', async () => {
    // A browser restart used to strand a valid session behind a missing csrf
    // cookie ("Missing CSRF token" 403 → forced re-login). Priming first (the
    // endpoint reuses a valid cookie, so this is always safe) closes that gap.
    const fetchMock = setFetch((url) =>
      url.endsWith('/api/authenticate/refresh')
        ? jsonResponse({ accessToken: 'refreshed' })
        : emptyResponse(),
    );

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current[0].authToken).toBe('refreshed'));

    const urls = fetchMock.mock.calls.map(([input]) => String(input));
    const csrfIndex = urls.findIndex((url) => url.endsWith('/api/authenticate/csrf'));
    const refreshIndex = urls.findIndex((url) => url.endsWith('/api/authenticate/refresh'));
    expect(csrfIndex).toBeGreaterThanOrEqual(0);
    expect(csrfIndex).toBeLessThan(refreshIndex);
  });

  it('retries a 403 refresh exactly once after re-priming the csrf cookie', async () => {
    // A stale/invalid csrf token (e.g. signed with a rotated server secret)
    // 403s; the server's ensure endpoint replaces it, and one retry recovers
    // without bouncing the user to login.
    document.cookie = 'csrfToken=stale-token';
    let refreshCalls = 0;

    const fetchMock = setFetch((url) => {
      if (url.endsWith('/api/authenticate/refresh')) {
        refreshCalls += 1;

        return refreshCalls === 1 ? emptyResponse(false, 403) : jsonResponse({ accessToken: 'recovered' });
      }

      return emptyResponse();
    });

    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => expect(result.current[0].authToken).toBe('recovered'));
    expect(refreshCalls).toBe(2);
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith('/api/authenticate/csrf'))).toBe(
      true,
    );
  });

  it('does not retry a 403 refresh when re-priming the csrf cookie failed', async () => {
    // A failed prime leaves the same stale token in place, so retrying would
    // re-send a byte-identical request, burn the one-shot budget on a certain
    // second 403, and log the user out for no reason.
    document.cookie = 'csrfToken=stale-token';
    let refreshCalls = 0;

    setFetch((url) => {
      if (url.endsWith('/api/authenticate/refresh')) {
        refreshCalls += 1;

        return emptyResponse(false, 403);
      }

      if (url.endsWith('/api/authenticate/csrf')) {
        return emptyResponse(false, 503);
      }

      return emptyResponse();
    });

    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => expect(result.current[0].loading).toBe(false));
    expect(refreshCalls).toBe(1);
    expect(result.current[0].authToken).toBeNull();
  });

  it('does not retry a 401 refresh (invalid session must fall through to login)', async () => {
    document.cookie = 'csrfToken=csrf-abc';
    let refreshCalls = 0;

    setFetch((url) => {
      if (url.endsWith('/api/authenticate/refresh')) {
        refreshCalls += 1;

        return emptyResponse(false, 401);
      }

      return emptyResponse();
    });

    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => expect(result.current[0].loading).toBe(false));
    expect(result.current[0].authToken).toBeNull();
    expect(refreshCalls).toBe(1);
  });
});
