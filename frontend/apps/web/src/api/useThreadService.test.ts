import { FetchJsonError } from '@ci/common';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useThreadService } from './useThreadService';

// The real `useSessionAuth` runs on top of this.
const h = vi.hoisted(() => ({
  auth: { authToken: 'jwt-abc' as string | null, authenticated: true, expired: false },
}));

vi.mock('@/hooks/useAuth', () => ({ useAuth: () => [h.auth, {}] }));

function reply(status: number, body: unknown = { message: 'Not Found' }): Promise<Response> {
  return Promise.resolve({
    ok: status < 400,
    status,
    statusText: status === 404 ? 'Not Found' : 'Error',
    text: async () => JSON.stringify(body),
  } as Response);
}

const thread = (id: string) => ({ id, name: `Chat ${id}`, messages: [] });

/** Answers `GET /api/threads/:id` through `answer`, which is handed the id. */
function stubThreads(answer: (id: string) => Promise<Response>) {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL) => answer(/\/api\/threads\/([^?]+)/.exec(String(input))?.[1] ?? '')),
  );
}

beforeEach(() => {
  h.auth.authToken = 'jwt-abc';
  h.auth.authenticated = true;
  h.auth.expired = false;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('useThreadService', () => {
  it('reports a thread the server no longer has as a 404 the page can recognise', async () => {
    stubThreads(() => reply(404));

    const { result } = renderHook(() => useThreadService('gone'));

    await waitFor(() => expect(result.current[0].error).toBeInstanceOf(FetchJsonError));
    expect((result.current[0].error as FetchJsonError).status).toBe(404);
    expect(result.current[0].thread).toBeNull();
  });

  /**
   * The failure belongs to the request that produced it. It used to outlive the page moving on to another chat, so
   * a chat that loaded fine (or was still loading) sat under the previous one's "could not load" message.
   */
  it('does not carry the last chat’s failure into the next chat, while it loads or after', async () => {
    let release: (response: Response) => void = () => undefined;

    stubThreads((id) =>
      id === 'gone'
        ? reply(404)
        : new Promise<Response>((resolve) => {
            release = resolve;
          }),
    );

    const { result, rerender } = renderHook(({ id }) => useThreadService(id), {
      initialProps: { id: 'gone' },
    });

    await waitFor(() => expect(result.current[0].error).not.toBeNull());

    rerender({ id: 'live' });

    await waitFor(() => expect(result.current[0].loading).toBe(true));
    expect(result.current[0].error).toBeNull();

    await act(async () => {
      release(await reply(200, thread('live')));
    });

    await waitFor(() => expect(result.current[0].thread?.id).toBe('live'));
    expect(result.current[0].error).toBeNull();
  });

  it('clears a failure once a retry gets through', async () => {
    let up = false;

    stubThreads(() => (up ? reply(200, thread('t1')) : reply(500, { message: 'down' })));

    const { result } = renderHook(() => useThreadService('t1'));

    await waitFor(() => expect(result.current[0].error).not.toBeNull());

    up = true;
    act(() => {
      result.current[1].refetch();
    });

    await waitFor(() => expect(result.current[0].thread?.id).toBe('t1'));
    expect(result.current[0].error).toBeNull();
  });
});
