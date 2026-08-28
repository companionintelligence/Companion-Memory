import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Thread } from './types';
import { useThreadListService } from './useThreadListService';

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

const thread = (id: string) => ({ id, title: `Thread ${id}` }) as unknown as Thread;

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

describe('useThreadListService', () => {
  it('loads threads on mount', async () => {
    setFetch(() => ok([thread('t1'), thread('t2')]));

    const { result } = renderHook(() => useThreadListService());

    await waitFor(() => expect(result.current[0].threads).toHaveLength(2));
    expect(result.current[0].loading).toBe(false);
  });

  it('deletes a thread and removes it from the list', async () => {
    const fetchMock = setFetch((_url, init) => {
      if (init?.method === 'DELETE') {
        return { ok: true, status: 200 } as Response;
      }

      return ok([thread('t1'), thread('t2')]);
    });

    const { result } = renderHook(() => useThreadListService());
    await waitFor(() => expect(result.current[0].threads).toHaveLength(2));

    await act(async () => {
      await result.current[1].delete('t1');
    });

    expect(result.current[0].threads.map((t) => t.id)).toEqual(['t2']);
    expect(fetchMock).toHaveBeenCalledWith('/api/threads/t1', expect.objectContaining({ method: 'DELETE' }));
  });

  it('throws when a delete fails', async () => {
    setFetch((_url, init) => {
      if (init?.method === 'DELETE') {
        return { ok: false, status: 500 } as Response;
      }

      return ok([thread('t1')]);
    });

    const { result } = renderHook(() => useThreadListService());
    await waitFor(() => expect(result.current[0].threads).toHaveLength(1));

    await expect(result.current[1].delete('t1')).rejects.toThrow(/Failed to delete/);
  });

  it('polls the thread list while any thread is queued or running', async () => {
    const setIntervalSpy = vi.spyOn(window, 'setInterval');
    setFetch(() => ok([{ ...thread('t1'), generationStatus: 'running' }]));

    try {
      const { result } = renderHook(() => useThreadListService());

      await waitFor(() => expect(result.current[0].threads).toHaveLength(1));
      expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 2000);
    } finally {
      setIntervalSpy.mockRestore();
    }
  });

  it('captures an error when the list request fails', async () => {
    setFetch(() => ({ ok: false, status: 500, text: async () => '' }) as Response);

    const { result } = renderHook(() => useThreadListService());

    await waitFor(() => expect(result.current[0].error).toBeTruthy());
    expect(result.current[0].threads).toEqual([]);
  });

  it('loads threads when authenticated with no JWT (native API key session)', async () => {
    h.auth.authToken = null;
    h.auth.authenticated = true;
    const fetchMock = setFetch(() => ok([thread('t1')]));

    const { result } = renderHook(() => useThreadListService());

    await waitFor(() => expect(result.current[0].threads).toHaveLength(1));
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect((init?.headers as Record<string, string> | undefined)?.Authorization).toBeUndefined();
  });
});
