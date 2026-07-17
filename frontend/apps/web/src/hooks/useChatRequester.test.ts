import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useChatRequester } from './useChatRequester';

// Mutable holder so each test can vary auth/model state; mocks read it lazily.
const h = vi.hoisted(() => ({
  toastError: vi.fn(),
  model: {
    selectedModel: 'llama3',
    thinkingEnabled: false,
    toolsEnabled: false,
    activeModels: [] as Array<{ model: string; tools: boolean; thinking: boolean }>,
  },
}));

vi.mock('@ci/shadcn', () => ({ useToast: () => ({ toast: { error: h.toastError } }) }));
vi.mock('./useAuth', () => ({ useAuth: () => [{ authToken: 'tok' }, {}] }));
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
  h.model = {
    selectedModel: 'llama3',
    thinkingEnabled: false,
    toolsEnabled: false,
    activeModels: [{ model: 'llama3', tools: true, thinking: true }],
  };
  h.toastError.mockClear();
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
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(streamResponse())),
    );

    const { result } = renderHook(() => useChatRequester({ threadId: null }));
    await act(async () => {
      await result.current[1].submit({ message: 'hello', fileIds: [] });
    });

    act(() => result.current[1].stop());

    expect(result.current[0].streaming).toBe(false);
    expect(result.current[0].stream).toBeNull();
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
