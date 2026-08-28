import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Thread } from './types';
import { RECENT_THREAD_LIMIT, threadLabel, useRecentThreads } from './useRecentThreads';

const h = vi.hoisted(() => ({
  auth: {
    authToken: 'tok' as string | null,
    authenticated: true,
    expired: false,
    loading: false,
    error: null,
  },
}));

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => [h.auth, {}],
}));

const thread = (id: string, name: string | null = null) => ({ id, name }) as unknown as Thread;

function setFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const mock = vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
    Promise.resolve(handler(String(input), init)),
  );
  vi.stubGlobal('fetch', mock);

  return mock;
}

const ok = (body: unknown): Response =>
  ({ ok: true, status: 200, text: async () => JSON.stringify(body) }) as Response;

beforeEach(() => {
  h.auth.authToken = 'tok';
  h.auth.authenticated = true;
  h.auth.expired = false;
});

afterEach(() => vi.unstubAllGlobals());

describe('threadLabel', () => {
  it('names an unnamed thread by a shortened id', () => {
    expect(threadLabel(thread('abcdef1234567890'))).toBe('Thread abcdef12');
    expect(threadLabel(thread('t1', 'Dinner plans'))).toBe('Dinner plans');
  });
});

describe('useRecentThreads', () => {
  // The rail renders on every page. An eager list would be a request per
  // navigation for a menu nobody opened.
  it('stays idle until it is enabled', async () => {
    const fetchMock = setFetch(() => ok([thread('t1')]));

    const { rerender, result } = renderHook(({ enabled }) => useRecentThreads({ enabled }), {
      initialProps: { enabled: false },
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.threads).toEqual([]);

    rerender({ enabled: true });

    await waitFor(() => expect(result.current.threads).toHaveLength(1));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('caps the list at the newest few, in the order the API returned them', async () => {
    const many = Array.from({ length: RECENT_THREAD_LIMIT + 5 }, (_, i) => thread(`t${i}`, `Thread ${i}`));
    setFetch(() => ok(many));

    const { result } = renderHook(() => useRecentThreads({ enabled: true }));

    await waitFor(() => expect(result.current.threads).toHaveLength(RECENT_THREAD_LIMIT));
    expect(result.current.threads[0].id).toBe('t0');
    expect(result.current.threads.at(-1)?.id).toBe(`t${RECENT_THREAD_LIMIT - 1}`);
  });

  it('honours an explicit limit', async () => {
    setFetch(() => ok([thread('t1'), thread('t2'), thread('t3')]));

    const { result } = renderHook(() => useRecentThreads({ enabled: true, limit: 2 }));

    await waitFor(() => expect(result.current.threads).toHaveLength(2));
  });

  // Hovering the desktop rail flickers `enabled`; that must not be a request
  // each time the pointer crosses the row.
  it('does not refetch a fresh list when it is re-enabled', async () => {
    const fetchMock = setFetch(() => ok([thread('t1')]));

    const { rerender, result } = renderHook(({ enabled }) => useRecentThreads({ enabled }), {
      initialProps: { enabled: true },
    });

    await waitFor(() => expect(result.current.threads).toHaveLength(1));

    rerender({ enabled: false });
    rerender({ enabled: true });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.threads).toHaveLength(1);
  });

  it('surfaces an error and lets the next open try again', async () => {
    const fetchMock = setFetch(() => ({ ok: false, status: 500, text: async () => '' }) as Response);

    const { rerender, result } = renderHook(({ enabled }) => useRecentThreads({ enabled }), {
      initialProps: { enabled: true },
    });

    await waitFor(() => expect(result.current.error).toBeTruthy());
    expect(result.current.threads).toEqual([]);

    setFetch(() => ok([thread('t1')]));
    rerender({ enabled: false });
    rerender({ enabled: true });

    await waitFor(() => expect(result.current.threads).toHaveLength(1));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fetches when authenticated with no JWT (native API key session)', async () => {
    h.auth.authToken = null;
    h.auth.authenticated = true;
    const fetchMock = setFetch(() => ok([thread('t1')]));

    const { result } = renderHook(() => useRecentThreads({ enabled: true }));

    await waitFor(() => expect(result.current.threads).toHaveLength(1));
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect((init?.headers as Record<string, string> | undefined)?.Authorization).toBeUndefined();
  });
});
