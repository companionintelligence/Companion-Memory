import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useChatRequester } from './useChatRequester';

// Mutable holder so each test can vary auth/model state; mocks read it lazily.
const h = vi.hoisted(() => ({
  toastError: vi.fn(),
  toastInfo: vi.fn(),
  model: {
    selectedModel: 'llama3',
    thinkingEnabled: false,
    toolsEnabled: false,
    activeModels: [] as Array<{ model: string; tools: boolean; thinking: boolean }>,
  },
}));

vi.mock('@ci/shadcn', () => ({ useToast: () => ({ toast: { error: h.toastError, info: h.toastInfo } }) }));
const auth = vi.hoisted(() => ({
  authToken: 'tok' as string | null,
  authenticated: true,
  expired: false,
}));

vi.mock('./useAuth', () => ({
  useAuth: () => [
    { authToken: auth.authToken, authenticated: auth.authenticated, expired: auth.expired },
    {},
  ],
}));
vi.mock('./useModel', () => ({ useModel: () => [h.model, {}] }));

function streamResponse(threadId = 'new-thread') {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('hi'));
      controller.close();
    },
  });

  return new Response(body, { status: 200, headers: { 'X-Thread-Id': threadId } });
}

beforeEach(() => {
  auth.authToken = 'tok';
  auth.authenticated = true;
  auth.expired = false;
  h.model = {
    selectedModel: 'llama3',
    thinkingEnabled: false,
    toolsEnabled: false,
    activeModels: [{ model: 'llama3', tools: true, thinking: true }],
  };
  h.toastError.mockClear();
  h.toastInfo.mockClear();
});

afterEach(() => vi.unstubAllGlobals());

describe('useChatRequester', () => {
  it('does nothing for a blank message', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useChatRequester({ threadId: null }));

    let returned: boolean | undefined;
    await act(async () => {
      returned = await result.current[1].submit({ message: '   ', fileIds: [] });
    });

    expect(returned).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses to send when tools are on but the model lacks tool support', async () => {
    h.model = {
      selectedModel: 'm',
      toolsEnabled: true,
      thinkingEnabled: false,
      activeModels: [{ model: 'm', tools: false, thinking: true }],
    };
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useChatRequester({ threadId: null }));

    let returned: boolean | undefined;
    await act(async () => {
      returned = await result.current[1].submit({ message: 'hi', fileIds: [] });
    });

    expect(returned).toBe(false);
    expect(h.toastError).toHaveBeenCalledWith(expect.stringContaining('tools'));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses to send when thinking is on but the model lacks thinking support', async () => {
    h.model = {
      selectedModel: 'm',
      toolsEnabled: false,
      thinkingEnabled: true,
      activeModels: [{ model: 'm', tools: true, thinking: false }],
    };
    vi.stubGlobal('fetch', vi.fn());

    const { result } = renderHook(() => useChatRequester({ threadId: null }));

    let returned: boolean | undefined;
    await act(async () => {
      returned = await result.current[1].submit({ message: 'hi', fileIds: [] });
    });

    expect(returned).toBe(false);
    expect(h.toastError).toHaveBeenCalledWith(expect.stringContaining('thinking'));
  });

  it('streams a reply and reports a new thread id', async () => {
    const onNewThread = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(streamResponse('thread-42'))),
    );

    const { result } = renderHook(() => useChatRequester({ threadId: null, onNewThread }));

    let returned: boolean | undefined;
    await act(async () => {
      returned = await result.current[1].submit({ message: 'hello', fileIds: [] });
    });

    expect(returned).toBe(true);
    expect(onNewThread).toHaveBeenCalledWith('thread-42');
    await waitFor(() => expect(result.current[0].streaming).toBe(true));
    expect(result.current[0].stream).not.toBeNull();
  });

  it('stop() tears down the active stream', async () => {
    const fetchMock = vi.fn((input: RequestInfo) => {
      const url = String(input);

      if (url.includes('/cancel')) {
        return Promise.resolve(new Response(null, { status: 204 }));
      }

      return Promise.resolve(streamResponse('thread-9'));
    });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useChatRequester({ threadId: null }));
    await act(async () => {
      await result.current[1].submit({ message: 'hello', fileIds: [] });
    });

    act(() => result.current[1].stop());

    expect(result.current[0].streaming).toBe(false);
    expect(result.current[0].stream).toBeNull();
    expect(
      fetchMock.mock.calls.some((call) => String(call[0]).includes('/llm/threads/thread-9/cancel')),
    ).toBe(true);
  });

  it('detach() closes the viewer without posting cancel', async () => {
    const fetchMock = vi.fn((input: RequestInfo) => {
      void input;

      return Promise.resolve(streamResponse('thread-9'));
    });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useChatRequester({ threadId: 'thread-9' }));
    await act(async () => {
      await result.current[1].submit({ message: 'hello', fileIds: [] });
    });

    act(() => result.current[1].detach());

    expect(result.current[0].streaming).toBe(false);
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('/cancel'))).toBe(false);
  });

  it('unmount detaches the viewer without cancelling the job', async () => {
    const fetchMock = vi.fn((input: RequestInfo) => {
      void input;

      return Promise.resolve(streamResponse('thread-9'));
    });
    vi.stubGlobal('fetch', fetchMock);

    const { result, unmount } = renderHook(() => useChatRequester({ threadId: 'thread-9' }));
    await act(async () => {
      await result.current[1].submit({ message: 'hello', fileIds: [] });
    });

    unmount();

    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes('/cancel'))).toBe(false);
  });

  it('attach() opens GET /llm/threads/:id/stream', async () => {
    const fetchMock = vi.fn((input: RequestInfo) => {
      void input;

      return Promise.resolve(streamResponse('thread-7'));
    });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useChatRequester({ threadId: 'thread-7' }));
    await act(async () => {
      await result.current[1].attach('thread-7');
    });

    expect(String(fetchMock.mock.calls[0]?.[0])).toContain('/api/llm/threads/thread-7/stream');
    await waitFor(() => expect(result.current[0].streaming).toBe(true));
  });

  it('attach() returns false on 204 so the page can load the finished messages', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((input: RequestInfo) => {
        void input;

        return Promise.resolve(new Response(null, { status: 204 }));
      }),
    );

    const { result } = renderHook(() => useChatRequester({ threadId: 'thread-7' }));
    let attached: boolean | undefined;
    await act(async () => {
      attached = await result.current[1].attach('thread-7');
    });

    expect(attached).toBe(false);
    expect(result.current[0].stream).toBeNull();
  });

  it('omits Authorization when there is no JWT (native API key session)', async () => {
    auth.authToken = null;
    const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(streamResponse('thread-n')));
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useChatRequester({ threadId: null }));
    await act(async () => {
      await result.current[1].submit({ message: 'hello', fileIds: [] });
    });

    const init = fetchMock.mock.calls[0]?.[1];
    expect((init?.headers as Record<string, string> | undefined)?.Authorization).toBeUndefined();
  });

  it('captures an error when the request is not ok', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('nope', { status: 500 }))),
    );

    const { result } = renderHook(() => useChatRequester({ threadId: null }));

    let returned: boolean | undefined;
    await act(async () => {
      returned = await result.current[1].submit({ message: 'hello', fileIds: [] });
    });

    expect(returned).toBe(false);
    await waitFor(() => expect(result.current[0].error).toBeTruthy());
  });
});
