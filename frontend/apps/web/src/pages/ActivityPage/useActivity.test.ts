import { setApiKey } from '@ci/common';
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useActivity } from './useActivity';

// The real `useJobsAuth` and `useNeedsWebSignIn` run on top of this, so the hook is exercised
// for a web JWT session and for the native shell, whose only credential is an API key.
const h = vi.hoisted(() => ({
  auth: { authToken: 'jwt-abc' as string | null, authenticated: true, expired: false },
}));

vi.mock('@/hooks/useAuth', () => ({ useAuth: () => [h.auth, {}] }));

const ok = (body: unknown): Response =>
  ({ ok: true, status: 200, text: async () => JSON.stringify(body) }) as Response;

function setFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const mock = vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
    Promise.resolve(handler(String(input), init)),
  );
  vi.stubGlobal('fetch', mock);

  return mock;
}

beforeEach(() => {
  h.auth.authToken = 'jwt-abc';
  h.auth.authenticated = true;
  h.auth.expired = false;
});

afterEach(() => {
  setApiKey(null);
  vi.unstubAllGlobals();
});

describe('useActivity', () => {
  it('reads the ledger with the bearer on the web', async () => {
    const fetchMock = setFetch(() => ok({ items: [], nextCursor: null }));

    const { result } = renderHook(() => useActivity({}, 0));

    await waitFor(() => expect(result.current.rows).toEqual([]));
    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/tools/invocations');
    expect((fetchMock.mock.calls[0][1] as RequestInit).headers).toMatchObject({
      Authorization: 'Bearer jwt-abc',
    });
    expect(result.current.needsWebSignIn).toBe(false);
  });

  /**
   * ═══ A LEDGER THE PHONE POLLED AND COULD NEVER READ ═══
   *
   * `GET /tools/invocations` is `JwtOrPortalAuthGuard`, deliberately never an API key: the
   * ledger's whole subject is which key called what, so a key paging through its own record is
   * the one authority it should not have. The native shell holds only a device key (no web JWT),
   * so every request — the first load and then one every 15 seconds — could only 401, and the
   * page said "Could not load the ledger: Unauthorized". Say what is true, and stop asking.
   */
  describe('native shell (device key, no web JWT)', () => {
    beforeEach(() => {
      h.auth.authToken = null;
      setApiKey('device-key');
    });

    it('asks nothing and says a web sign-in is needed', async () => {
      const fetchMock = setFetch(() => ok({ items: [], nextCursor: null }));

      const { result } = renderHook(() => useActivity({}, 20));

      expect(result.current.needsWebSignIn).toBe(true);

      // Long enough for the first load and a few polls to have happened, were they going to.
      await new Promise((resolve) => setTimeout(resolve, 120));

      expect(fetchMock).not.toHaveBeenCalled();
      expect(result.current.rows).toBeNull();
      expect(result.current.error).toBeNull();
    });
  });
});
