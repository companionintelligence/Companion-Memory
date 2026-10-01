import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Channel, FrameDecoder } from '@/components/Chat/utils';

import { ApplianceRefusedError, isApplianceUnreachable, useChatRequester } from './useChatRequester';

// The on-device seams are mocked at the @ci/common boundary; everything else in @ci/common stays real so
// `streamingFetch` (and so the appliance path) behaves exactly as it does in useChatRequester.test.ts.
const llm = vi.hoisted(() => ({
  prefs: {
    mode: 'appliance' as 'appliance' | 'auto' | 'device',
    modelId: 'qwen3-0.6b-int4' as string | null,
    accelerator: null as 'cpu' | 'gpu' | null,
    thinking: false,
    speculativeDecoding: true,
    intentTools: true,
  },
  ready: true,
  ensureLoaded: vi.fn(async () => ({ alreadyLoaded: true, accelerator: 'cpu' })),
  stream: vi.fn(),
  reset: vi.fn(async () => {}),
}));

vi.mock('@ci/common', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ci/common')>()),
  getLocalLlmPrefs: () => llm.prefs,
  isLocalLlmReady: async () => llm.ready,
  ensureLocalLlmLoaded: (...args: unknown[]) => (llm.ensureLoaded as (...a: unknown[]) => unknown)(...args),
  streamLocalLlm: (...args: unknown[]) => (llm.stream as (...a: unknown[]) => unknown)(...args),
  resetLocalLlmConversation: () => llm.reset(),
}));

const h = vi.hoisted(() => ({
  toastError: vi.fn(),
  toastInfo: vi.fn(),
  model: {
    selectedModel: 'llama3' as string | null,
    thinkingEnabled: false,
    toolsEnabled: false,
    activeModels: [{ model: 'llama3', tools: true, thinking: true }],
  },
}));

vi.mock('@ci/shadcn', () => ({ useToast: () => ({ toast: { error: h.toastError, info: h.toastInfo } }) }));
vi.mock('./useAuth', () => ({
  useAuth: () => [{ authToken: 'tok', authenticated: true, expired: false }, {}],
}));
vi.mock('./useModel', () => ({ useModel: () => [h.model, {}] }));

const STATS = {
  timeToFirstTokenMs: 300,
  totalMs: 2000,
  outputTokens: 40,
  decodeTokensPerSecond: 22.5,
  tokensEstimated: false,
};

/** Reads a frame stream to the end, returning what landed on each channel. */
async function drain(stream: ReadableStream<Uint8Array>) {
  const decoder = new FrameDecoder();
  const text = new TextDecoder();
  const out = { text: '', think: '' };
  const reader = stream.getReader();

  for (;;) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    for (const frame of decoder.push(value)) {
      if (frame.channel === Channel.TEXT) {
        out.text += text.decode(frame.payload);
      } else if (frame.channel === Channel.THINK) {
        out.think += text.decode(frame.payload);
      }
    }
  }

  return out;
}

function applianceStream(threadId = 't-1') {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('hi'));
      controller.close();
    },
  });

  return new Response(body, { status: 200, headers: { 'X-Thread-Id': threadId } });
}

beforeEach(() => {
  llm.prefs = {
    mode: 'appliance',
    modelId: 'qwen3-0.6b-int4',
    accelerator: null,
    thinking: false,
    speculativeDecoding: true,
    intentTools: true,
  };
  llm.ready = true;
  llm.ensureLoaded.mockClear();
  llm.stream.mockReset();
  llm.reset.mockClear();
  llm.stream.mockImplementation(
    async (_prompt: string, opts: { onText: (t: string) => void; onThought: (t: string) => void }) => {
      opts.onThought('hmm ');
      opts.onText('Hello ');
      opts.onText('there.');

      return { text: 'Hello there.', thought: 'hmm ', stats: STATS, cancelled: false };
    },
  );
  h.toastError.mockClear();
  h.toastInfo.mockClear();
  h.model = {
    selectedModel: 'llama3',
    thinkingEnabled: false,
    toolsEnabled: false,
    activeModels: [{ model: 'llama3', tools: true, thinking: true }],
  };
});

afterEach(() => vi.unstubAllGlobals());

