import { type ReactNode } from 'react';

import {
  beginNativeOidcSignIn,
  getApiBaseUrl,
  getApiKey,
  needsNativeCloudConnect,
  setApiBaseUrl,
} from '@ci/common';
import { act, renderHook, waitFor } from '@testing-library/react';
import { jwtDecode } from 'jwt-decode';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { bindPowerSyncDatabase } from '@/api/powersync/session';

import { MEMORY_ANSWER_DEADLINE_MS } from './rememberedUser';
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

/** A request that is accepted and never answered: it ends only when its signal aborts, as a real fetch does. */
function hang(init?: RequestInit): Promise<Response> {
  return new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () =>
      reject(new DOMException('The operation was aborted.', 'AbortError')),
    );
  });
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
  sessionStorage.clear();
  localStorage.removeItem('ci.apiBaseUrl');
  localStorage.removeItem('ci.oidc.pendingNativeSignIn');
  setApiBaseUrl('');
  // Drop the native runtime stub so the web-path tests aren't seen as native.
  delete (window as unknown as { Capacitor?: unknown }).Capacitor;
  bindPowerSyncDatabase(null);
});

describe('useAuth', () => {
  it('replaces a stale Memory session when Hub forward-auth names someone else', async () => {
    const disconnect = vi.fn().mockResolvedValue(undefined);
    bindPowerSyncDatabase({
      disconnectAndClear: disconnect,
    } as never);

    setFetch((url) => {
      if (url.endsWith('/api/authenticate/hub-bridge')) {
        return jsonResponse({ accessToken: 'hello-token', replaced: true });
      }

      if (url.endsWith('/api/authenticate/refresh')) {
        return jsonResponse({ accessToken: 'should-not-use' });
      }

      return emptyResponse();
    });

    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => expect(result.current[0].authToken).toBe('hello-token'));
    expect(disconnect).toHaveBeenCalled();
  });

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
    expect(result.current[0].unreachable).toBe(false);
  });

  describe('when Memory does not answer the session check', () => {
    it('reports Memory unreachable instead of signed out, and signs in once it answers', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });

      try {
        let memoryUp = false;

        setFetch((url) => {
          if (url.endsWith('/api/authenticate/refresh')) {
            // The database is down: Memory (or the gateway) answers 500 / 502.
            return memoryUp ? jsonResponse({ accessToken: 'back' }) : emptyResponse(false, 502);
          }

          return emptyResponse();
        });

        const { result } = renderHook(() => useAuth(), { wrapper });

        await waitFor(() => expect(result.current[0].initializing).toBe(false));
        expect(result.current[0].unreachable).toBe(true);
        expect(result.current[0].authenticated).toBe(false);

        memoryUp = true;
        await act(async () => {
          await vi.advanceTimersByTimeAsync(5000);
        });

        await waitFor(() => expect(result.current[0].authToken).toBe('back'));
        expect(result.current[0].unreachable).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('treats a network failure the same way', async () => {
      setFetch((url) => {
        if (url.endsWith('/api/authenticate/refresh')) {
          throw new TypeError('Failed to fetch');
        }

        return emptyResponse();
      });

      const { result } = renderHook(() => useAuth(), { wrapper });

      await waitFor(() => expect(result.current[0].initializing).toBe(false));
      expect(result.current[0].unreachable).toBe(true);
    });

    it('keeps the token when a later refresh goes unanswered', async () => {
      document.cookie = 'csrfToken=csrf-abc';
      let refreshCalls = 0;

      setFetch((url) => {
        if (url.endsWith('/api/authenticate/refresh')) {
          refreshCalls += 1;

          return refreshCalls === 1
            ? jsonResponse({ accessToken: 'initial-token' })
            : emptyResponse(false, 500);
        }

        return emptyResponse();
      });

      const { result } = renderHook(() => useAuth(), { wrapper });
      await waitFor(() => expect(result.current[0].authToken).toBe('initial-token'));

      await act(async () => {
        await result.current[1].refresh();
      });

      expect(result.current[0].authToken).toBe('initial-token');
      expect(result.current[0].unreachable).toBe(true);
      expect(result.current[0].error).toBeNull();
    });
  });

  describe('when Memory takes the session check and never answers', () => {
    beforeEach(() => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('gives up at the deadline and reports Memory unreachable, not signed out', async () => {
      const fetchMock = setFetch((_url, init) => hang(init));

      const { result } = renderHook(() => useAuth(), { wrapper });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(MEMORY_ANSWER_DEADLINE_MS - 1000);
      });
      expect(result.current[0].initializing).toBe(true);
      expect(result.current[0].unreachable).toBe(false);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });

      expect(result.current[0].initializing).toBe(false);
      expect(result.current[0].unreachable).toBe(true);
      // A timeout is not an "expired session": no error for the login page to show.
      expect(result.current[0].error).toBeNull();
      // One deadline in all: the csrf prime timing out ends the check, so neither the Hub
      // bridge nor the refresh waits out a deadline of its own behind it.
      expect(fetchMock.mock.calls.map(([url]) => String(url))).toEqual(['/api/authenticate/csrf']);
    });

    it('waits out a slow Memory that answers within the deadline', async () => {
      let answer: (res: Response) => void = () => undefined;

      setFetch((url, init) => {
        if (url.endsWith('/api/authenticate/refresh')) {
          return new Promise<Response>((resolve) => {
            answer = resolve;
            init?.signal?.addEventListener('abort', () => undefined);
          });
        }

        return emptyResponse();
      });
      document.cookie = 'csrfToken=csrf-abc';

      const { result } = renderHook(() => useAuth(), { wrapper });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(MEMORY_ANSWER_DEADLINE_MS - 7000);
      });
      expect(result.current[0].unreachable).toBe(false);

      await act(async () => {
        answer(jsonResponse({ accessToken: 'slow' }));
        await vi.advanceTimersByTimeAsync(MEMORY_ANSWER_DEADLINE_MS);
      });

      expect(result.current[0].authToken).toBe('slow');
      expect(result.current[0].unreachable).toBe(false);
      expect(result.current[0].error).toBeNull();
    });

    it('signs in by itself once Memory answers again, asking once at a time meanwhile', async () => {
      let memoryUp = false;
      let refreshCalls = 0;

      const fetchMock = setFetch((url, init) => {
        if (url.endsWith('/api/authenticate/refresh')) {
          refreshCalls += 1;

          return memoryUp ? jsonResponse({ accessToken: 'back' }) : hang(init);
        }

        return url.endsWith('/api/authenticate/hub-bridge') && !memoryUp ? hang(init) : emptyResponse();
      });
      document.cookie = 'csrfToken=csrf-abc';

      const { result } = renderHook(() => useAuth(), { wrapper });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(MEMORY_ANSWER_DEADLINE_MS);
      });
      expect(result.current[0].unreachable).toBe(true);
      expect(refreshCalls).toBe(0);

      // The first retry hangs for a full deadline; the ticks during it send nothing more.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(MEMORY_ANSWER_DEADLINE_MS);
      });
      expect(refreshCalls).toBe(1);
      expect(result.current[0].unreachable).toBe(true);
      expect(result.current[0].authToken).toBeNull();

      memoryUp = true;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000);
      });

      expect(result.current[0].authToken).toBe('back');
      expect(result.current[0].unreachable).toBe(false);
      expect(fetchMock).toHaveBeenCalled();
    });

    it('keeps the token when a later refresh is never answered', async () => {
      document.cookie = 'csrfToken=csrf-abc';
      let refreshCalls = 0;

      setFetch((url, init) => {
        if (url.endsWith('/api/authenticate/refresh')) {
          refreshCalls += 1;

          return refreshCalls === 1 ? jsonResponse({ accessToken: 'initial-token' }) : hang(init);
        }

        return emptyResponse();
      });

      const { result } = renderHook(() => useAuth(), { wrapper });
      await waitFor(() => expect(result.current[0].authToken).toBe('initial-token'));

      await act(async () => {
        const refreshing = result.current[1].refresh();
        await vi.advanceTimersByTimeAsync(MEMORY_ANSWER_DEADLINE_MS);
        await refreshing;
      });

      expect(result.current[0].authToken).toBe('initial-token');
      expect(result.current[0].unreachable).toBe(true);
      expect(result.current[0].error).toBeNull();
    });
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

    // Minted at `full`, ASKED FOR rather than inherited.
    //
    // The app issues sixteen of the schema's destructive mutations, and
    // `capabilityAllows` refuses all of them below `full`. It worked at the
    // inherited `write` only because the GraphQL plane asks about capability
    // nowhere — the gap CI-Server#1780 closes. Enforcing that without this would
    // 403 deletes on every phone, and a phone cannot promote its own key
    // (`/api/keys` is JwtOrPortalAuthGuard, "never an api key"). So this
    // assertion is the ordering constraint, not a preference.
    const keyCall = fetchMock.mock.calls.find(([input]) => String(input).endsWith('/api/keys'));
    expect(JSON.parse(String(keyCall?.[1]?.body))).toMatchObject({ capability: 'full' });
    // Tagged as this device's sign-in key, which a password change and "Sign out
    // everywhere" revoke.
    expect(JSON.parse(String(keyCall?.[1]?.body))).toMatchObject({ sign_in: true });

    // Recorded, so a key minted before this change is distinguishable from one
    // that asked. Absent here would mean "legacy, upgrade at next sign-in".
    expect(secureStore.get('ci.apiKeyCapability')).toBe('full');
  });

  it('completePortalMemoryConnect mints a Memory API key from a portal bearer', async () => {
    const secureStore = new Map<string, string>();
    (window as unknown as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => true,
      Plugins: {
        SecureStoragePlugin: {
          get: vi.fn(async ({ key }: { key: string }) => {
            if (!secureStore.has(key)) {
              throw new Error('not found');
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
      if (url.endsWith('/api/keys')) {
        // The picked origin must not be live until the new key exists, or `me`
        // races the mint and the previous box's key is what demo1 rejects.
        expect(getApiBaseUrl()).not.toBe('https://memory.example.com');

        return jsonResponse({ id: 'key-portal', key: 'portal-minted-key' });
      }

      return emptyResponse();
    });

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current[0].loading).toBe(false));

    let ok = false;
    await act(async () => {
      ok = await result.current[1].completePortalMemoryConnect(
        'portal-id-token',
        'https://memory.example.com',
      );
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://memory.example.com/api/keys',
      expect.objectContaining({ method: 'POST' }),
    );

    expect(ok).toBe(true);
    expect(result.current[0].authenticated).toBe(true);
    expect(secureStore.get('ci.apiKey')).toBe('portal-minted-key');
    expect(localStorage.getItem('ci.apiBaseUrl')).toBe('https://memory.example.com');
  });

  it('completePortalMemoryConnect does not persist a Memory origin when minting fails', async () => {
    (window as unknown as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => true,
      Plugins: {
        SecureStoragePlugin: {
          get: vi.fn(async () => {
            throw new Error('not found');
          }),
          set: vi.fn(async () => ({ value: true })),
          remove: vi.fn(async () => ({ value: true })),
        },
      },
    };

    setFetch(() => emptyResponse(false, 401));

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current[0].loading).toBe(false));

    await act(async () => {
      await expect(
        result.current[1].completePortalMemoryConnect('portal-id-token', 'https://memory.example.com'),
      ).rejects.toThrow();
    });

    expect(localStorage.getItem('ci.apiBaseUrl')).toBeNull();
    expect(result.current[0].authenticated).toBe(false);
  });

  it('completeMemoryPasswordConnect signs in to the picked Memory origin and mints a key', async () => {
    const secureStore = new Map<string, string>();
    (window as unknown as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => true,
      Plugins: {
        SecureStoragePlugin: {
          get: vi.fn(async ({ key }: { key: string }) => {
            if (!secureStore.has(key)) {
              throw new Error('not found');
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
        return jsonResponse({ accessToken: 'memory-jwt' });
      }

      if (url.endsWith('/api/keys')) {
        return jsonResponse({ id: 'key-pw', key: 'password-minted-key' });
      }

      return emptyResponse();
    });

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current[0].loading).toBe(false));

    let ok = false;
    await act(async () => {
      ok = await result.current[1].completeMemoryPasswordConnect(
        'me@example.com',
        'memory-secret',
        'https://memory.example.com',
      );
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://memory.example.com/api/authenticate',
      expect.objectContaining({ method: 'POST', credentials: 'omit' }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      'https://memory.example.com/api/keys',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(ok).toBe(true);
    expect(result.current[0].authenticated).toBe(true);
    expect(secureStore.get('ci.apiKey')).toBe('password-minted-key');
    expect(localStorage.getItem('ci.apiBaseUrl')).toBe('https://memory.example.com');
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
    // A browser has no capture queue, so web sign-out never stops to ask about one.
    expect(result.current[0].signOutPrompt.open).toBe(false);
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/api/outbox'))).toBe(false);
  });

  it('native logout forgets the paired Memory origin so the next account can pick a device', async () => {
    const secureStore = new Map<string, string>([
      ['ci.apiKey', 'stored-api-key'],
      ['ci.apiBaseUrl', 'https://core7.example.com'],
    ]);
    (window as unknown as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => 'ios',
      Plugins: {
        SecureStoragePlugin: {
          get: vi.fn(async ({ key }: { key: string }) => {
            if (!secureStore.has(key)) {
              throw new Error('not found');
            }

            return { value: secureStore.get(key) };
          }),
          set: vi.fn(async ({ key, value }: { key: string; value: string }) => {
            secureStore.set(key, value);

            return { value: true };
          }),
          remove: vi.fn(async ({ key }: { key: string }) => {
            secureStore.delete(key);

            return { value: true };
          }),
        },
      },
    };

    setFetch(() => emptyResponse());
    // Only the keystore has the origin, so restoring it asks first.
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current[0].authenticated).toBe(true));
    expect(getApiBaseUrl()).toBe('https://core7.example.com');

    await act(async () => {
      await result.current[1].logout();
    });

    expect(result.current[0].authenticated).toBe(false);
    expect(getApiBaseUrl()).toBe('');
    expect(localStorage.getItem('ci.apiBaseUrl')).toBeNull();
    expect(secureStore.has('ci.apiBaseUrl')).toBe(false);
    expect(secureStore.has('ci.apiKey')).toBe(false);
    expect(needsNativeCloudConnect()).toBe(true);
  });

  describe('native: the Memory origin the app paired with', () => {
    /** A phone whose credential store (the LocalHub plugin) starts with `entries`. */
    function nativeWithStore(entries: [string, string][]) {
      const secureStore = new Map(entries);
      (window as unknown as { Capacitor?: unknown }).Capacitor = {
        isNativePlatform: () => true,
        getPlatform: () => 'android',
        Plugins: {
          LocalHub: {
            secureGet: vi.fn(async ({ key }: { key: string }) => ({ value: secureStore.get(key) ?? null })),
            secureSet: vi.fn(async ({ key, value }: { key: string; value: string }) => {
              secureStore.set(key, value);
            }),
            secureRemove: vi.fn(async ({ key }: { key: string }) => {
              secureStore.delete(key);
            }),
          },
        },
      };

      return secureStore;
    }

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('keeps the paired origin when the keystore copy disagrees, and repairs the copy', async () => {
      localStorage.setItem('ci.apiBaseUrl', 'https://paired.example.com');
      setApiBaseUrl('https://paired.example.com');
      const secureStore = nativeWithStore([
        ['ci.apiKey', 'stored-api-key'],
        // Written through the plugin by something other than the pairing flow.
        ['ci.apiBaseUrl', 'https://elsewhere.example.net'],
      ]);
      const confirm = vi.spyOn(window, 'confirm');
      setFetch(() => emptyResponse());

      const { result } = renderHook(() => useAuth(), { wrapper });
      await waitFor(() => expect(result.current[0].authenticated).toBe(true));

      expect(getApiBaseUrl()).toBe('https://paired.example.com');
      expect(localStorage.getItem('ci.apiBaseUrl')).toBe('https://paired.example.com');
      await waitFor(() => expect(secureStore.get('ci.apiBaseUrl')).toBe('https://paired.example.com'));
      expect(confirm).not.toHaveBeenCalled();
    });

    it('asks before taking an origin only the keystore has, and drops the credential when declined', async () => {
      const secureStore = nativeWithStore([
        ['ci.apiKey', 'stored-api-key'],
        ['ci.apiKeyId', 'key-id'],
        ['ci.apiBaseUrl', 'https://unknown.example.net'],
      ]);
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
      setFetch(() => emptyResponse());

      const { result } = renderHook(() => useAuth(), { wrapper });
      await waitFor(() => expect(result.current[0].initializing).toBe(false));

      expect(confirm).toHaveBeenCalledWith(expect.stringContaining('https://unknown.example.net'));
      expect(result.current[0].authenticated).toBe(false);
      expect(getApiBaseUrl()).toBe('');
      expect(localStorage.getItem('ci.apiBaseUrl')).toBeNull();
      expect(secureStore.has('ci.apiBaseUrl')).toBe(false);
      expect(secureStore.has('ci.apiKey')).toBe(false);
      expect(secureStore.has('ci.apiKeyId')).toBe(false);
    });

    it('does not offer an origin the keystore holds without a key, and drops it', async () => {
      // What a sign-out leaves when it is cut short after the key went but before the origin.
      const secureStore = nativeWithStore([['ci.apiBaseUrl', 'https://previous.example.net']]);
      const confirm = vi.spyOn(window, 'confirm');
      setFetch(() => emptyResponse());

      const { result } = renderHook(() => useAuth(), { wrapper });
      await waitFor(() => expect(result.current[0].initializing).toBe(false));

      expect(confirm).not.toHaveBeenCalled();
      expect(result.current[0].authenticated).toBe(false);
      expect(localStorage.getItem('ci.apiBaseUrl')).toBeNull();
      expect(secureStore.has('ci.apiBaseUrl')).toBe(false);
    });

    it('drops a keystore origin that is not an http(s) address without showing it', async () => {
      // Pairing never stores this; text written to read as part of the question did.
      const secureStore = nativeWithStore([
        ['ci.apiKey', 'stored-api-key'],
        ['ci.apiBaseUrl', 'https://unknown.example.net\n\nThis is your usual Memory. Tap OK.'],
      ]);
      const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
      setFetch(() => emptyResponse());

      const { result } = renderHook(() => useAuth(), { wrapper });
      await waitFor(() => expect(result.current[0].initializing).toBe(false));

      expect(confirm).not.toHaveBeenCalled();
      expect(result.current[0].authenticated).toBe(false);
      expect(localStorage.getItem('ci.apiBaseUrl')).toBeNull();
      expect(secureStore.has('ci.apiBaseUrl')).toBe(false);
      expect(secureStore.has('ci.apiKey')).toBe(false);
    });
  });

  describe('native logout and the Local Hub outbox', () => {
    const HUB = 'http://127.0.0.1:4100';

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('uploads what this account queued while its key is still active, then deletes the rest', async () => {
      localStorage.setItem('ci.apiBaseUrl', 'https://core7.example.com');
      setApiBaseUrl('https://core7.example.com');
      const secureStore = new Map([
        ['ci.apiKey', 'outgoing-key'],
        ['ci.apiBaseUrl', 'https://core7.example.com'],
      ]);
      (window as unknown as { Capacitor?: unknown }).Capacitor = {
        isNativePlatform: () => true,
        getPlatform: () => 'android',
        Plugins: {
          LocalHub: {
            start: vi.fn(async () => ({ baseUrl: HUB, token: 'hub-token' })),
            secureGet: vi.fn(async ({ key }: { key: string }) => ({ value: secureStore.get(key) ?? null })),
            secureSet: vi.fn(async ({ key, value }: { key: string; value: string }) => {
              secureStore.set(key, value);
            }),
            secureRemove: vi.fn(async ({ key }: { key: string }) => {
              secureStore.delete(key);
            }),
          },
        },
      };

      // One note queued offline, stamped for nobody in particular (an older build).
      let queued = true;
      const seen: { url: string; method: string; apiKey: string | null; keyAfterwards: string | null }[] = [];
      setFetch((url, init) => {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        seen.push({
          url,
          method: (init?.method ?? 'GET').toUpperCase(),
          apiKey: headers['x-api-key'] ?? null,
          keyAfterwards: 'not checked',
        });
        const path = url.startsWith(HUB) ? url.slice(HUB.length) : url;

        if ((path === '/api/outbox?status=pending' || path === '/api/outbox') && init?.method !== 'DELETE') {
          return jsonResponse({
            items: queued
              ? [
                  {
                    id: 'n1',
                    kind: 'note',
                    capturedAt: '2026-10-01T00:00:00Z',
                    seq: 1,
                    status: 'pending',
                    attempts: 0,
                    lastError: null,
                    owner: null,
                  },
                ]
              : [],
            counts: { pending: queued ? 1 : 0, needsAttention: 0, total: queued ? 1 : 0 },
            capacity: { max: 5000, used: 0, warnAt: 4000 },
          });
        }

        if (path === '/api/outbox/n1') {
          return jsonResponse({
            id: 'n1',
            kind: 'note',
            capturedAt: '2026-10-01T00:00:00Z',
            seq: 1,
            status: 'pending',
            attempts: 0,
            lastError: null,
            owner: null,
            payload: { records: [] },
          });
        }

        if (path === '/api/outbox/n1/attempt') {
          queued = false;

          return emptyResponse(true, 204);
        }

        if (path === '/api/outbox' && init?.method === 'DELETE') {
          seen[seen.length - 1].keyAfterwards = getApiKey();

          return jsonResponse({ deleted: 0 });
        }

        return emptyResponse();
      });

      const { result } = renderHook(() => useAuth(), { wrapper });
      await waitFor(() => expect(result.current[0].authenticated).toBe(true));

      await act(async () => {
        await result.current[1].logout();
      });

      const upload = seen.find((call) => call.url === 'https://core7.example.com/api/v1/notes');
      const clear = seen.find((call) => call.url === `${HUB}/api/outbox` && call.method === 'DELETE');

      expect(upload?.apiKey).toBe('outgoing-key');
      expect(clear).toBeDefined();
      // The clear runs once the key is gone, so nothing queued afterwards survives either.
      expect(clear?.keyAfterwards).toBeNull();
      expect(seen.indexOf(upload!)).toBeLessThan(seen.indexOf(clear!));
      expect(result.current[0].authenticated).toBe(false);
      // The upload emptied the queue, so there was nothing to ask about.
      expect(result.current[0].signOutPrompt.open).toBe(false);
    });

    it('signs out without asking when the caller already covered the unsent captures', async () => {
      // Account deletion: the key stops working, so the captures can never upload.
      localStorage.setItem('ci.apiBaseUrl', 'https://core7.example.com');
      setApiBaseUrl('https://core7.example.com');
      const secureStore = new Map([
        ['ci.apiKey', 'outgoing-key'],
        ['ci.apiBaseUrl', 'https://core7.example.com'],
      ]);
      (window as unknown as { Capacitor?: unknown }).Capacitor = {
        isNativePlatform: () => true,
        getPlatform: () => 'android',
        Plugins: {
          LocalHub: {
            start: vi.fn(async () => ({ baseUrl: HUB, token: 'hub-token' })),
            secureGet: vi.fn(async ({ key }: { key: string }) => ({ value: secureStore.get(key) ?? null })),
            secureSet: vi.fn(async ({ key, value }: { key: string; value: string }) => {
              secureStore.set(key, value);
            }),
            secureRemove: vi.fn(async ({ key }: { key: string }) => {
              secureStore.delete(key);
            }),
          },
        },
      };
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      const pendingRow = {
        id: 'n1',
        kind: 'note',
        capturedAt: '2026-10-01T00:00:00Z',
        seq: 1,
        status: 'pending',
        attempts: 0,
        lastError: null,
        owner: null,
      };
      let cleared = false;
      const fetchMock = setFetch((url, init) => {
        const path = url.startsWith(HUB) ? url.slice(HUB.length) : url;

        if (path === '/api/outbox?status=pending' || path === '/api/outbox') {
          if (init?.method === 'DELETE') {
            cleared = true;

            return jsonResponse({ deleted: 1 });
          }

          return jsonResponse({
            items: [pendingRow],
            counts: { pending: 1, needsAttention: 0, total: 1 },
            capacity: { max: 5000, used: 1, warnAt: 4000 },
          });
        }

        if (path === '/api/outbox/n1') {
          return jsonResponse({ ...pendingRow, payload: { records: [] } });
        }

        // The account is gone: the appliance refuses this key.
        return emptyResponse(false, 401);
      });

      const { result } = renderHook(() => useAuth(), { wrapper });
      await waitFor(() => expect(result.current[0].authenticated).toBe(true));

      await act(async () => {
        await result.current[1].logout({ discardUnsentCaptures: true });
      });

      expect(result.current[0].signOutPrompt.open).toBe(false);
      expect(result.current[0].authenticated).toBe(false);
      expect(cleared).toBe(true);
      expect(secureStore.has('ci.apiKey')).toBe(false);
      expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith('/api/keys/current'))).toBe(true);
      // No last upload either: every request would carry a key the deleted account no longer has.
      expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith('/api/v1/notes'))).toBe(false);
    });

    it('runs one sign-out when Log out is tapped again while the first is still going', async () => {
      localStorage.setItem('ci.apiBaseUrl', 'https://core7.example.com');
      setApiBaseUrl('https://core7.example.com');
      const secureStore = new Map([
        ['ci.apiKey', 'outgoing-key'],
        ['ci.apiBaseUrl', 'https://core7.example.com'],
      ]);
      (window as unknown as { Capacitor?: unknown }).Capacitor = {
        isNativePlatform: () => true,
        getPlatform: () => 'android',
        Plugins: {
          LocalHub: {
            start: vi.fn(async () => ({ baseUrl: HUB, token: 'hub-token' })),
            secureGet: vi.fn(async ({ key }: { key: string }) => ({ value: secureStore.get(key) ?? null })),
            secureSet: vi.fn(async ({ key, value }: { key: string; value: string }) => {
              secureStore.set(key, value);
            }),
            secureRemove: vi.fn(async ({ key }: { key: string }) => {
              secureStore.delete(key);
            }),
          },
        },
      };

      const fetchMock = setFetch((url, init) => {
        const path = url.startsWith(HUB) ? url.slice(HUB.length) : url;

        if (path === '/api/outbox' && init?.method === 'DELETE') {
          return jsonResponse({ deleted: 0 });
        }

        if (path === '/api/outbox?status=pending' || path === '/api/outbox') {
          return jsonResponse({
            items: [],
            counts: { pending: 0, needsAttention: 0, total: 0 },
            capacity: { max: 5000, used: 0, warnAt: 4000 },
          });
        }

        return emptyResponse();
      });

      const { result } = renderHook(() => useAuth(), { wrapper });
      await waitFor(() => expect(result.current[0].authenticated).toBe(true));

      await act(async () => {
        const first = result.current[1].logout();
        const second = result.current[1].logout();

        expect(second).toBe(first);
        await Promise.all([first, second]);
      });

      const revokes = fetchMock.mock.calls.filter(([input]) => String(input).endsWith('/api/keys/current'));
      expect(revokes).toHaveLength(1);
      expect(result.current[0].authenticated).toBe(false);
    });
  });

  it('still logs out when dropping the local PowerSync replica fails', async () => {
    // Both the clear and its disconnect fallback reject; logout must not be
    // sequenced behind a teardown that cannot complete.
    bindPowerSyncDatabase({
      disconnectAndClear: vi.fn().mockRejectedValue(new Error('worker never came up')),
      disconnect: vi.fn().mockRejectedValue(new Error('worker never came up')),
    } as never);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const fetchMock = setFetch((url) => {
      if (url.endsWith('/api/authenticate/refresh')) {
        return jsonResponse({ accessToken: 'live' });
      }

      return emptyResponse();
    });

    try {
      const { result } = renderHook(() => useAuth(), { wrapper });
      await waitFor(() => expect(result.current[0].authToken).toBe('live'));

      await act(async () => {
        await result.current[1].logout();
      });

      expect(result.current[0].authToken).toBeNull();
      expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith('/api/authenticate/logout'))).toBe(
        true,
      );
    } finally {
      bindPowerSyncDatabase(null);
    }
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

  it('repairs a 401 refresh through Hub identity without repeating the rejected refresh', async () => {
    document.cookie = 'csrfToken=csrf-abc';
    let refreshCalls = 0;
    let bridgeCalls = 0;
    const disconnect = vi.fn().mockResolvedValue(undefined);
    bindPowerSyncDatabase({ disconnectAndClear: disconnect } as never);

    setFetch((url) => {
      if (url.endsWith('/api/authenticate/refresh')) {
        refreshCalls += 1;

        return refreshCalls === 1
          ? jsonResponse({ accessToken: 'initial-token' })
          : emptyResponse(false, 401);
      }

      if (url.endsWith('/api/authenticate/hub-bridge')) {
        bridgeCalls += 1;

        return bridgeCalls === 1
          ? emptyResponse()
          : jsonResponse({ accessToken: 'recovered-token', replaced: true });
      }

      return emptyResponse();
    });

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current[0].authToken).toBe('initial-token'));

    await act(async () => {
      await result.current[1].refresh();
    });

    expect(result.current[0].authToken).toBe('recovered-token');
    expect(result.current[0].error).toBeNull();
    expect(refreshCalls).toBe(2);
    expect(bridgeCalls).toBe(2);
    // Both JWTs decode to the same subject in this test, so its replica stays intact.
    expect(disconnect).not.toHaveBeenCalled();
  });

  it('logs out after a 401 when Hub identity cannot repair the session', async () => {
    document.cookie = 'csrfToken=csrf-abc';
    let refreshCalls = 0;

    setFetch((url) => {
      if (url.endsWith('/api/authenticate/refresh')) {
        refreshCalls += 1;

        return refreshCalls === 1
          ? jsonResponse({ accessToken: 'initial-token' })
          : emptyResponse(false, 401);
      }

      return emptyResponse();
    });

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current[0].authToken).toBe('initial-token'));

    await act(async () => {
      await result.current[1].refresh();
    });

    expect(result.current[0].authToken).toBeNull();
    expect(result.current[0].error).toBeTruthy();
    expect(refreshCalls).toBe(2);
  });

  it('iOS: finishes Memory OIDC from getLaunchUrl after a Safari cold start', async () => {
    // What the sign-in button kept before it opened the browser.
    const { appState } = await beginNativeOidcSignIn();
    const verifier = (
      JSON.parse(localStorage.getItem('ci.oidc.pendingNativeSignIn')!) as { verifier: string }
    ).verifier;
    const getLaunchUrl = vi.fn(async () => ({
      url: `companion://oidc/callback?code=otc-ios&state=${appState}`,
    }));
    const addListener = vi.fn(async () => ({ remove: async () => undefined }));
    const secureStore = new Map<string, string>();

    (window as unknown as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => 'ios',
      Plugins: {
        App: { getLaunchUrl, addListener },
        SecureStoragePlugin: {
          get: vi.fn(async ({ key }: { key: string }) => {
            if (!secureStore.has(key)) {
              throw new Error('not found');
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
      if (url.endsWith('/api/authenticate/oidc/native/exchange')) {
        return jsonResponse({ accessToken: 'native-jwt' });
      }

      if (url.endsWith('/api/keys')) {
        return jsonResponse({ id: 'key-1', key: 'stored-api-key' });
      }

      return emptyResponse();
    });

    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => expect(result.current[0].authenticated).toBe(true));
    expect(getLaunchUrl).toHaveBeenCalled();
    expect(addListener.mock.invocationCallOrder[0]!).toBeLessThan(getLaunchUrl.mock.invocationCallOrder[0]!);
    const exchange = fetchMock.mock.calls.find(([input]) =>
      String(input).endsWith('/api/authenticate/oidc/native/exchange'),
    );
    // The code alone redeems nothing: the verifier this app kept goes with it.
    expect(JSON.parse(String(exchange?.[1]?.body))).toEqual({ code: 'otc-ios', code_verifier: verifier });
    expect(secureStore.get('ci.apiKey')).toBe('stored-api-key');
    // Spent: the same state cannot complete a second sign-in.
    expect(localStorage.getItem('ci.oidc.pendingNativeSignIn')).toBeNull();
  });

  it('iOS: does not replay a consumed Memory OIDC code after remount', async () => {
    const { appState } = await beginNativeOidcSignIn();
    const getLaunchUrl = vi.fn(async () => ({
      url: `companion://oidc/callback?code=otc-replay&state=${appState}`,
    }));
    const addListener = vi.fn(async () => ({ remove: async () => undefined }));
    const secureStore = new Map<string, string>();

    (window as unknown as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => 'ios',
      Plugins: {
        App: { getLaunchUrl, addListener },
        SecureStoragePlugin: {
          get: vi.fn(async ({ key }: { key: string }) => {
            if (!secureStore.has(key)) {
              throw new Error('not found');
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

    let exchanges = 0;
    setFetch((url) => {
      if (url.endsWith('/api/authenticate/oidc/native/exchange')) {
        exchanges += 1;

        return jsonResponse({ accessToken: 'native-jwt' });
      }

      if (url.endsWith('/api/keys')) {
        return jsonResponse({ id: 'key-1', key: 'stored-api-key' });
      }

      return emptyResponse();
    });

    const first = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(first.result.current[0].authenticated).toBe(true));
    first.unmount();

    const second = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(second.result.current[0].authenticated).toBe(true));
    expect(exchanges).toBe(1);
  });

  it('Android: does not consume getLaunchUrl for Memory OIDC', async () => {
    const getLaunchUrl = vi.fn(async () => ({ url: 'companion://oidc/callback?code=otc-android' }));
    const addListener = vi.fn(async () => ({ remove: async () => undefined }));

    (window as unknown as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => 'android',
      Plugins: {
        App: { getLaunchUrl, addListener },
        SecureStoragePlugin: {
          get: vi.fn(async () => {
            throw new Error('not found');
          }),
          set: vi.fn(async () => ({ value: true })),
          remove: vi.fn(async () => ({ value: true })),
        },
      },
    };

    setFetch(() => emptyResponse());

    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => expect(result.current[0].loading).toBe(false));
    expect(getLaunchUrl).not.toHaveBeenCalled();
    expect(result.current[0].authenticated).toBe(false);
  });

  it('refreshes when a backgrounded tab becomes visible after the access token expires', async () => {
    let refreshCalls = 0;

    setFetch((url) => {
      if (url.endsWith('/api/authenticate/refresh')) {
        refreshCalls += 1;

        return jsonResponse({ accessToken: `tok-${refreshCalls}` });
      }

      return emptyResponse();
    });

    const { result } = renderHook(() => useAuth(), { wrapper });

    await waitFor(() => expect(result.current[0].authToken).toBe('tok-1'));
    expect(refreshCalls).toBe(1);

    // Only the token already in hand is expired. The refreshed token has to
    // decode as still-valid, or the scheduler treats delay 0 as "due now" and
    // refreshes in a loop.
    vi.mocked(jwtDecode).mockImplementation((token) => ({
      sub: 'u1',
      iat: 0,
      exp: token === 'tok-1' ? pastExp() : futureExp(),
    }));

    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    await waitFor(() => expect(refreshCalls).toBe(2));
  });

  describe('a sign-in link this app did not start', () => {
    /** An iOS shell whose cold-start URL is `url`, with an empty keystore. */
    function iosLaunchedWith(url: string) {
      const secureStore = new Map<string, string>();
      const getLaunchUrl = vi.fn(async () => ({ url }));

      (window as unknown as { Capacitor?: unknown }).Capacitor = {
        isNativePlatform: () => true,
        getPlatform: () => 'ios',
        Plugins: {
          App: { getLaunchUrl, addListener: vi.fn(async () => ({ remove: async () => undefined })) },
          SecureStoragePlugin: {
            get: vi.fn(async ({ key }: { key: string }) => {
              if (!secureStore.has(key)) {
                throw new Error('not found');
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
        if (url.endsWith('/api/authenticate/oidc/native/exchange')) {
          return jsonResponse({ accessToken: 'someone-elses-jwt' });
        }

        if (url.endsWith('/api/keys')) {
          return jsonResponse({ id: 'key-x', key: 'someone-elses-key' });
        }

        return emptyResponse();
      });

      return { getLaunchUrl, fetchMock, secureStore };
    }

    const exchanged = (fetchMock: ReturnType<typeof setFetch>) =>
      fetchMock.mock.calls.some(([input]) =>
        String(input).endsWith('/api/authenticate/oidc/native/exchange'),
      );

    it('ignores a code with no state: nothing is exchanged and no key is stored', async () => {
      const { getLaunchUrl, fetchMock, secureStore } = iosLaunchedWith(
        'companion://oidc/callback?code=sent-to-you',
      );

      const { result } = renderHook(() => useAuth(), { wrapper });

      await waitFor(() => expect(getLaunchUrl).toHaveBeenCalled());
      await waitFor(() => expect(result.current[0].loading).toBe(false));
      expect(exchanged(fetchMock)).toBe(false);
      expect(secureStore.has('ci.apiKey')).toBe(false);
      expect(result.current[0].authenticated).toBe(false);
    });

    it('ignores a code whose state is not the one this app sent, and keeps its own sign-in pending', async () => {
      await beginNativeOidcSignIn();
      const { getLaunchUrl, fetchMock } = iosLaunchedWith(
        'companion://oidc/callback?code=sent-to-you&state=someone-elses-state',
      );

      renderHook(() => useAuth(), { wrapper });

      await waitFor(() => expect(getLaunchUrl).toHaveBeenCalled());
      expect(exchanged(fetchMock)).toBe(false);
      // A stray link must not be able to cancel the sign-in the person is in the middle of.
      expect(localStorage.getItem('ci.oidc.pendingNativeSignIn')).not.toBeNull();
    });

    it('shows no error text from a link it did not ask for', async () => {
      const { getLaunchUrl } = iosLaunchedWith(
        'companion://oidc/callback?error=Your%20account%20is%20locked',
      );

      const { result } = renderHook(() => useAuth(), { wrapper });

      await waitFor(() => expect(getLaunchUrl).toHaveBeenCalled());
      await waitFor(() => expect(result.current[0].loading).toBe(false));
      expect(result.current[0].error).toBeNull();
    });

    it('tells the person an older appliance cannot finish their own sign-in, and still exchanges nothing', async () => {
      // An appliance from before the state echo answers with no state at all.
      await beginNativeOidcSignIn();
      const { getLaunchUrl, fetchMock } = iosLaunchedWith('companion://oidc/callback?code=from-old-server');

      const { result } = renderHook(() => useAuth(), { wrapper });

      await waitFor(() => expect(getLaunchUrl).toHaveBeenCalled());
      await waitFor(() =>
        expect((result.current[0].error as Error | null)?.message).toMatch(/This Memory needs an update/),
      );
      expect(exchanged(fetchMock)).toBe(false);
    });

    it("shows the error of this app's own sign-in", async () => {
      const { appState } = await beginNativeOidcSignIn();
      const { getLaunchUrl } = iosLaunchedWith(
        `companion://oidc/callback?error=signup_code_required&state=${appState}`,
      );

      const { result } = renderHook(() => useAuth(), { wrapper });

      await waitFor(() => expect(getLaunchUrl).toHaveBeenCalled());
      await waitFor(() => expect(result.current[0].error).toEqual(new Error('signup_code_required')));
    });
  });

  it('native logout revokes the device key on the server, while it still knows which server', async () => {
    // The origin this phone paired with, as the app's own pages saved it and `initApiBaseUrl`
    // applied it at launch.
    localStorage.setItem('ci.apiBaseUrl', 'https://core7.example.com');
    setApiBaseUrl('https://core7.example.com');
    const secureStore = new Map<string, string>([
      ['ci.apiKey', 'stored-api-key'],
      ['ci.apiBaseUrl', 'https://core7.example.com'],
    ]);
    (window as unknown as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => 'ios',
      Plugins: {
        SecureStoragePlugin: {
          get: vi.fn(async ({ key }: { key: string }) => {
            if (!secureStore.has(key)) {
              throw new Error('not found');
            }

            return { value: secureStore.get(key) };
          }),
          set: vi.fn(async ({ key, value }: { key: string; value: string }) => {
            secureStore.set(key, value);

            return { value: true };
          }),
          remove: vi.fn(async ({ key }: { key: string }) => {
            secureStore.delete(key);

            return { value: true };
          }),
        },
      },
    };

    const fetchMock = setFetch(() => emptyResponse(true, 204));

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current[0].authenticated).toBe(true));

    await act(async () => {
      await result.current[1].logout();
    });

    const revoke = fetchMock.mock.calls.find(([input]) => String(input).endsWith('/api/keys/current'));
    expect(revoke?.[0]).toBe('https://core7.example.com/api/keys/current');
    expect(revoke?.[1]?.method).toBe('DELETE');
    expect(revoke?.[1]?.headers).toMatchObject({ 'x-api-key': 'stored-api-key' });
    expect(result.current[0].authenticated).toBe(false);
    expect(secureStore.has('ci.apiKey')).toBe(false);
  });

  it('still signs out when the server cannot be reached to revoke the key', async () => {
    const secureStore = new Map<string, string>([['ci.apiKey', 'stored-api-key']]);
    (window as unknown as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => true,
      Plugins: {
        SecureStoragePlugin: {
          get: vi.fn(async ({ key }: { key: string }) => {
            if (!secureStore.has(key)) {
              throw new Error('not found');
            }

            return { value: secureStore.get(key) };
          }),
          set: vi.fn(async () => ({ value: true })),
          remove: vi.fn(async ({ key }: { key: string }) => {
            secureStore.delete(key);

            return { value: true };
          }),
        },
      },
    };
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Load failed'))),
    );

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current[0].authenticated).toBe(true));

    await act(async () => {
      await result.current[1].logout();
    });

    expect(result.current[0].authenticated).toBe(false);
    expect(secureStore.has('ci.apiKey')).toBe(false);
  });

  it('desktop logout revokes the stored key even though it was never loaded back into memory', async () => {
    // The desktop app keeps its key in this page's storage and does not load it on start, so
    // after a restart only the stored copy knows which key this device holds.
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: vi.fn(async () => null),
    };
    localStorage.setItem('ci.apiKey', 'desktop-stored-key');
    const fetchMock = setFetch(() => emptyResponse(true, 204));

    try {
      const { result } = renderHook(() => useAuth(), { wrapper });
      await waitFor(() => expect(result.current[0].initializing).toBe(false));

      await act(async () => {
        await result.current[1].logout();
      });

      const revoke = fetchMock.mock.calls.find(([input]) => String(input).endsWith('/api/keys/current'));
      expect(revoke?.[1]?.method).toBe('DELETE');
      expect(revoke?.[1]?.headers).toMatchObject({ 'x-api-key': 'desktop-stored-key' });
      expect(localStorage.getItem('ci.apiKey')).toBeNull();
    } finally {
      delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
      localStorage.removeItem('ci.apiKey');
    }
  });

  it('web logout revokes no key: a browser session holds none', async () => {
    const fetchMock = setFetch((url) =>
      url.endsWith('/api/authenticate/refresh') ? jsonResponse({ accessToken: 'live' }) : emptyResponse(),
    );

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current[0].authToken).toBe('live'));

    await act(async () => {
      await result.current[1].logout();
    });

    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith('/api/keys/current'))).toBe(false);
  });
});
