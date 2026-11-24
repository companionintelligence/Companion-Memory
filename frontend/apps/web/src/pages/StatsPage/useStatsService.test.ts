import { setApiKey } from '@ci/common';
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useStatsService, type MemoryStats } from './useStatsService';

// The real `useSessionAuth` runs on top of this, so the hook is exercised for a web JWT
// session and for the native shell, whose only credential is an API key.
const h = vi.hoisted(() => ({
  auth: { authToken: 'jwt-abc' as string | null, authenticated: true, expired: false },
}));

vi.mock('@/hooks/useAuth', () => ({ useAuth: () => [h.auth, {}] }));

const stats: MemoryStats = {
  totals: { events: 12, entities: 8, relationships: 3 },
  dateRange: { earliest: null, latest: null },
  bySource: [],
  byTag: [],
  byEntityType: [],
  byRelationshipType: [],
  spend: { rows: [] },
  time: { mode: 'counts', coverage: { timedEvents: 0, consideredEvents: 0 }, rows: [] },
  conversations: { rows: [] },
  social: { granularity: 'week', rows: [] },
  channels: { rows: [] },
  insights: [],
};

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

beforeEach(() => {
  h.auth.authToken = 'jwt-abc';
  h.auth.authenticated = true;
  h.auth.expired = false;
});

afterEach(() => {
  setApiKey(null);
  vi.unstubAllGlobals();
});

describe('useStatsService', () => {
  it('loads the stats with the bearer on the web', async () => {
    const fetchMock = setFetch(() => ok({ success: true, data: stats }));

    const { result } = renderHook(() => useStatsService('all'));

    await waitFor(() => expect(result.current.data).toEqual(stats));
    expect(result.current.loading).toBe(false);
    expect(String(fetchMock.mock.calls[0][0])).toContain('/api/graph/stats');
    expect(headersOfCall(fetchMock, 0).Authorization).toBe('Bearer jwt-abc');
  });

  it('surfaces a failed request instead of staying on the skeleton', async () => {
    setFetch(
      () => ({ ok: false, status: 500, statusText: 'Server Error', text: async () => '' }) as Response,
    );

    const { result } = renderHook(() => useStatsService('all'));

    await waitFor(() => expect(result.current.error).not.toBeNull());
    expect(result.current.loading).toBe(false);
  });

  /**
   * ═══ SELF > STATS WAS A BLANK SKELETON ON THE PHONE ═══
   *
   * `authToken` is the web JWT, null in the Capacitor app — whose durable credential is a
   * keystore API key `fetchJson` attaches as `x-api-key`. `load` returned before it asked,
   * and `loading` starts true, so the page showed skeleton blocks forever.
   * `GET /graph/stats` is `JwtOrApiKeyAuthGuard`: the key is accepted.
   */
  describe('native shell (API key, no web JWT)', () => {
    beforeEach(() => {
      h.auth.authToken = null;
      setApiKey('device-key');
    });

    it('loads the stats with the device key and no bearer', async () => {
      const fetchMock = setFetch(() => ok({ success: true, data: stats }));

      const { result } = renderHook(() => useStatsService('all'));

      await waitFor(() => expect(result.current.data).toEqual(stats));
      expect(result.current.loading).toBe(false);
      expect(result.current.error).toBeNull();

      const headers = headersOfCall(fetchMock, 0);
      expect(headers['x-api-key']).toBe('device-key');
      expect(headers).not.toHaveProperty('Authorization');
    });

    it('re-fetches when the range changes', async () => {
      const fetchMock = setFetch(() => ok({ success: true, data: stats }));

      const { result, rerender } = renderHook(({ range }) => useStatsService(range), {
        initialProps: { range: 'all' as 'all' | '30d' },
      });
      await waitFor(() => expect(result.current.data).not.toBeNull());

      rerender({ range: '30d' });

      await waitFor(() => expect(fetchMock.mock.calls.length).toBe(2));
      expect(String(fetchMock.mock.calls[1][0])).toContain('from=');
    });
  });
});