describe('isApplianceUnreachable', () => {
  it('treats a dropped connection and gateway errors as unreachable', () => {
    expect(isApplianceUnreachable(new TypeError('Failed to fetch'))).toBe(true);
    expect(isApplianceUnreachable(new Response(null, { status: 502 }))).toBe(true);
    expect(isApplianceUnreachable(new Response(null, { status: 503 }))).toBe(true);
    expect(isApplianceUnreachable(new Response(null, { status: 504 }))).toBe(true);
  });

  it('treats what the native HTTP layer throws offline as unreachable — it is rarely a TypeError', () => {
    // CapacitorHttp rejects with plain objects and platform strings, not fetch's TypeError.
    expect(isApplianceUnreachable(new Error('Unable to resolve host "memory.example.com"'))).toBe(true);
    expect(
      isApplianceUnreachable({
        message: 'The Internet connection appears to be offline.',
        code: 'UNAVAILABLE',
      }),
    ).toBe(true);
    expect(isApplianceUnreachable('java.net.SocketTimeoutException')).toBe(true);
  });

  it('does not treat the appliance refusing us as offline — that must stay visible', () => {
    expect(isApplianceUnreachable(new ApplianceRefusedError())).toBe(false);
    expect(isApplianceUnreachable(new Response(null, { status: 401 }))).toBe(false);
    expect(isApplianceUnreachable(new Response(null, { status: 403 }))).toBe(false);
    expect(isApplianceUnreachable(new Response(null, { status: 500 }))).toBe(false);
  });

  it('never treats the user cancelling as offline', () => {
    expect(isApplianceUnreachable(new DOMException('aborted', 'AbortError'))).toBe(false);
    expect(isApplianceUnreachable(Object.assign(new Error('aborted'), { name: 'AbortError' }))).toBe(false);
  });
});

describe('useChatRequester — appliance mode (the default)', () => {
  it('never consults the on-device model', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(applianceStream()));

    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useChatRequester({ threadId: null }));

    await act(async () => {
      await result.current[1].submit({ message: 'hello', fileIds: [] });
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(llm.ensureLoaded).not.toHaveBeenCalled();
    expect(llm.stream).not.toHaveBeenCalled();
    expect(result.current[0].local).toBeNull();
  });
});

