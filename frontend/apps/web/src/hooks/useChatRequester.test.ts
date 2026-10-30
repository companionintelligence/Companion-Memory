import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Channel, FrameEncoder } from '@/components/Chat/utils';

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

  // The server sends a keep-alive frame as soon as the turn starts (so a tunnel lets the headers
  // through). It isn't the reply: the "working" dots must stay up until the model says something.
  it('keeps waiting for the reply through keep-alive frames', async () => {
    const frames = new FrameEncoder();
    let push: (bytes: Uint8Array) => void = () => undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        push = (bytes) => controller.enqueue(bytes);
        controller.enqueue(frames.encodeFrame(Channel.KEEPALIVE, ''));
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(body, { status: 200, headers: { 'X-Thread-Id': 't-1' } }))),
    );

    const { result } = renderHook(() => useChatRequester({ threadId: null }));

    await act(async () => {
      await result.current[1].submit({ message: 'hello', fileIds: [] });
    });
    await waitFor(() => expect(result.current[0].streaming).toBe(true));
    const reader = result.current[0].stream!.getReader();

    await act(async () => {
      await reader.read();
    });
    expect(result.current[0].hasStartedReceiving).toBe(false);

    await act(async () => {
      push(frames.encodeFrame(Channel.KEEPALIVE, ''));
      await reader.read();
    });
    expect(result.current[0].hasStartedReceiving).toBe(false);

    await act(async () => {
      push(frames.encodeFrame(Channel.TEXT, 'Hi there'));
      await reader.read();
    });
    expect(result.current[0].hasStartedReceiving).toBe(true);
  });

  it('names the action only on the turn that starts a thread', async () => {
    // The Today action window: the server opens the new thread with the action
    // and links it, so the action id rides on the first turn and no other.
    const fetchMock = vi.fn((_input: RequestInfo, _init?: RequestInit) =>
      Promise.resolve(streamResponse('t-1')),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { result, rerender } = renderHook(
      ({ threadId }: { threadId: string | null }) => useChatRequester({ threadId, actionId: 'action-1' }),
      { initialProps: { threadId: null as string | null } },
    );

    await act(async () => {
      await result.current[1].submit({ message: 'Why do you suggest this?', fileIds: [] });
    });

    rerender({ threadId: 't-1' });

    await act(async () => {
      await result.current[1].submit({ message: 'And then?', fileIds: [] });
    });

    const bodies = fetchMock.mock.calls
      .filter(([input]) => String(input).includes('/api/llm/generate'))
      .map(([, init]) => JSON.parse(String(init?.body)));

    expect(bodies[0]).toMatchObject({ threadId: null, actionId: 'action-1' });
    expect(bodies[1].threadId).toBe('t-1');
    expect(bodies[1]).not.toHaveProperty('actionId');
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

  /**
   * `Chat` takes the user's bubble back when a send returns false (the text stays in the composer), so a send that
   * fails must say why — nothing in the transcript is left to show it was even tried.
   */
  it('says why when the appliance refuses the request', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('nope', { status: 500 }))),
    );

    const { result } = renderHook(() => useChatRequester({ threadId: null }));

    await act(async () => {
      await result.current[1].submit({ message: 'hello', fileIds: [] });
    });

    expect(h.toastError).toHaveBeenCalledTimes(1);
    expect(h.toastError).toHaveBeenCalledWith(expect.stringContaining('could not answer'));
  });

  it('says why when the appliance cannot be reached and nothing on the phone can answer', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    );

    const { result } = renderHook(() => useChatRequester({ threadId: null }));

    await act(async () => {
      await result.current[1].submit({ message: 'hello', fileIds: [] });
    });

    expect(h.toastError).toHaveBeenCalledTimes(1);
    expect(h.toastError).toHaveBeenCalledWith(expect.stringContaining('Could not reach your Companion'));
    // The raw fetch error is for the log, not for a person.
    expect(h.toastError).not.toHaveBeenCalledWith(expect.stringContaining('Failed to fetch'));
  });

  it('stays quiet when the person stops a request themselves', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          );
        });
      }),
    );

    const { result } = renderHook(() => useChatRequester({ threadId: null }));
    let turn!: Promise<boolean>;

    act(() => {
      turn = result.current[1].submit({ message: 'hello', fileIds: [] });
    });
    await act(async () => {
      result.current[1].detach();
      await turn;
    });

    expect(h.toastError).not.toHaveBeenCalled();
  });
});
