import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDateTimeFormatter } from '@/lib/dateTimeFormat';

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

const thread = (id: string, name: string | null = null, createdAt?: string) =>
  ({ id, name, createdAt }) as unknown as Thread;

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
  // Pinned so the expected text does not depend on the machine's zone or its 12/24-hour habit.
  const fmt = createDateTimeFormatter({ timeFormat: 'h23', timeZone: 'UTC' });

  it('uses the title when there is one', () => {
    expect(threadLabel(thread('t1', 'Dinner plans', '2026-10-02T16:24:00Z'), fmt)).toBe('Dinner plans');
  });

  it('falls back to a shortened id when it has neither a title nor a start time', () => {
    expect(threadLabel(thread('abcdef1234567890'))).toBe('Thread abcdef12');
    expect(threadLabel(thread('abcdef1234567890', null, 'not a date'))).toBe('Thread abcdef12');
    expect(threadLabel(thread('abcdef1234567890', '   '))).toBe('Thread abcdef12');
  });

  // Titles arrive late (a background job after the first reply), and `Thread 01a0fd3b` is the same for every chat
  // started within about a minute — so rows in the drawer and the phone's chat list were indistinguishable.
  it('names an untitled thread for when it started, so two of them can be told apart', () => {
    const first = threadLabel(thread('01a0fd3b-aaaa', null, '2026-10-02T16:24:00Z'), fmt);
    const second = threadLabel(thread('01a0fd3b-bbbb', null, '2026-10-02T16:25:30Z'), fmt);

    expect(first).toMatch(/^Chat · .*16:24/);
    expect(second).toMatch(/^Chat · .*16:25/);
    expect(first).not.toBe(second);
    expect(first).not.toContain('01a0fd3b');
  });

  it('writes the time the way the person chose to read times', () => {
    const h12 = createDateTimeFormatter({ timeFormat: 'h12', timeZone: 'UTC' });

    expect(threadLabel(thread('t1', null, '2026-10-02T16:24:00Z'), h12)).toMatch(/4:24\s?PM/);
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
