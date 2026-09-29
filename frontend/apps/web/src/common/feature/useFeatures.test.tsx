import { type ReactNode } from 'react';

import { setApiBaseUrl, setApiKey } from '@ci/common';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';


import { FeaturesProvider, useFeatures } from './useFeatures';

const h = vi.hoisted(() => ({
  auth: {
    authToken: 'test-token' as string | null,
    subject: 'user-a' as string | null,
    initializing: false,
    authenticated: undefined as boolean | undefined,
  },
}));

// useFeatures pulls useAuth from the @/hooks barrel — mock just that surface so
// the real (heavy) hook barrel never loads.
vi.mock('@/hooks', () => ({
  useAuth: () => [
    {
      ...h.auth,
      authenticated: h.auth.authenticated ?? Boolean(h.auth.authToken),
      expired: false,
      loading: false,
      error: null,
    },
    {},
  ],
}));

/** Per-user flags keyed by subject, so a session change is observable. */
const USER_FLAGS: Record<string, Record<string, boolean>> = {
  'user-a': { 'insights.page': true },
  'user-b': { 'stats.page': true },
};

function ok(body: unknown): Response {
  return { ok: true, status: 200, text: async () => JSON.stringify(body) } as Response;
}

function isGlobal(input: RequestInfo | URL) {
  return String(input).endsWith('/global');
}

function setFetch() {
  const mock = vi.fn((input: RequestInfo | URL) =>
    Promise.resolve(ok(isGlobal(input) ? { 'files.page': true } : (USER_FLAGS[h.auth.subject ?? ''] ?? {}))),
  );
  vi.stubGlobal('fetch', mock);

  return mock;
}

/**
 * Like {@link setFetch}, but holds each per-user request open and tags it with
 * the subject it was made for, so a response can be landed after the session
 * that asked for it has already been replaced.
 */
function setDeferredFetch() {
  const pending: Array<{ subject: string | null; resolve: () => void }> = [];

  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => {
      if (isGlobal(input)) {
        return Promise.resolve(ok({ 'files.page': true }));
      }

      const forSubject = h.auth.subject;

      return new Promise<Response>((resolve) => {
        pending.push({ subject: forSubject, resolve: () => resolve(ok(USER_FLAGS[forSubject ?? ''] ?? {})) });
      });
    }),
  );

  return {
    pending,
    land: (subject: string) => act(async () => pending.find((p) => p.subject === subject)?.resolve()),
  };
}

function countUserFetches(mock: ReturnType<typeof setFetch>) {
  return mock.mock.calls.filter(([u]) => String(u).endsWith('/api/_internal/features')).length;
}

beforeEach(() => {
  h.auth = { authToken: 'test-token', subject: 'user-a', initializing: false, authenticated: undefined };
  delete (window as unknown as { Capacitor?: unknown }).Capacitor;
  setApiKey(null);
  setApiBaseUrl('');
});

const wrapper = ({ children }: { children: ReactNode }) => (
  <FeaturesProvider args={[]}>{children}</FeaturesProvider>
);

afterEach(() => vi.unstubAllGlobals());

