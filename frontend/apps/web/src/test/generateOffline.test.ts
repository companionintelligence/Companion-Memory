import { setApiKey } from '@ci/common/src/utils/apiAuth';
import { setApiBaseUrl } from '@ci/common/src/utils/apiBase';
import { generateOffline } from '@ci/common/src/utils/nativeBridge';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { Channel, FrameEncoder } from '@/components/Chat/utils';

type GlobalWithWindow = { window?: unknown };

function setWindow(value: unknown): void {
  (globalThis as GlobalWithWindow).window = value;
}

/** Builds a frame-encoded response body, exactly like `/api/llm/generate` streams it. */
function frameStream(chunks: Array<[Channel, string]>): ReadableStream<Uint8Array> {
  const encoder = new FrameEncoder();

  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const [channel, text] of chunks) {
        controller.enqueue(encoder.encodeFrame(channel, text));
      }

      controller.close();
    },
  });
}

function stubFetchWithFrames(chunks: Array<[Channel, string]>) {
  const fetchMock = vi.fn(
    async (): Promise<Response> =>
      ({
        ok: true,
        status: 200,
        body: frameStream(chunks),
      }) as unknown as Response,
  );

  vi.stubGlobal('fetch', fetchMock);

  return fetchMock;
}

// The mock's recorded args are untyped; read (input, init) via a cast (mirrors fetchJson.test.ts).
function callArgs(
  mock: ReturnType<typeof stubFetchWithFrames>,
  index = 0,
): [RequestInfo, RequestInit | undefined] {
  return mock.mock.calls[index] as unknown as [RequestInfo, RequestInit | undefined];
}

afterEach(() => {
  delete (globalThis as GlobalWithWindow).window;
  vi.unstubAllGlobals();
  setApiBaseUrl('');
  setApiKey(null);
});

describe('generateOffline — web (no Capacitor) falls back to /api/llm/generate', () => {
  it('POSTs the same request shape as useChatRequester and decodes the TEXT-channel stream', async () => {
    setWindow({});
    const fetchMock = stubFetchWithFrames([
      [Channel.TEXT, 'Hello, '],
      [Channel.THINK, 'ignored reasoning'],
      [Channel.TEXT, 'world!'],
    ]);

    const result = await generateOffline('hi there', {
      model: 'llama3',
      threadId: 'thread-1',
      enableTools: true,
      enableThinking: false,
    });

    expect(result).toEqual({ text: 'Hello, world!', source: 'remote' });

    const [url, init] = callArgs(fetchMock);

    expect(url).toBe('/api/llm/generate');
    expect(init?.method).toBe('POST');
    expect(JSON.parse(init?.body as string)).toEqual({
      prompt: 'hi there',
      model: 'llama3',
      threadId: 'thread-1',
      enableTools: true,
      enableThinking: false,
    });
  });

  it('forwards each TEXT-channel chunk to onToken as it decodes, skipping other channels', async () => {
    setWindow({});
    stubFetchWithFrames([
      [Channel.TEXT, 'foo'],
      [Channel.THINK, 'reasoning...'],
      [Channel.TEXT, 'bar'],
    ]);

    const seen: string[] = [];
    const result = await generateOffline('prompt', { onToken: (token) => seen.push(token) });

    expect(seen).toEqual(['foo', 'bar']);
    expect(result).toEqual({ text: 'foobar', source: 'remote' });
  });

  it('adds an Authorization header only when authToken is passed', async () => {
    setWindow({});
    const fetchMock = stubFetchWithFrames([[Channel.TEXT, 'ok']]);

    await generateOffline('prompt', { authToken: 'jwt-abc' });

    expect(callArgs(fetchMock)[1]?.headers).toMatchObject({ Authorization: 'Bearer jwt-abc' });
  });

  it('adds x-api-key (native auth) when an API key is set, via apiKeyHeaders()', async () => {
    setApiKey('key-123');
    setWindow({});
    const fetchMock = stubFetchWithFrames([[Channel.TEXT, 'ok']]);

    await generateOffline('prompt');

    expect(callArgs(fetchMock)[1]?.headers).toMatchObject({ 'x-api-key': 'key-123' });
  });

  it('throws when the response is not ok', async () => {
    setWindow({});
    vi.stubGlobal(
      'fetch',
      vi.fn(async (): Promise<Response> => ({ ok: false, status: 500, body: null }) as unknown as Response),
    );

    await expect(generateOffline('prompt')).rejects.toThrow();
  });
});