describe('useChatRequester — device mode', () => {
  beforeEach(() => {
    llm.prefs.mode = 'device';
  });

  it('answers on the phone without ever calling the appliance, framing tokens for the chat', async () => {
    const fetchMock = vi.fn();

    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useChatRequester({ threadId: null }));

    let returned: boolean | undefined;

    await act(async () => {
      returned = await result.current[1].submit({ message: 'hello', fileIds: [] });
    });

    expect(returned).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(llm.ensureLoaded).toHaveBeenCalledWith('qwen3-0.6b-int4', {
      accelerator: undefined,
      enableSpeculativeDecoding: true,
      useIntentTools: true,
    });

    await waitFor(() => expect(result.current[0].stream).not.toBeNull());

    // Draining is what lets the mocked generation resolve and publish its stats, so it runs inside act().
    let drained: { text: string; think: string } | undefined;

    await act(async () => {
      drained = await drain(result.current[0].stream as ReadableStream<Uint8Array>);
    });

    expect(drained).toEqual({ text: 'Hello there.', think: 'hmm ' });
    await waitFor(() => expect(result.current[0].local?.stats).toEqual(STATS));
    expect(result.current[0].local?.modelId).toBe('qwen3-0.6b-int4');
  });

  it('asks for reasoning only from a model that has the capability', async () => {
    llm.prefs.thinking = true;
    vi.stubGlobal('fetch', vi.fn());

    const { result } = renderHook(() => useChatRequester({ threadId: null }));

    // Qwen3 can think.
    await act(async () => {
      await result.current[1].submit({ message: 'a', fileIds: [] });
    });
    expect(llm.stream).toHaveBeenLastCalledWith('a', expect.objectContaining({ enableThinking: true }));

    // Qwen2.5 cannot — never send it a thinking request just because the toggle is on.
    llm.prefs.modelId = 'qwen2.5-1.5b-instruct';
    await act(async () => {
      await result.current[1].submit({ message: 'b', fileIds: [] });
    });
    expect(llm.stream).toHaveBeenLastCalledWith('b', expect.objectContaining({ enableThinking: false }));
  });

  it('refuses, rather than falling through to the appliance, when the model is not downloaded', async () => {
    llm.ready = false;

    const fetchMock = vi.fn();

    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useChatRequester({ threadId: null }));

    let returned: boolean | undefined;

    await act(async () => {
      returned = await result.current[1].submit({ message: 'private thing', fileIds: [] });
    });

    expect(returned).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(h.toastError).toHaveBeenCalledWith(expect.stringContaining('not downloaded'));
  });

  it('refuses attachments, which live on the appliance, instead of silently dropping them', async () => {
    vi.stubGlobal('fetch', vi.fn());

    const { result } = renderHook(() => useChatRequester({ threadId: null }));

    let returned: boolean | undefined;

    await act(async () => {
      returned = await result.current[1].submit({ message: 'read this', fileIds: ['file-1'] });
    });

    expect(returned).toBe(false);
    expect(llm.stream).not.toHaveBeenCalled();
    expect(h.toastError).toHaveBeenCalledWith(expect.stringContaining('Attachments'));
  });

  it('hands photos to a vision model, alongside the prompt', async () => {
    llm.prefs.modelId = 'gemma-4-e2b-it';
    vi.stubGlobal('fetch', vi.fn());

    const { result } = renderHook(() => useChatRequester({ threadId: null }));

    await act(async () => {
      await result.current[1].submit({ message: 'what is this?', fileIds: [], images: ['QUJD'] });
    });

    expect(llm.stream).toHaveBeenCalledWith('what is this?', expect.objectContaining({ images: ['QUJD'] }));
  });

  it('refuses photos for a model that cannot see, rather than answering as if none were sent', async () => {
    llm.prefs.modelId = 'qwen3-0.6b-int4';
    vi.stubGlobal('fetch', vi.fn());

    const { result } = renderHook(() => useChatRequester({ threadId: null }));

    let returned: boolean | undefined;

    await act(async () => {
      returned = await result.current[1].submit({ message: 'what is this?', fileIds: [], images: ['QUJD'] });
    });

    expect(returned).toBe(false);
    expect(llm.stream).not.toHaveBeenCalled();
    expect(h.toastError).toHaveBeenCalledWith(expect.stringContaining('cannot read photos'));
  });

  it('reports a load failure as the request error and starts no stream', async () => {
    llm.ensureLoaded.mockRejectedValueOnce(new Error('Not enough memory to load the model'));
    vi.stubGlobal('fetch', vi.fn());

    const { result } = renderHook(() => useChatRequester({ threadId: null }));

    let returned: boolean | undefined;

    await act(async () => {
      returned = await result.current[1].submit({ message: 'hi', fileIds: [] });
    });

    expect(returned).toBe(false);
    expect((result.current[0].error as Error).message).toMatch(/memory/);
    expect(result.current[0].stream).toBeNull();
    expect(llm.stream).not.toHaveBeenCalled();
  });

  it('does not require an appliance model to be selected — that is the whole point when offline', async () => {
    h.model = { selectedModel: null, thinkingEnabled: false, toolsEnabled: false, activeModels: [] };
    vi.stubGlobal('fetch', vi.fn());

    const { result } = renderHook(() => useChatRequester({ threadId: null }));

    let returned: boolean | undefined;

    await act(async () => {
      returned = await result.current[1].submit({ message: 'hi', fileIds: [] });
    });

    expect(returned).toBe(true);
  });

  it('says so when the device cut the reply short, instead of leaving a truncated answer looking complete', async () => {
    llm.stream.mockImplementationOnce(async (_prompt: string, opts: { onText: (t: string) => void }) => {
      opts.onText('half an ans');

      return { text: 'half an ans', thought: '', stats: undefined, cancelled: true };
    });
    vi.stubGlobal('fetch', vi.fn());

    const { result } = renderHook(() => useChatRequester({ threadId: null }));

    await act(async () => {
      await result.current[1].submit({ message: 'hi', fileIds: [] });
    });

    await waitFor(() => expect(h.toastInfo).toHaveBeenCalledWith(expect.stringContaining('stopped early')));
  });

  it('stays quiet when the user pressed Stop themselves', async () => {
    llm.stream.mockImplementationOnce(async (_prompt: string, opts: { signal: AbortSignal }) => {
      await new Promise((resolve) => opts.signal.addEventListener('abort', resolve));

      return { text: '', thought: '', stats: undefined, cancelled: true };
    });
    vi.stubGlobal('fetch', vi.fn());

    const { result } = renderHook(() => useChatRequester({ threadId: null }));

    await act(async () => {
      await result.current[1].submit({ message: 'hi', fileIds: [] });
    });
    await act(async () => {
      result.current[1].stop();
    });

    expect(h.toastInfo).not.toHaveBeenCalled();
  });

  it('starts a fresh conversation and asks again when a full context window answers with nothing', async () => {
    const empty = { text: '', thought: '', stats: { ...STATS, outputTokens: 0 }, cancelled: false };

    llm.stream.mockImplementationOnce(async () => empty);
    vi.stubGlobal('fetch', vi.fn());

    const { result } = renderHook(() => useChatRequester({ threadId: null }));

    await act(async () => {
      await result.current[1].submit({ message: 'and then?', fileIds: [] });
    });

    await waitFor(() => expect(result.current[0].stream).not.toBeNull());

    let drained: { text: string; think: string } | undefined;

    await act(async () => {
      drained = await drain(result.current[0].stream as ReadableStream<Uint8Array>);
    });

    expect(llm.reset).toHaveBeenCalledTimes(1);
    expect(llm.stream).toHaveBeenCalledTimes(2);
    expect(llm.stream.mock.calls.map(([prompt]) => prompt)).toEqual(['and then?', 'and then?']);
    expect(drained?.text).toBe('Hello there.');
    expect(h.toastInfo).toHaveBeenCalledWith(expect.stringContaining('outgrew'));
  });

  it('asks only once more — a model that answers nothing for another reason cannot loop', async () => {
    const empty = { text: '', thought: '', stats: { ...STATS, outputTokens: 0 }, cancelled: false };

    llm.stream.mockImplementation(async () => empty);
    vi.stubGlobal('fetch', vi.fn());

    const { result } = renderHook(() => useChatRequester({ threadId: null }));

    await act(async () => {
      await result.current[1].submit({ message: 'hi', fileIds: [] });
    });
    await waitFor(() => expect(result.current[0].stream).not.toBeNull());
    await act(async () => {
      await drain(result.current[0].stream as ReadableStream<Uint8Array>);
    });

    expect(llm.stream).toHaveBeenCalledTimes(2);
    expect(llm.reset).toHaveBeenCalledTimes(1);
  });

  it('does not treat a stopped or heat-cut turn as a full context (they carry no stats)', async () => {
    llm.stream.mockImplementationOnce(async () => ({
      text: '',
      thought: '',
      stats: undefined,
      cancelled: true,
    }));
    vi.stubGlobal('fetch', vi.fn());

    const { result } = renderHook(() => useChatRequester({ threadId: null }));

    await act(async () => {
      await result.current[1].submit({ message: 'hi', fileIds: [] });
    });
    await waitFor(() => expect(h.toastInfo).toHaveBeenCalled());

    expect(llm.reset).not.toHaveBeenCalled();
    expect(llm.stream).toHaveBeenCalledTimes(1);
  });

  it('surfaces a mid-turn native failure as a stream error rather than a hang', async () => {
    llm.stream.mockRejectedValueOnce(new Error('Device is thermally throttled'));
    vi.stubGlobal('fetch', vi.fn());

    const { result } = renderHook(() => useChatRequester({ threadId: null }));

    await act(async () => {
      await result.current[1].submit({ message: 'hi', fileIds: [] });
    });

    await waitFor(() => expect(result.current[0].stream).not.toBeNull());
    await act(async () => {
      await expect(drain(result.current[0].stream as ReadableStream<Uint8Array>)).rejects.toThrow(
        'thermally',
      );
    });
  });
});

