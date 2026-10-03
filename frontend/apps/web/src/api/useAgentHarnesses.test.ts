import { setApiKey } from '@ci/common';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useAgentHarnesses, type AgentHarnessStatus } from './useAgentHarnesses';

// The real `useSessionAuth` runs on top of this, so the hook is exercised for a web JWT
// session and for the native shell, whose only credential is an API key.
const h = vi.hoisted(() => ({
  auth: { authToken: 'jwt-abc' as string | null, authenticated: true, expired: false },
}));

vi.mock('@/hooks/useAuth', () => ({ useAuth: () => [h.auth, {}] }));

const hermes: AgentHarnessStatus = {
  id: 'hermes',
  name: 'Hermes',
  connectedToMemory: false,
  installed: false,
  running: false,
  openUrl: null,
  accessible: false,
  wakeable: false,
  dispatchReady: false,
  dispatchBlocker: 'not_installed',
  connectUrl: null,
};

const openclaw: AgentHarnessStatus = { ...hermes, id: 'openclaw', name: 'OpenClaw' };

const ok = (body: unknown): Response =>
  ({ ok: true, status: 200, text: async () => JSON.stringify(body) }) as Response;

function setFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const mock = vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
    Promise.resolve(handler(String(input), init)),
  );
  vi.stubGlobal('fetch', mock);

  return mock;
}

const headersOfCall = (fetchMock: ReturnType<typeof setFetch>, index: number) =>
  (fetchMock.mock.calls[index]?.[1] as RequestInit | undefined)?.headers as Record<string, string>;

// The module keeps a 30 s cache of the last answer. Each test runs a minute after the last, on a
// faked clock (only `Date` — timers and promises stay real), so none of them is served another's.
let clock = Date.parse('2026-10-02T12:00:00Z');

beforeEach(() => {
  h.auth.authToken = 'jwt-abc';
  h.auth.authenticated = true;
  h.auth.expired = false;

  clock += 60_000;
  vi.useFakeTimers({ toFake: ['Date'], now: clock });
});

afterEach(() => {
  setApiKey(null);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('useAgentHarnesses', () => {
  it('lists the harnesses with the bearer on the web', async () => {
    const fetchMock = setFetch(() => ok({ harnesses: [hermes, openclaw] }));

    const { result } = renderHook(() => useAgentHarnesses());

    await waitFor(() => expect(result.current.harnesses).toHaveLength(2));
    expect(result.current.loading).toBe(false);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/v1/intelligence/agent-harnesses');
    expect(headersOfCall(fetchMock, 0).Authorization).toBe('Bearer jwt-abc');
  });

  it('surfaces a failed request', async () => {
    setFetch(
      () => ({ ok: false, status: 500, statusText: 'Server Error', text: async () => '' }) as Response,
    );

    const { result } = renderHook(() => useAgentHarnesses());

    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.loading).toBe(false);
  });

  /**
   * ═══ "NO AGENT HARNESSES FOUND" WHILE THE SERVER LISTED TWO ═══
   *
   * `authToken` is the web JWT, null in the Capacitor app — whose durable credential is a
   * keystore API key `fetchJson` attaches as `x-api-key`. Both the hook and the fetch returned an
   * empty list when there was no JWT, without ever asking. The route is
   * `JwtOrApiKeyAuthGuard` + `memory` scope + `read` capability, which an unscoped device key
   * meets.
   */
  describe('native shell (API key, no web JWT)', () => {
    beforeEach(() => {
      h.auth.authToken = null;
      setApiKey('device-key');
    });

    it('lists the harnesses with the device key and no bearer', async () => {
      const fetchMock = setFetch(() => ok({ harnesses: [hermes, openclaw] }));

      const { result } = renderHook(() => useAgentHarnesses());

      // The hook seeds itself from the last answer it cached, so assert the request, not just the
      // state it leaves behind.
      await waitFor(() => expect(fetchMock).toHaveBeenCalled());
      await waitFor(() => expect(result.current.harnesses).toHaveLength(2));
      expect(result.current.loading).toBe(false);
      expect(result.current.error).toBeNull();

      const headers = headersOfCall(fetchMock, 0);
      expect(String(fetchMock.mock.calls[0][0])).toContain('/api/v1/intelligence/agent-harnesses');
      expect(headers['x-api-key']).toBe('device-key');
      expect(headers).not.toHaveProperty('Authorization');
    });

    it('reloads on demand with the device key', async () => {
      const fetchMock = setFetch(() => ok({ harnesses: [hermes] }));

      const { result } = renderHook(() => useAgentHarnesses());
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

      fetchMock.mockImplementation(() => Promise.resolve(ok({ harnesses: [hermes, openclaw] })));
      await act(async () => {
        await result.current.reload();
      });

      expect(result.current.harnesses).toHaveLength(2);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(headersOfCall(fetchMock, 1)['x-api-key']).toBe('device-key');
      expect(headersOfCall(fetchMock, 1)).not.toHaveProperty('Authorization');
    });

    it('asks nothing while the session is not signed in', async () => {
      h.auth.authenticated = false;
      const fetchMock = setFetch(() => ok({ harnesses: [hermes] }));

      const { result } = renderHook(() => useAgentHarnesses());

      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.harnesses).toEqual([]);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
