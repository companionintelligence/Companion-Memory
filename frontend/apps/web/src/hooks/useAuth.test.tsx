import { type ReactNode } from 'react';

import {
  apiKeyHeaders,
  beginNativeOidcSignIn,
  fetchJson,
  getApiBaseUrl,
  getApiKey,
  needsNativeCloudConnect,
  outboxOwnerStamp,
  setApiBaseUrl,
  setApiKey,
  syncNativeIntentConfig,
} from '@ci/common';
import { act, renderHook, waitFor } from '@testing-library/react';
import { jwtDecode } from 'jwt-decode';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { bindPowerSyncDatabase } from '@/api/powersync/session';
import {
  fakeDesktop,
  fakeLocalHub,
  installNativeShell,
  sentApiKeys,
  stampFor,
  tokenFor,
} from '@/test/fakeNativeDeviceKey';

import { DeviceKeyNotSavedError } from './deviceKeyNotSaved';
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
  // Drop the native and desktop runtime stubs so the web-path tests aren't seen as native.
  delete (window as unknown as { Capacitor?: unknown }).Capacitor;
  delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  // A key a test minted stays active in the module; a later web test would read it as this
  // device's key.
  setApiKey(null);
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

    it('ends the outage once Memory answers a sign-in, though the session check still fails', async () => {
      document.cookie = 'csrfToken=csrf-abc';
      setFetch((url) => {
        if (url.endsWith('/api/authenticate/refresh')) {
          return emptyResponse(false, 502);
        }

        if (url.endsWith('/api/authenticate')) {
          return jsonResponse({ accessToken: 'signed-in' });
        }

        return emptyResponse();
      });

      const { result } = renderHook(() => useAuth(), { wrapper });

      await waitFor(() => expect(result.current[0].initializing).toBe(false));
      expect(result.current[0].unreachable).toBe(true);

      await act(async () => {
        await result.current[1].login('jo@example.com', 'secret');
      });

      expect(result.current[0].authToken).toBe('signed-in');
      expect(result.current[0].unreachable).toBe(false);
    });

    it('keeps a sign-in when a retry sent before it comes back with no session', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });

      try {
        document.cookie = 'csrfToken=csrf-abc';
        let refreshCalls = 0;
        let answerRetry: (res: Response) => void = () => undefined;

        setFetch((url) => {
          if (url.endsWith('/api/authenticate/refresh')) {
            refreshCalls += 1;

            // The check on mount goes unanswered. The first retry is still out when the person signs in.
            return refreshCalls === 1
              ? emptyResponse(false, 502)
              : new Promise<Response>((resolve) => {
                  answerRetry = resolve;
                });
          }

          if (url.endsWith('/api/authenticate')) {
            return jsonResponse({ accessToken: 'signed-in' });
          }

          return emptyResponse();
        });

        const { result } = renderHook(() => useAuth(), { wrapper });

        await waitFor(() => expect(result.current[0].unreachable).toBe(true));
        await act(async () => {
          await vi.advanceTimersByTimeAsync(5000);
        });
        expect(refreshCalls).toBe(2);

        await act(async () => {
          await result.current[1].login('jo@example.com', 'secret');
        });

        // The retry carried the cookies from before the sign-in, so Memory finds no session.
        await act(async () => {
          answerRetry(emptyResponse(false, 401));
          await vi.advanceTimersByTimeAsync(0);
        });

        expect(result.current[0].authToken).toBe('signed-in');
        expect(result.current[0].unreachable).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('ends the outage as soon as Try again gets an answer', async () => {
      document.cookie = 'csrfToken=csrf-abc';
      let memoryUp = false;

      setFetch((url) => {
        if (url.endsWith('/api/authenticate/refresh')) {
          return memoryUp ? jsonResponse({ accessToken: 'back' }) : emptyResponse(false, 502);
        }

        return emptyResponse();
      });

      const { result } = renderHook(() => useAuth(), { wrapper });

      await waitFor(() => expect(result.current[0].unreachable).toBe(true));

      memoryUp = true;
      await act(async () => {
        await result.current[1].refresh();
      });

      expect(result.current[0].authToken).toBe('back');
      expect(result.current[0].unreachable).toBe(false);
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
    // A shell from before the LocalHub plugin: the key is sent as it is (the `legacy` fallback).
    const secureStore = new Map<string, string>([
      ['ci.apiKey', 'stored-api-key'],
      ['ci.apiKeyId', 'stored-key-id'],
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
      const hub = fakeLocalHub(entries);
      installNativeShell({ LocalHub: hub.plugin });

      return hub.store;
    }

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('keeps the paired origin when the keystore copy disagrees, repairs the copy, and drops the key that came with it', async () => {
      localStorage.setItem('ci.apiBaseUrl', 'https://paired.example.com');
      setApiBaseUrl('https://paired.example.com');
      const secureStore = nativeWithStore([
        ['ci.apiKey', 'stored-api-key'],
        ['ci.apiKeyId', 'stored-key-id'],
        // Written through the plugin by something other than the pairing flow.
        ['ci.apiBaseUrl', 'https://elsewhere.example.net'],
      ]);
      const confirm = vi.spyOn(window, 'confirm');
      const fetchMock = setFetch(() => emptyResponse());

      const { result } = renderHook(() => useAuth(), { wrapper });
      await waitFor(() => expect(result.current[0].initializing).toBe(false));

      expect(getApiBaseUrl()).toBe('https://paired.example.com');
      expect(localStorage.getItem('ci.apiBaseUrl')).toBe('https://paired.example.com');
      expect(secureStore.get('ci.apiBaseUrl')).toBe('https://paired.example.com');
      expect(confirm).not.toHaveBeenCalled();
      // The native side never sends a key to an origin other than the one it was stored for, and
      // which one that was is no longer known, so the key goes: the app is signed out.
      expect(secureStore.has('ci.apiKey')).toBe(false);
      expect(result.current[0].authenticated).toBe(false);
      expect(sentApiKeys(fetchMock)).toEqual([]);
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
        ['ci.apiKeyId', 'stored-key-id'],
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
      const hub = fakeLocalHub([
        ['ci.apiKey', 'outgoing-key'],
        ['ci.apiKeyId', 'outgoing-key-id'],
        ['ci.apiBaseUrl', 'https://core7.example.com'],
      ]);
      installNativeShell({
        LocalHub: { ...hub.plugin, start: vi.fn(async () => ({ baseUrl: HUB, token: 'hub-token' })) },
      });

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

      // Sent with the native side's token for the key, never the key itself.
      expect(upload?.apiKey).toBe(tokenFor('outgoing-key'));
      expect(seen.some((call) => call.apiKey === 'outgoing-key')).toBe(false);
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
      const hub = fakeLocalHub([
        ['ci.apiKey', 'outgoing-key'],
        ['ci.apiKeyId', 'outgoing-key-id'],
        ['ci.apiBaseUrl', 'https://core7.example.com'],
      ]);
      installNativeShell({
        LocalHub: { ...hub.plugin, start: vi.fn(async () => ({ baseUrl: HUB, token: 'hub-token' })) },
      });
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
      expect(hub.store.has('ci.apiKey')).toBe(false);
      expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith('/api/keys/current'))).toBe(true);
      // No last upload either: every request would carry a key the deleted account no longer has.
      expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith('/api/v1/notes'))).toBe(false);
    });

    it('runs one sign-out when Log out is tapped again while the first is still going', async () => {
      localStorage.setItem('ci.apiBaseUrl', 'https://core7.example.com');
      setApiBaseUrl('https://core7.example.com');
      const hub = fakeLocalHub([
        ['ci.apiKey', 'outgoing-key'],
        ['ci.apiKeyId', 'outgoing-key-id'],
        ['ci.apiBaseUrl', 'https://core7.example.com'],
      ]);
      installNativeShell({
        LocalHub: { ...hub.plugin, start: vi.fn(async () => ({ baseUrl: HUB, token: 'hub-token' })) },
      });

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
    // The phone keeps the name old app builds sent, which the server still reads as a phone's key.
    const mint = fetchMock.mock.calls.find(([input]) => String(input).endsWith('/api/keys'));
    expect((JSON.parse(String(mint?.[1]?.body)) as { name: string }).name).toMatch(
      /^Companion mobile · \d{4}-\d{2}-\d{2}$/,
    );
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

  it('native logout revokes the device key with its access token, while it still knows which server', async () => {
    localStorage.setItem('ci.apiBaseUrl', 'https://core7.example.com');
    setApiBaseUrl('https://core7.example.com');
    const hub = fakeLocalHub([
      ['ci.apiKey', 'stored-api-key'],
      ['ci.apiKeyId', 'stored-key-id'],
      ['ci.apiBaseUrl', 'https://core7.example.com'],
    ]);
    installNativeShell({ LocalHub: hub.plugin }, 'ios');

    const fetchMock = setFetch(() => emptyResponse(true, 204));

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current[0].authenticated).toBe(true));
    // Requests carry the token, and the page never holds the key.
    expect(getApiKey()).toBe(tokenFor('stored-api-key'));
    expect(apiKeyHeaders()).toEqual({ 'x-api-key': tokenFor('stored-api-key') });

    await act(async () => {
      await result.current[1].logout();
    });

    const revoke = fetchMock.mock.calls.find(([input]) => String(input).endsWith('/api/keys/current'));
    expect(revoke?.[0]).toBe('https://core7.example.com/api/keys/current');
    expect(revoke?.[1]?.method).toBe('DELETE');
    expect(revoke?.[1]?.headers).toMatchObject({ 'x-api-key': tokenFor('stored-api-key') });
    expect(sentApiKeys(fetchMock)).not.toContain('stored-api-key');
    expect(result.current[0].authenticated).toBe(false);
    expect(hub.store.has('ci.apiKey')).toBe(false);
    expect(getApiKey()).toBeNull();
  });

  it('native logout revokes the device key on the server, from a shell with only the retired plugin', async () => {
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

  it('desktop: a key an earlier build left in localStorage moves to the keychain at start and logout revokes it', async () => {
    const desktop = fakeDesktop();
    localStorage.setItem('ci.apiKey', 'desktop-stored-key');
    const fetchMock = setFetch(() => emptyResponse(true, 204));

    try {
      const { result } = renderHook(() => useAuth(), { wrapper });
      await waitFor(() => expect(result.current[0].initializing).toBe(false));
      expect(result.current[0].authenticated).toBe(true);
      expect(desktop.keychain.get('memory:ci.apiKey')).toBe('desktop-stored-key');
      expect(localStorage.getItem('ci.apiKey')).toBeNull();
      expect(getApiKey()).toBe(tokenFor('desktop-stored-key'));

      await act(async () => {
        await result.current[1].logout();
      });

      const revoke = fetchMock.mock.calls.find(([input]) => String(input).endsWith('/api/keys/current'));
      expect(revoke?.[1]?.method).toBe('DELETE');
      expect(revoke?.[1]?.headers).toMatchObject({ 'x-api-key': tokenFor('desktop-stored-key') });
      expect(sentApiKeys(fetchMock)).not.toContain('desktop-stored-key');
      expect(localStorage.getItem('ci.apiKey')).toBeNull();
      expect(desktop.keychain.has('memory:ci.apiKey')).toBe(false);
    } finally {
      delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
      localStorage.removeItem('ci.apiKey');
    }
  });

  it('desktop: an app from before the device-key commands still signs in with the key it stored', async () => {
    // The window is served by Memory, so a newer page can meet an older desktop app.
    const desktop = fakeDesktop(new Map([['memory:ci.apiKey', 'older-app-key']]), { olderApp: true });
    setFetch(() => emptyResponse(true, 204));

    try {
      const { result } = renderHook(() => useAuth(), { wrapper });
      await waitFor(() => expect(result.current[0].initializing).toBe(false));

      expect(result.current[0].authenticated).toBe(true);
      // That app cannot hand out tokens, so the key is sent as it always was.
      expect(getApiKey()).toBe('older-app-key');
      expect(desktop.invoke).toHaveBeenCalledWith('plugin:ci-auth|secure_get', { key: 'memory:ci.apiKey' });
    } finally {
      delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    }
  });

  describe('desktop: a sign-in key revoked somewhere else', () => {
    /** A desktop window signed in with Companion; Memory's answer about the key is `verdict`. */
    async function signedInDesktop(initial: 'ok' | 'unreachable' = 'ok') {
      const { appState } = await beginNativeOidcSignIn();
      const desktop = fakeDesktop(new Map(), {
        deepLink: `companion://oidc/callback?code=otc-desktop&state=${appState}`,
        verdict: initial,
      });
      const fetchMock = setFetch((url) => {
        if (url.endsWith('/api/authenticate/oidc/native/exchange')) {
          return jsonResponse({ accessToken: 'desktop-jwt' });
        }

        if (url.endsWith('/api/keys')) {
          return jsonResponse({ id: 'key-d', key: 'desktop-key' });
        }

        return emptyResponse(true, 204);
      });

      let navigate: ((to: string) => void) | undefined;
      const rendered = renderHook(
        () => {
          navigate = useNavigate();

          return useAuth();
        },
        { wrapper },
      );
      await waitFor(() => expect(rendered.result.current[0].authenticated).toBe(true));
      expect(desktop.keychain.get('memory:ci.apiKey')).toBe('desktop-key');

      return { ...rendered, fetchMock, desktop, navigateTo: (to: string) => navigate?.(to) };
    }

    afterEach(() => {
      delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
      setApiKey(null);
    });

    it('signs the window out when Memory says the key no longer works, at the next token', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });

      try {
        const { result, desktop } = await signedInDesktop();
        expect(getApiKey()).toBe(tokenFor('desktop-key'));
        desktop.setVerdict('revoked');

        // The token is renewed a minute before it runs out; Memory refuses the key then.
        await act(async () => {
          await vi.advanceTimersByTimeAsync(61_000);
        });

        await waitFor(() => expect(result.current[0].authenticated).toBe(false));
        expect(getApiKey()).toBeNull();
        // The keychain copy goes at the end of the sign-out, after `authenticated` has already turned false.
        await waitFor(() => expect(desktop.keychain.has('memory:ci.apiKey')).toBe(false));
      } finally {
        vi.useRealTimers();
      }
    });

    it('signs the window out at once when a request is refused and Memory then refuses the key', async () => {
      const { result, desktop, fetchMock } = await signedInDesktop();
      desktop.setVerdict('revoked');
      fetchMock.mockImplementation(async () => jsonResponse({ message: 'Unauthorized' }, false, 401));

      await act(async () => {
        await fetchJson('/api/users/me').catch(() => undefined);
      });

      await waitFor(() => expect(result.current[0].authenticated).toBe(false));
      expect(desktop.invoke).toHaveBeenCalledWith('device_access_token_command', { refresh: true });
    });

    it('asks again every minute while the person moves between pages', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });

      try {
        const { result, desktop, navigateTo } = await signedInDesktop();
        desktop.setVerdict('revoked');
        const asksBefore = desktop.tokenRequests();

        // A new page every 40 seconds with no focus change: moving pages must not ask or reset anything.
        for (const page of ['/planning', '/memory', '/chat']) {
          const asksBeforePage = desktop.tokenRequests();
          await act(async () => {
            navigateTo(page);
          });
          expect(desktop.tokenRequests()).toBe(asksBeforePage);
          await act(async () => {
            await vi.advanceTimersByTimeAsync(40_000);
          });
        }

        expect(desktop.tokenRequests()).toBeGreaterThan(asksBefore);
        await waitFor(() => expect(result.current[0].authenticated).toBe(false));
      } finally {
        vi.useRealTimers();
      }
    });

    it('stays signed in when Memory does not answer', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });

      try {
        const { result, desktop } = await signedInDesktop();
        desktop.setVerdict('unreachable');
        const asksBefore = desktop.tokenRequests();

        await act(async () => {
          await vi.advanceTimersByTimeAsync(61_000);
        });

        expect(desktop.tokenRequests()).toBeGreaterThan(asksBefore);
        expect(result.current[0].authenticated).toBe(true);
        // The token it has still works for another minute, so requests keep carrying it.
        expect(getApiKey()).toBe(tokenFor('desktop-key'));

        // Once that runs out too there is nothing to send, but nobody is signed out over an outage.
        await act(async () => {
          await vi.advanceTimersByTimeAsync(120_000);
        });
        expect(result.current[0].authenticated).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('desktop: a Companion sign-in across restarts', () => {
    interface ShellOptions {
      /** A sign-in callback the shell hands over at launch, as when the browser started the app. */
      deepLink?: string;
      /** Hold the launch's read of the key until `releaseFirstKeyRead`. It answers about the key the keychain held when asked. */
      holdFirstKeyRead?: boolean;
      /** The first read of the key fails, as a keychain that is still locked does. */
      failFirstKeyRead?: boolean;
      /** Every write fails. */
      refuseWrites?: boolean;
    }

    let releaseHeldRead = () => {};

    /** The appliance of the test, which decides what the native side hears about each key. */
    let appliance: { verdictFor: (key: string) => Promise<'ok' | 'revoked'> } | null = null;

    /** A Memory Desktop shell whose keychain starts with `stored` (names as the plugin keeps them). */
    function desktopShell(stored: Record<string, string>, options: ShellOptions = {}) {
      const firstKeyReadHeld = new Promise<void>((resolve) => {
        releaseHeldRead = resolve;
      });
      const desktop = fakeDesktop(new Map(Object.entries(stored)), {
        deepLink: options.deepLink ?? null,
        refuseWrites: options.refuseWrites,
        beforeKeyRead: async (reads) => {
          if (reads === 1 && options.failFirstKeyRead) {
            throw new Error('Keychain locked');
          }

          if (reads === 1 && options.holdFirstKeyRead) {
            await firstKeyReadHeld;
          }
        },
        verdict: (key) => appliance?.verdictFor(key) ?? 'ok',
      });

      return { keychain: desktop.keychain, desktop, releaseFirstKeyRead: () => releaseHeldRead() };
    }

    /** The key a request carried: the token stands for the key it was handed out for. */
    const keyOf = (header: string | undefined) =>
      header?.startsWith('token-for:') ? header.slice('token-for:'.length) : header;

    /**
     * The appliance the window is served from. It remembers the keys given back to it (by the key
     * or a token for it), and the native side's token request for a key is answered by that list.
     * With `holdFirstAskUntilRevoked`, the first such request waits (up to 2 s) for its key to be
     * given back and answers the moment it is; `revokedMidAsk` lists the keys given back while
     * their request was waiting. `exchangeAfterAskFor` holds the sign-in's code exchange until that
     * key has been asked about (up to 2 s). `signIn` answers an email sign-in. `holdRevokeUntil`
     * holds every revoke until it returns true (up to 2 s).
     */
    function memory(
      options: {
        refresh?: () => Response;
        signIn?: () => Response;
        holdFirstAskUntilRevoked?: boolean;
        exchangeAfterAskFor?: string;
        holdRevokeUntil?: () => boolean;
      } = {},
    ) {
      const revoked = new Set<string>();
      const revokedMidAsk = new Set<string>();
      const asked: string[] = [];
      const waiting = new Map<string, () => void>();

      appliance = {
        async verdictFor(key) {
          asked.push(key);

          if (options.holdFirstAskUntilRevoked && asked.length === 1 && !revoked.has(key)) {
            await new Promise<void>((resolve) => {
              waiting.set(key, resolve);
              setTimeout(resolve, 2000);
            });
            waiting.delete(key);
          }

          return revoked.has(key) ? 'revoked' : 'ok';
        },
      };

      const fetchMock = setFetch(async (url, init) => {
        const key = keyOf((init?.headers as Record<string, string> | undefined)?.['x-api-key']);

        if (url.endsWith('/api/keys/current') && init?.method === 'DELETE') {
          for (let waited = 0; options.holdRevokeUntil && waited < 2000; waited += 5) {
            if (options.holdRevokeUntil()) {
              break;
            }

            await new Promise((resolve) => setTimeout(resolve, 5));
          }

          if (key) {
            revoked.add(key);

            if (waiting.has(key)) {
              revokedMidAsk.add(key);
              waiting.get(key)?.();
            }
          }

          return emptyResponse(true, 204);
        }

        if (url.endsWith('/api/authenticate/oidc/native/exchange')) {
          for (let waited = 0; options.exchangeAfterAskFor && waited < 2000; waited += 5) {
            if (asked.includes(options.exchangeAfterAskFor)) {
              break;
            }

            await new Promise((resolve) => setTimeout(resolve, 5));
          }

          return jsonResponse({ accessToken: 'desktop-jwt' });
        }

        if (url.endsWith('/api/keys')) {
          return jsonResponse({ id: 'key-new', key: 'new-key' });
        }

        if (url.endsWith('/api/authenticate/refresh')) {
          return options.refresh?.() ?? emptyResponse(false, 401);
        }

        if (url.endsWith('/api/authenticate') && options.signIn) {
          return options.signIn();
        }

        return emptyResponse(true, 204);
      });

      return { fetchMock, revoked, revokedMidAsk, asked };
    }

    const callsTo = (fetchMock: ReturnType<typeof setFetch>, path: string) =>
      fetchMock.mock.calls.filter(([input]) => String(input).endsWith(path));

    const settle = () =>
      act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
      });

    afterEach(() => {
      releaseHeldRead();
      appliance = null;
      delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
      setApiKey(null);
    });

    it('starts tokens for the stored key at launch: signed in, and requests carry its token', async () => {
      const { keychain } = desktopShell({ 'memory:ci.apiKey': 'kept-key' });
      const { fetchMock, asked } = memory();

      const { result } = renderHook(() => useAuth(), { wrapper });

      await waitFor(() => expect(result.current[0].initializing).toBe(false));
      expect(result.current[0].authenticated).toBe(true);
      expect(getApiKey()).toBe(tokenFor('kept-key'));
      expect(apiKeyHeaders()).toEqual({ 'x-api-key': tokenFor('kept-key') });
      // A Companion sign-in made no cookie session, so there is none to look for.
      expect(callsTo(fetchMock, '/api/authenticate/hub-bridge')).toHaveLength(0);
      expect(callsTo(fetchMock, '/api/authenticate/refresh')).toHaveLength(0);
      // Memory was asked about the key straight away, not after the first minute.
      expect(asked).toEqual(['kept-key']);
      await settle();
      expect(result.current[0].authenticated).toBe(true);
      expect(keychain.get('memory:ci.apiKey')).toBe('kept-key');
      expect(sentApiKeys(fetchMock)).not.toContain('kept-key');
    });

    it.each<[string, Record<string, string>, ShellOptions]>([
      ['nothing is stored', {}, {}],
      ['the keychain cannot be read', { 'memory:ci.apiKey': 'kept-key' }, { failFirstKeyRead: true }],
    ])('goes on to the cookie session an email sign-in keeps when %s', async (_case, stored, options) => {
      desktopShell(stored, options);
      const { fetchMock, asked } = memory({ refresh: () => jsonResponse({ accessToken: 'email-session' }) });

      const { result } = renderHook(() => useAuth(), { wrapper });

      await waitFor(() => expect(result.current[0].authToken).toBe('email-session'));
      expect(result.current[0].authenticated).toBe(true);
      expect(getApiKey()).toBeNull();
      expect(apiKeyHeaders()).toEqual({});
      expect(asked).toEqual([]);
      expect(sentApiKeys(fetchMock)).toEqual([]);
    });

    it('signs the window out at launch when the stored key was revoked while the app was closed', async () => {
      const { keychain } = desktopShell({
        'memory:ci.apiKey': 'revoked-key',
        'memory:ci.apiKeyId': 'key-old',
        'memory:ci.apiKeyCapability': 'full',
      });
      const { revoked } = memory();
      revoked.add('revoked-key');
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      let pathname: string | undefined;
      const { result } = renderHook(
        () => {
          pathname = useLocation().pathname;

          return useAuth();
        },
        {
          wrapper: ({ children }: { children: ReactNode }) => (
            <MemoryRouter initialEntries={['/memory']}>
              <AuthProvider args={[]}>{children}</AuthProvider>
            </MemoryRouter>
          ),
        },
      );

      await waitFor(() => expect(keychain.size).toBe(0));
      expect(result.current[0].authenticated).toBe(false);
      expect(getApiKey()).toBeNull();
      // `/` is the desktop sign-in page.
      expect(pathname).toBe('/');
    });

    it('a sign-in from the sign-in page gives back the key the keychain held and keeps the new one', async () => {
      // The keychain was still locked at launch, so the window came up signed out with a key stored.
      const { keychain } = desktopShell(
        { 'memory:ci.apiKey': 'old-key', 'memory:ci.apiKeyId': 'key-old' },
        { failFirstKeyRead: true },
      );
      const { fetchMock, revoked } = memory();

      const { result } = renderHook(() => useAuth(), { wrapper });
      await waitFor(() => expect(result.current[0].initializing).toBe(false));
      expect(result.current[0].authenticated).toBe(false);

      // Sign in with Companion account. The browser hands the result back.
      const { appState } = await beginNativeOidcSignIn();
      act(() => {
        window.dispatchEvent(
          new CustomEvent('companion-deep-link', {
            detail: `companion://oidc/callback?code=otc-new&state=${appState}`,
          }),
        );
      });

      await waitFor(() => expect(result.current[0].authenticated).toBe(true));
      await waitFor(() => expect(callsTo(fetchMock, '/api/keys/current')).toHaveLength(1));
      const revokes = callsTo(fetchMock, '/api/keys/current');
      expect(revokes[0][1]?.method).toBe('DELETE');
      // Given back with a token for it: the page cannot read the old key either.
      expect(revokes[0][1]?.headers).toMatchObject({ 'x-api-key': tokenFor('old-key') });
      expect([...revoked]).toEqual(['old-key']);
      expect(getApiKey()).toBe(tokenFor('new-key'));
      expect(keychain.get('memory:ci.apiKey')).toBe('new-key');
      expect(keychain.get('memory:ci.apiKeyId')).toBe('key-new');
    });

    it('a sign-in whose key the keychain will not save still gives back the key it held', async () => {
      const { keychain } = desktopShell(
        { 'memory:ci.apiKey': 'old-key' },
        { failFirstKeyRead: true, refuseWrites: true },
      );
      const { revoked } = memory();

      const { result } = renderHook(() => useAuth(), { wrapper });
      await waitFor(() => expect(result.current[0].initializing).toBe(false));

      const { appState } = await beginNativeOidcSignIn();
      act(() => {
        window.dispatchEvent(
          new CustomEvent('companion-deep-link', {
            detail: `companion://oidc/callback?code=otc-unsaved&state=${appState}`,
          }),
        );
      });

      await waitFor(() => expect(result.current[0].error).toBeInstanceOf(DeviceKeyNotSavedError));
      expect([...revoked].sort()).toEqual(['new-key', 'old-key']);
      // Nothing may read the key just given back at the next launch.
      expect(keychain.has('memory:ci.apiKey')).toBe(false);
      expect(result.current[0].authenticated).toBe(false);
      expect(getApiKey()).toBeNull();
    });

    it('a sign-in whose key will not save leaves the window on the key it is signed in with', async () => {
      // The launch started tokens for the old key, then the browser handed over a sign-in the keychain refuses.
      const { appState } = await beginNativeOidcSignIn();
      const { keychain } = desktopShell(
        { 'memory:ci.apiKey': 'old-key' },
        { deepLink: `companion://oidc/callback?code=otc-kept&state=${appState}`, refuseWrites: true },
      );
      const { revoked } = memory({ exchangeAfterAskFor: 'old-key' });

      const { result } = renderHook(() => useAuth(), { wrapper });

      await waitFor(() => expect(result.current[0].error).toBeInstanceOf(DeviceKeyNotSavedError));
      await settle();
      expect([...revoked]).toEqual(['new-key']);
      expect(getApiKey()).toBe(tokenFor('old-key'));
      expect(result.current[0].authenticated).toBe(true);
      expect(keychain.get('memory:ci.apiKey')).toBe('old-key');
    });

    it('an email sign-in gives back the key the keychain still held, so the next launch keeps that session', async () => {
      // The keychain was still locked at launch, so the window came up signed out with a key stored.
      const { keychain } = desktopShell(
        { 'memory:ci.apiKey': 'old-key', 'memory:ci.apiKeyId': 'key-old' },
        { failFirstKeyRead: true },
      );
      const { revoked } = memory({ signIn: () => jsonResponse({ accessToken: 'email-session' }) });

      const { result } = renderHook(() => useAuth(), { wrapper });
      await waitFor(() => expect(result.current[0].initializing).toBe(false));

      await act(async () => {
        await result.current[1].login('jo@example.com', 'secret');
      });

      expect(result.current[0].authToken).toBe('email-session');
      await waitFor(() => expect(keychain.has('memory:ci.apiKey')).toBe(false));
      expect(keychain.has('memory:ci.apiKeyId')).toBe(false);
      expect([...revoked]).toEqual(['old-key']);
      expect(getApiKey()).toBeNull();
    });

    it('a sign-in the browser hands over at launch replaces the stored key without being signed out by the launch answer', async () => {
      // The launch asks Memory about the old key. That answer comes the moment the sign-in gives
      // the old key back, so it says the key is revoked; it belongs to a sign-in that is over.
      const { appState } = await beginNativeOidcSignIn();
      const { keychain } = desktopShell(
        { 'memory:ci.apiKey': 'old-key' },
        { deepLink: `companion://oidc/callback?code=otc-launch&state=${appState}` },
      );
      const { revoked, revokedMidAsk, asked } = memory({
        holdFirstAskUntilRevoked: true,
        exchangeAfterAskFor: 'old-key',
      });

      const { result } = renderHook(() => useAuth(), { wrapper });

      await waitFor(() => expect(getApiKey()).toBe(tokenFor('new-key')));
      await waitFor(() => expect(revoked.has('old-key')).toBe(true));
      await settle();
      expect(asked).toContain('old-key');
      // The launch's question about the old key was still waiting when the sign-in gave that key back.
      expect(revokedMidAsk.has('old-key')).toBe(true);
      expect(result.current[0].authenticated).toBe(true);
      expect(getApiKey()).toBe(tokenFor('new-key'));
      expect(revoked.has('new-key')).toBe(false);
      expect(keychain.get('memory:ci.apiKey')).toBe('new-key');
    });

    it('a sign-in the browser hands over at launch keeps its key when the revoked stored key signs the window out meanwhile', async () => {
      // The stored key was revoked while the app was closed, and the app was started by a sign-in.
      // The launch answer signs the old key out while that sign-in is still saving its own.
      const { appState } = await beginNativeOidcSignIn();
      const { keychain } = desktopShell(
        { 'memory:ci.apiKey': 'revoked-key', 'memory:ci.apiKeyId': 'key-old' },
        { deepLink: `companion://oidc/callback?code=otc-signed-out&state=${appState}` },
      );
      const { fetchMock, revoked } = memory({
        exchangeAfterAskFor: 'revoked-key',
        // A revoke answers only once the sign-in has saved its key.
        holdRevokeUntil: () => keychain.get('memory:ci.apiKey') === 'new-key',
      });
      revoked.add('revoked-key');
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      const { result } = renderHook(() => useAuth(), { wrapper });

      // The launch answer did sign the old key out.
      await waitFor(() => expect(callsTo(fetchMock, '/api/authenticate/logout')).toHaveLength(1));
      await settle();
      expect(getApiKey()).toBe(tokenFor('new-key'));
      expect(result.current[0].authenticated).toBe(true);
      expect(revoked.has('new-key')).toBe(false);
      // The next launch signs in with the new key.
      expect(keychain.get('memory:ci.apiKey')).toBe('new-key');
      expect(keychain.get('memory:ci.apiKeyId')).toBe('key-new');
    });

    it('a sign-in that finishes while the launch read is still out wins', async () => {
      const { appState } = await beginNativeOidcSignIn();
      const shell = desktopShell(
        { 'memory:ci.apiKey': 'old-key' },
        { deepLink: `companion://oidc/callback?code=otc-race&state=${appState}`, holdFirstKeyRead: true },
      );
      const { revoked } = memory();

      const { result } = renderHook(() => useAuth(), { wrapper });

      await waitFor(() => expect(result.current[0].authenticated).toBe(true));
      expect(getApiKey()).toBe(tokenFor('new-key'));
      expect(result.current[0].initializing).toBe(true);

      // The launch read now answers, about whatever the keychain holds by then.
      shell.releaseFirstKeyRead();
      await waitFor(() => expect(result.current[0].initializing).toBe(false));
      await settle();
      expect(getApiKey()).toBe(tokenFor('new-key'));
      expect(result.current[0].authenticated).toBe(true);
      expect(revoked.has('old-key')).toBe(true);
      expect(shell.keychain.get('memory:ci.apiKey')).toBe('new-key');
    });

    it('a sign-out while the launch read is still out wins', async () => {
      const shell = desktopShell({ 'memory:ci.apiKey': 'old-key' }, { holdFirstKeyRead: true });
      const { fetchMock, revoked } = memory();

      const { result } = renderHook(() => useAuth(), { wrapper });

      let signedOut: Promise<void> | undefined;
      act(() => {
        signedOut = result.current[1].logout();
      });

      // Given back with a token the native side handed out for the stored key, since none was in use yet.
      await waitFor(() => expect(revoked.has('old-key')).toBe(true));
      await act(async () => {
        await signedOut;
      });
      expect(shell.keychain.has('memory:ci.apiKey')).toBe(false);

      shell.releaseFirstKeyRead();
      await waitFor(() => expect(result.current[0].initializing).toBe(false));
      await settle();
      expect(result.current[0].authenticated).toBe(false);
      expect(getApiKey()).toBeNull();
      // The late read put nothing back, and nothing was given back twice.
      expect(callsTo(fetchMock, '/api/keys/current')).toHaveLength(1);
    });
  });

  it('web: a key in localStorage is not read back at launch; the cookie session decides', async () => {
    localStorage.setItem('ci.apiKey', 'web-stored-key');
    const fetchMock = setFetch((url) =>
      url.endsWith('/api/authenticate/refresh')
        ? jsonResponse({ accessToken: 'web-session' })
        : emptyResponse(),
    );

    try {
      const { result } = renderHook(() => useAuth(), { wrapper });

      await waitFor(() => expect(result.current[0].authToken).toBe('web-session'));
      expect(getApiKey()).toBeNull();
      expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith('/api/keys/check'))).toBe(false);
    } finally {
      localStorage.removeItem('ci.apiKey');
    }
  });

  it('phone: connecting to another appliance never sends it the key the phone held before', async () => {
    localStorage.setItem('ci.apiBaseUrl', 'https://first.example.com');
    setApiBaseUrl('https://first.example.com');
    const secureStore = new Map<string, string>([
      ['ci.apiKey', 'first-box-key'],
      ['ci.apiBaseUrl', 'https://first.example.com'],
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
    const fetchMock = setFetch((url) =>
      url.endsWith('/api/keys')
        ? jsonResponse({ id: 'key-2', key: 'second-box-key' })
        : emptyResponse(true, 204),
    );

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current[0].authenticated).toBe(true));
    expect(getApiKey()).toBe('first-box-key');

    await act(async () => {
      await result.current[1].completePortalMemoryConnect('portal-bearer', 'https://second.example.com');
    });

    expect(getApiKey()).toBe('second-box-key');
    expect(secureStore.get('ci.apiKey')).toBe('second-box-key');
    const toSecondBox = fetchMock.mock.calls.filter(([input]) =>
      String(input).startsWith('https://second.example.com'),
    );
    expect(toSecondBox.length).toBeGreaterThan(0);
    expect(
      toSecondBox.some(
        ([, init]) =>
          (init?.headers as Record<string, string> | undefined)?.['x-api-key'] === 'first-box-key',
      ),
    ).toBe(false);
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith('/api/keys/current'))).toBe(false);
  });

  it('desktop: gives the new key back when the keychain will not save it', async () => {
    // A Linux desktop with no default keyring: the server makes the key, the keychain refuses it.
    const { appState } = await beginNativeOidcSignIn();
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: vi.fn(async (command: string) => {
        switch (command) {
          case 'take_pending_deep_link_command':
            return `companion://oidc/callback?code=otc-desktop&state=${appState}`;
          case 'plugin:ci-auth|secure_get':
            return { value: null };
          case 'plugin:ci-auth|secure_set':
            throw new Error('No default keyring');
          default:
            return null;
        }
      }),
    };
    const fetchMock = setFetch((url) => {
      if (url.endsWith('/api/authenticate/oidc/native/exchange')) {
        return jsonResponse({ accessToken: 'desktop-jwt' });
      }

      if (url.endsWith('/api/keys')) {
        return jsonResponse({ id: 'key-d', key: 'unsaved-key' });
      }

      return emptyResponse(true, 204);
    });

    try {
      const { result } = renderHook(() => useAuth(), { wrapper });
      await waitFor(() => expect(result.current[0].error).toBeInstanceOf(DeviceKeyNotSavedError));

      const revoke = fetchMock.mock.calls.find(([input]) => String(input).endsWith('/api/keys/current'));
      expect(revoke?.[1]?.method).toBe('DELETE');
      expect(revoke?.[1]?.headers).toMatchObject({ 'x-api-key': 'unsaved-key' });
      expect(result.current[0].authenticated).toBe(false);
      expect(getApiKey()).toBeNull();
    } finally {
      delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    }
  });

  it('desktop: drops a revoked key the keychain kept before refusing the rest', async () => {
    // The key itself was written, then the keychain refused its id. Left there, the stored copy
    // would be a key the server no longer takes.
    const { appState } = await beginNativeOidcSignIn();
    const keychain = new Map<string, string>();
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: vi.fn(async (command: string, args?: { key?: string; value?: string }) => {
        switch (command) {
          case 'take_pending_deep_link_command':
            return `companion://oidc/callback?code=otc-partial&state=${appState}`;
          case 'plugin:ci-auth|secure_get':
            return { value: keychain.get(args?.key ?? '') ?? null };
          case 'plugin:ci-auth|secure_set':
            if (args?.key !== 'memory:ci.apiKey') {
              throw new Error('Keychain locked');
            }

            keychain.set(args.key, args.value ?? '');

            return null;
          case 'plugin:ci-auth|secure_remove':
            keychain.delete(args?.key ?? '');

            return null;
          default:
            return null;
        }
      }),
    };
    const fetchMock = setFetch((url) => {
      if (url.endsWith('/api/authenticate/oidc/native/exchange')) {
        return jsonResponse({ accessToken: 'desktop-jwt' });
      }

      if (url.endsWith('/api/keys')) {
        return jsonResponse({ id: 'key-p', key: 'half-saved-key' });
      }

      return emptyResponse(true, 204);
    });

    try {
      const { result } = renderHook(() => useAuth(), { wrapper });
      await waitFor(() => expect(result.current[0].error).toBeInstanceOf(DeviceKeyNotSavedError));

      const revoke = fetchMock.mock.calls.find(([input]) => String(input).endsWith('/api/keys/current'));
      expect(revoke?.[1]?.headers).toMatchObject({ 'x-api-key': 'half-saved-key' });
      expect(keychain.has('memory:ci.apiKey')).toBe(false);
      expect(result.current[0].authenticated).toBe(false);
    } finally {
      delete (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    }
  });

  it('native: a keystore that refuses the new key gives it back and says so in phone terms', async () => {
    (window as unknown as { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => true,
      Plugins: {
        SecureStoragePlugin: {
          get: vi.fn(async () => {
            throw new Error('not found');
          }),
          set: vi.fn(async () => {
            throw new Error('Keystore unavailable');
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
        return jsonResponse({ id: 'key-n', key: 'unsaved-phone-key' });
      }

      return emptyResponse(true, 204);
    });

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current[0].loading).toBe(false));

    await act(async () => {
      await result.current[1].login('jsmith@example.com', 'pw');
    });

    const { error } = result.current[0];
    expect(error).toBeInstanceOf(DeviceKeyNotSavedError);
    // Email and password is what just failed. A phone has no keyring to set up either.
    expect((error as Error).message).not.toMatch(/keyring|email and password/);
    const revoke = fetchMock.mock.calls.find(([input]) => String(input).endsWith('/api/keys/current'));
    expect(revoke?.[1]?.method).toBe('DELETE');
    expect(revoke?.[1]?.headers).toMatchObject({ 'x-api-key': 'unsaved-phone-key' });
    expect(result.current[0].authenticated).toBe(false);
  });

  it('desktop: names the key it mints at sign-in after the desktop app, not the phone', async () => {
    // What the sign-in button kept before it opened the browser; the shell hands the callback
    // over through take_pending_deep_link_command, as it does for a link that started the app.
    const { appState } = await beginNativeOidcSignIn();
    const keychain = new Map<string, string>();
    (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {
      invoke: vi.fn(async (command: string, args?: { key?: string; value?: string }) => {
        switch (command) {
          case 'take_pending_deep_link_command':
            return `companion://oidc/callback?code=otc-desktop&state=${appState}`;
          case 'plugin:ci-auth|secure_get':
            return { value: keychain.get(args?.key ?? '') ?? null };
          case 'plugin:ci-auth|secure_set':
            keychain.set(args?.key ?? '', args?.value ?? '');

            return null;
          default:
            return null;
        }
      }),
    };
    const fetchMock = setFetch((url) => {
      if (url.endsWith('/api/authenticate/oidc/native/exchange')) {
        return jsonResponse({ accessToken: 'desktop-jwt' });
      }

      if (url.endsWith('/api/keys')) {
        return jsonResponse({ id: 'key-d', key: 'desktop-key' });
      }

      return emptyResponse();
    });

    const { result } = renderHook(() => useAuth(), { wrapper });
    await waitFor(() => expect(result.current[0].authenticated).toBe(true));

    const mint = fetchMock.mock.calls.find(([input]) => String(input).endsWith('/api/keys'));
    const body = JSON.parse(String(mint?.[1]?.body)) as {
      name: string;
      capability: string;
      sign_in: boolean;
    };
    expect(body.name).toMatch(/^Companion desktop · \d{4}-\d{2}-\d{2}$/);
    // This name gets no `full` from the server's phone-name fallback, so the app has to ask for it.
    expect(body.capability).toBe('full');
    expect(body.sign_in).toBe(true);
    expect(keychain.get('memory:ci.apiKey')).toBe('desktop-key');
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

  describe('phone: the key stays in the keystore and requests carry tokens', () => {
    const FIRST = 'https://first.example.com';
    const SECOND = 'https://second.example.com';

    /** A phone paired with FIRST, signed in with `first-box-key`. */
    function pairedPhone(options: Parameters<typeof fakeLocalHub>[1] = {}) {
      localStorage.setItem('ci.apiBaseUrl', FIRST);
      setApiBaseUrl(FIRST);
      const hub = fakeLocalHub(
        [
          ['ci.apiKey', 'first-box-key'],
          ['ci.apiKeyId', 'key-1'],
          ['ci.apiKeyCapability', 'full'],
          ['ci.apiBaseUrl', FIRST],
        ],
        options,
      );
      installNativeShell({ LocalHub: hub.plugin }, 'ios');

      return hub;
    }

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it.each(['cloud connect', 'password connect'] as const)(
      '%s to a new Memory keeps the new key, even when the app comes back to the foreground before its first token',
      async (how) => {
        const hub = pairedPhone();
        const fetchMock = setFetch((url) => {
          if (url.endsWith('/api/authenticate/csrf')) {
            return jsonBodyResponse({ csrfToken: 'native-csrf' });
          }

          if (url.endsWith('/api/authenticate')) {
            return jsonResponse({ accessToken: 'second-jwt' });
          }

          if (url.endsWith('/api/keys')) {
            return jsonResponse({ id: 'key-2', key: 'second-box-key' });
          }

          return emptyResponse(true, 204);
        });

        const { result } = renderHook(() => useAuth(), { wrapper });
        await waitFor(() => expect(getApiKey()).toBe(tokenFor('first-box-key')));

        // The app comes back into view while the first token for the new key is being asked
        // for: the shell mirrors the page's origin into the keystore then (`useNativeShell`).
        let foregrounded = false;
        hub.setVerdict(async (key): Promise<'ok'> => {
          if (key === 'second-box-key' && !foregrounded) {
            foregrounded = true;
            await syncNativeIntentConfig();
          }

          return 'ok';
        });

        await act(async () => {
          if (how === 'cloud connect') {
            await result.current[1].completePortalMemoryConnect('portal-bearer', SECOND);
          } else {
            await result.current[1].completeMemoryPasswordConnect('me@example.com', 'pw', SECOND);
          }
        });

        expect(foregrounded).toBe(true);
        expect(result.current[0].authenticated).toBe(true);
        expect(localStorage.getItem('ci.apiBaseUrl')).toBe(SECOND);
        expect(hub.store.get('ci.apiBaseUrl')).toBe(SECOND);
        // Not removed by the native side's origin rule: the origin mirrored was the new one.
        expect(hub.store.get('ci.apiKey')).toBe('second-box-key');
        expect(hub.store.get('ci.apiKeyId')).toBe('key-2');
        expect(getApiKey()).toBe(tokenFor('second-box-key'));
        // Neither key, nor the first box's token, ever went to the second box.
        const toSecond = fetchMock.mock.calls.filter(([input]) => String(input).startsWith(SECOND));
        const keysToSecond = sentApiKeys({ mock: { calls: toSecond } });
        expect(keysToSecond).not.toContain('first-box-key');
        expect(keysToSecond).not.toContain(tokenFor('first-box-key'));
        expect(sentApiKeys(fetchMock)).not.toContain('second-box-key');
      },
    );

    it('writes the origin before the key, so the native side keeps the key it was given', async () => {
      const hub = pairedPhone();
      setFetch((url) =>
        url.endsWith('/api/keys')
          ? jsonResponse({ id: 'key-2', key: 'second-box-key' })
          : emptyResponse(true, 204),
      );

      const { result } = renderHook(() => useAuth(), { wrapper });
      await waitFor(() => expect(result.current[0].authenticated).toBe(true));
      hub.plugin.secureSet.mockClear();

      await act(async () => {
        await result.current[1].completePortalMemoryConnect('portal-bearer', SECOND);
      });

      const written = hub.plugin.secureSet.mock.calls.map(([{ key }]) => key);
      expect(written.indexOf('ci.apiBaseUrl')).toBeGreaterThan(-1);
      expect(written.indexOf('ci.apiBaseUrl')).toBeLessThan(written.indexOf('ci.apiKey'));
      expect(hub.store.get('ci.apiKey')).toBe('second-box-key');
    });

    it('stays signed in when Memory cannot be reached at launch, and stamps captures with the native stamp', async () => {
      pairedPhone({ verdict: 'unreachable' });
      const fetchMock = setFetch(() => emptyResponse(true, 204));

      const { result } = renderHook(() => useAuth(), { wrapper });
      await waitFor(() => expect(result.current[0].initializing).toBe(false));

      expect(result.current[0].authenticated).toBe(true);
      expect(getApiKey()).toBeNull();
      expect(outboxOwnerStamp()).toBe(stampFor(FIRST, 'first-box-key'));
      expect(sentApiKeys(fetchMock)).toEqual([]);
    });

    it('is signed out at launch when the keystore cannot be read at all', async () => {
      const hub = pairedPhone({ verdict: 'reject' });
      hub.plugin.secureGet.mockRejectedValue(new Error('keystore unavailable'));
      setFetch(() => emptyResponse(true, 204));

      const { result } = renderHook(() => useAuth(), { wrapper });
      await waitFor(() => expect(result.current[0].initializing).toBe(false));

      expect(result.current[0].authenticated).toBe(false);
      expect(getApiKey()).toBeNull();
    });

    it('signs out when Memory refuses the stored key at launch, asking about unsent captures first', async () => {
      pairedPhone({ verdict: 'revoked' });
      const fetchMock = setFetch(() => emptyResponse(true, 204));

      const { result } = renderHook(() => useAuth(), { wrapper });

      await waitFor(() => expect(result.current[0].authenticated).toBe(false));
      expect(getApiKey()).toBeNull();
      expect(sentApiKeys(fetchMock)).toEqual([]);
    });

    it('a shell without deviceAccessToken still sends the stored key, as it did before tokens', async () => {
      localStorage.setItem('ci.apiBaseUrl', FIRST);
      setApiBaseUrl(FIRST);
      const store = new Map([
        ['ci.apiKey', 'dev-shell-key'],
        ['ci.apiKeyId', 'key-1'],
        ['ci.apiBaseUrl', FIRST],
      ]);
      installNativeShell({
        LocalHub: {
          secureGet: vi.fn(async ({ key }: { key: string }) => ({ value: store.get(key) ?? null })),
          secureSet: vi.fn(async ({ key, value }: { key: string; value: string }) => {
            store.set(key, value);
          }),
          secureRemove: vi.fn(async ({ key }: { key: string }) => {
            store.delete(key);
          }),
        },
      });
      setFetch(() => emptyResponse(true, 204));

      const { result } = renderHook(() => useAuth(), { wrapper });
      await waitFor(() => expect(result.current[0].authenticated).toBe(true));

      expect(getApiKey()).toBe('dev-shell-key');
      // And captures are still stamped for this key, computed from it as before.
      expect(outboxOwnerStamp()).toMatch(/^https:\/\/first\.example\.com [0-9a-f]{14}$/);
    });
  });
});