describe('useChatRequester — auto mode', () => {
  beforeEach(() => {
    llm.prefs.mode = 'auto';
  });

  it('uses the appliance when it answers, leaving the phone model untouched', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(applianceStream()));

    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useChatRequester({ threadId: null }));

    await act(async () => {
      await result.current[1].submit({ message: 'hello', fileIds: [] });
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(llm.stream).not.toHaveBeenCalled();
    expect(result.current[0].local).toBeNull();
  });

  it('falls back to the phone when the appliance cannot be reached, and says so', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    );

    const { result } = renderHook(() => useChatRequester({ threadId: null }));

    let returned: boolean | undefined;

    await act(async () => {
      returned = await result.current[1].submit({ message: 'hello', fileIds: [] });
    });

    expect(returned).toBe(true);
    expect(h.toastInfo).toHaveBeenCalledWith(expect.stringContaining('unreachable'));
    expect(llm.stream).toHaveBeenCalledTimes(1);
    expect(result.current[0].error).toBeNull();
  });

  it('falls back when the native HTTP layer rejects with a plain object, as it does offline', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.reject({ message: 'Unable to resolve host "memory.example.com"', code: 'UNAVAILABLE' }),
      ),
    );

    const { result } = renderHook(() => useChatRequester({ threadId: null }));

    let returned: boolean | undefined;

    await act(async () => {
      returned = await result.current[1].submit({ message: 'hello', fileIds: [] });
    });

    expect(returned).toBe(true);
    expect(llm.stream).toHaveBeenCalledTimes(1);
  });

  it('falls back on a gateway timeout too', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('bad gateway', { status: 502 }))),
    );

    const { result } = renderHook(() => useChatRequester({ threadId: null }));

    await act(async () => {
      await result.current[1].submit({ message: 'hello', fileIds: [] });
    });

    expect(llm.stream).toHaveBeenCalledTimes(1);
  });

  it('does not answer from the text alone when the unreachable turn had attachments', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    );

    const { result } = renderHook(() => useChatRequester({ threadId: null }));

    let returned: boolean | undefined;

    await act(async () => {
      returned = await result.current[1].submit({ message: 'read this', fileIds: ['file-1'] });
    });

    expect(returned).toBe(false);
    expect(llm.stream).not.toHaveBeenCalled();
    expect(h.toastError).toHaveBeenCalledWith(expect.stringContaining('attachments'));
    expect(h.toastInfo).not.toHaveBeenCalled();
  });

  it('does not answer a photo on a model that cannot see it when the appliance is down', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    );

    const { result } = renderHook(() => useChatRequester({ threadId: null }));

    let returned: boolean | undefined;

    await act(async () => {
      returned = await result.current[1].submit({ message: 'what is this?', fileIds: [], images: ['QUJD'] });
    });

    expect(returned).toBe(false);
    expect(llm.stream).not.toHaveBeenCalled();
    expect(h.toastError).toHaveBeenCalledWith(expect.stringContaining('cannot read photos'));
  });

  it('hands the photo to a vision model when the appliance cannot be reached', async () => {
    llm.prefs.modelId = 'gemma-4-e2b-it';
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    );

    const { result } = renderHook(() => useChatRequester({ threadId: null }));

    await act(async () => {
      await result.current[1].submit({ message: 'what is this?', fileIds: [], images: ['QUJD'] });
    });

    expect(llm.stream).toHaveBeenCalledWith('what is this?', expect.objectContaining({ images: ['QUJD'] }));
  });

  it('does NOT fall back when the appliance refuses us — an auth failure must not look like an answer', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('nope', { status: 401 }))),
    );

    const { result } = renderHook(() => useChatRequester({ threadId: null }));

    let returned: boolean | undefined;

    await act(async () => {
      returned = await result.current[1].submit({ message: 'hello', fileIds: [] });
    });

    expect(returned).toBe(false);
    expect(llm.stream).not.toHaveBeenCalled();
    expect(result.current[0].error).not.toBeNull();
  });

  it('surfaces the original error when there is no ready on-device model to fall back to', async () => {
    llm.ready = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Failed to fetch'))),
    );

    const { result } = renderHook(() => useChatRequester({ threadId: null }));

    let returned: boolean | undefined;

    await act(async () => {
      returned = await result.current[1].submit({ message: 'hello', fileIds: [] });
    });

    expect(returned).toBe(false);
    expect(llm.stream).not.toHaveBeenCalled();
    expect(result.current[0].error).toBeInstanceOf(TypeError);
  });

  it('clears the on-device badge once the appliance is back and answers', async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => Promise.reject(new TypeError('Failed to fetch')))
      .mockImplementationOnce(() => Promise.resolve(applianceStream()));

    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useChatRequester({ threadId: null }));

    await act(async () => {
      await result.current[1].submit({ message: 'one', fileIds: [] });
    });
    expect(result.current[0].local).not.toBeNull();

    await act(async () => {
      await result.current[1].submit({ message: 'two', fileIds: [] });
    });
    expect(result.current[0].local).toBeNull();
  });
});