describe('useFeatures', () => {
  it('reports a per-user feature as enabled after fetch', async () => {
    setFetch();
    const { result } = renderHook(() => useFeatures(), { wrapper });

    await waitFor(() => expect(result.current.isFeatureEnabled('insights.page')).toBe(true));
  });

  it('reports a global feature as enabled', async () => {
    setFetch();
    const { result } = renderHook(() => useFeatures(), { wrapper });

    await waitFor(() => expect(result.current.isFeatureEnabled('files.page')).toBe(true));
  });

  it('reports unknown features as disabled', async () => {
    setFetch();
    const { result } = renderHook(() => useFeatures(), { wrapper });

    await waitFor(() => expect(result.current.isFeatureEnabled('insights.page')).toBe(true));
    expect(result.current.isFeatureEnabled('does.not.exist')).toBe(false);
  });

  it('reports loading until both flag sets have answered', async () => {
    setFetch();
    const { result } = renderHook(() => useFeatures(), { wrapper });

    expect(result.current.loading).toBe(true);

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.isFeatureEnabled('insights.page')).toBe(true);
  });

  it('stops loading once a failed fetch has answered', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('offline'))),
    );
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const { result } = renderHook(() => useFeatures(), { wrapper });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.isFeatureEnabled('insights.page')).toBe(false);
  });

  it('stays loading while the session handshake is still in flight', async () => {
    h.auth = { authToken: null, subject: null, initializing: true, authenticated: undefined };
    setFetch();

    const { result } = renderHook(() => useFeatures(), { wrapper });

    // The global set answers, but a token may still arrive and bring per-user
    // flags with it — calling that "all flags off" would be premature.
    await waitFor(() => expect(result.current.isFeatureEnabled('files.page')).toBe(true));
    expect(result.current.loading).toBe(true);
  });

  it('settles for a signed-out visitor once the handshake finishes with no token', async () => {
    h.auth = { authToken: null, subject: null, initializing: false, authenticated: undefined };
    setFetch();

    const { result } = renderHook(() => useFeatures(), { wrapper });

    await waitFor(() => expect(result.current.loading).toBe(false));
  });

  // This provider lives above the router, so it survives a sign-out and the next
  // sign-in. Nothing may carry across that boundary.
  it('drops the previous session flags when a different user signs in', async () => {
    setFetch();
    const { result, rerender } = renderHook(() => useFeatures(), { wrapper });

    await waitFor(() => expect(result.current.isFeatureEnabled('insights.page')).toBe(true));

    h.auth = { authToken: 'token-b', subject: 'user-b', initializing: false, authenticated: undefined };
    rerender();

    await waitFor(() => expect(result.current.isFeatureEnabled('stats.page')).toBe(true));
    expect(result.current.isFeatureEnabled('insights.page')).toBe(false);
  });

  it('forgets per-user flags on sign-out', async () => {
    setFetch();
    const { result, rerender } = renderHook(() => useFeatures(), { wrapper });

    await waitFor(() => expect(result.current.isFeatureEnabled('insights.page')).toBe(true));

    h.auth = { authToken: null, subject: null, initializing: false, authenticated: undefined };
    rerender();

    await waitFor(() => expect(result.current.isFeatureEnabled('insights.page')).toBe(false));
    // Global flags are not per-session, and there is nothing left to wait for.
    expect(result.current.isFeatureEnabled('files.page')).toBe(true);
    expect(result.current.loading).toBe(false);
  });

  // The JWT rotates every few minutes for the same user. Treating that as a new
  // identity would drop the flags and take gated routes back out of the route
  // table — the exact flash `loading` exists to prevent.
  it('keeps flags and stays settled across a token rotation', async () => {
    const fetchMock = setFetch();
    const { result, rerender } = renderHook(() => useFeatures(), { wrapper });

    await waitFor(() => expect(result.current.isFeatureEnabled('insights.page')).toBe(true));
    const before = countUserFetches(fetchMock);

    h.auth = { authToken: 'test-token-rotated', subject: 'user-a', initializing: false, authenticated: undefined };
    rerender();

    expect(result.current.isFeatureEnabled('insights.page')).toBe(true);
    expect(result.current.loading).toBe(false);
    expect(countUserFetches(fetchMock)).toBe(before);
  });

  // The reset above clears the cache the moment the session changes, but a
  // request made for the old session is still in flight and will write when it
  // returns. It has to be dropped, or it reinstates exactly what was cleared.
  it('ignores a per-user response that arrives after the session changed', async () => {
    const { pending, land } = setDeferredFetch();
    const { result, rerender } = renderHook(() => useFeatures(), { wrapper });

    await waitFor(() => expect(pending).toHaveLength(1));

    h.auth = { authToken: 'token-b', subject: 'user-b', initializing: false, authenticated: undefined };
    rerender();

    await waitFor(() => expect(pending).toHaveLength(2));

    await land('user-a');

    expect(result.current.isFeatureEnabled('insights.page')).toBe(false);
    // And it must not count as an answer either: user-b's flags are still unknown.
    expect(result.current.loading).toBe(true);

    await land('user-b');

    await waitFor(() => expect(result.current.isFeatureEnabled('stats.page')).toBe(true));
    expect(result.current.loading).toBe(false);
  });

  it('loads Jobs, Tasks, and Profile from the API key when the phone has no session token', async () => {
    (window as unknown as { Capacitor?: { isNativePlatform: () => boolean } }).Capacitor = {
      isNativePlatform: () => true,
    };
    setApiBaseUrl('https://memory.example.com');
    setApiKey('native-key');
    h.auth = { authToken: null, subject: null, initializing: false, authenticated: true };

    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      void init;

      return Promise.resolve(
        ok(
          isGlobal(input)
            ? { 'require.signup.codes': false }
            : { 'jobs.page': true, 'planning.page': true, 'self.page': true },
        ),
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useFeatures(), { wrapper });

    await waitFor(() => expect(result.current.isFeatureEnabled('jobs.page')).toBe(true));
    expect(result.current.isFeatureEnabled('planning.page')).toBe(true);
    expect(result.current.isFeatureEnabled('self.page')).toBe(true);

    const userCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/api/_internal/features'));
    const headers = (userCall?.[1]?.headers ?? {}) as Record<string, string>;

    expect(headers['x-api-key']).toBe('native-key');
    expect(headers.Authorization ?? headers.authorization).toBeUndefined();
  });

  it('refresh forces a refetch', async () => {
    const fetchMock = setFetch();
    const { result } = renderHook(() => useFeatures(), { wrapper });
    await waitFor(() => expect(result.current.isFeatureEnabled('insights.page')).toBe(true));

    const featureCallsBefore = fetchMock.mock.calls.filter(([u]) =>
      String(u).endsWith('/api/_internal/features'),
    ).length;

    await act(async () => {
      await result.current.refresh();
    });

    const featureCallsAfter = fetchMock.mock.calls.filter(([u]) =>
      String(u).endsWith('/api/_internal/features'),
    ).length;
    expect(featureCallsAfter).toBeGreaterThan(featureCallsBefore);
  });
});