describe('generateOffline — native, on-device model available', () => {
  function fakeNativeWindow(pluginOverrides: Record<string, unknown> = {}) {
    const plugin = {
      isAvailable: vi.fn(async () => ({ available: true })),
      generate: vi.fn(async ({ prompt }: { prompt: string }) => ({ text: `local:${prompt}` })),
      generateStream: vi.fn(async () => {}),
      addListener: vi.fn(async () => ({ remove: vi.fn() })),
      ...pluginOverrides,
    };

    const win = {
      Capacitor: {
        isNativePlatform: () => true,
        Plugins: { LocalLLM: plugin },
      },
    };

    return { win, plugin };
  }

  it('answers from the local model without calling fetch', async () => {
    const { win, plugin } = fakeNativeWindow();
    setWindow(win);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await generateOffline('hi');

    expect(result).toEqual({ text: 'local:hi', source: 'local' });
    expect(plugin.generate).toHaveBeenCalledWith({ prompt: 'hi' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('streams via generateStream + the llmToken event when onToken is passed', async () => {
    let tokenHandler: ((event: { partial: string; done: boolean }) => void) | undefined;
    const remove = vi.fn();

    const { win } = fakeNativeWindow({
      addListener: vi.fn(async (_eventName: string, listener: typeof tokenHandler) => {
        tokenHandler = listener;

        return { remove };
      }),
      generateStream: vi.fn(async () => {
        tokenHandler?.({ partial: 'foo', done: false });
        tokenHandler?.({ partial: 'bar', done: false });
        tokenHandler?.({ partial: '', done: true });
      }),
    });
    setWindow(win);

    const seen: string[] = [];
    const result = await generateOffline('hi', { onToken: (token) => seen.push(token) });

    expect(result).toEqual({ text: 'foobar', source: 'local' });
    expect(seen).toEqual(['foo', 'bar']);
    expect(remove).toHaveBeenCalledTimes(1);
  });
});

describe('generateOffline — falls through to remote when the plugin is unavailable', () => {
  it('falls back when isAvailable() reports false', async () => {
    const generate = vi.fn();
    setWindow({
      Capacitor: {
        isNativePlatform: () => true,
        Plugins: {
          LocalLLM: {
            isAvailable: vi.fn(async () => ({ available: false, reason: 'insufficient RAM' })),
            generate,
          },
        },
      },
    });
    stubFetchWithFrames([[Channel.TEXT, 'remote answer']]);

    const result = await generateOffline('hi');

    expect(result).toEqual({ text: 'remote answer', source: 'remote' });
    expect(generate).not.toHaveBeenCalled();
  });

  it('falls back when the local call throws', async () => {
    setWindow({
      Capacitor: {
        isNativePlatform: () => true,
        Plugins: {
          LocalLLM: {
            isAvailable: vi.fn(async () => ({ available: true })),
            generate: vi.fn(async () => {
              throw new Error('model crashed');
            }),
          },
        },
      },
    });
    stubFetchWithFrames([[Channel.TEXT, 'remote answer']]);

    const result = await generateOffline('hi');

    expect(result).toEqual({ text: 'remote answer', source: 'remote' });
  });

  it('falls back when running on native but the plugin is absent (not yet installed/synced)', async () => {
    setWindow({ Capacitor: { isNativePlatform: () => true, Plugins: {} } });
    stubFetchWithFrames([[Channel.TEXT, 'remote answer']]);

    const result = await generateOffline('hi');

    expect(result).toEqual({ text: 'remote answer', source: 'remote' });
  });

  it('is inert on web: never touches window.Capacitor, goes straight to remote', async () => {
    setWindow({});
    stubFetchWithFrames([[Channel.TEXT, 'remote answer']]);

    const result = await generateOffline('hi');

    expect(result).toEqual({ text: 'remote answer', source: 'remote' });
  });
});
