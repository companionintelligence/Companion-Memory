/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Regression cover for a non-streaming native `/api/chat` turn that could not
 * be stopped and could not be bounded.
 *
 * Three defects compounded on this path, and only the native one — the path
 * that actually runs when `OLLAMA_HOST` and `LLM_API_BASE` share a port, which
 * is the default appliance layout:
 *
 *   1. `signal` was destructured off `PromptOptions` by `chat()` but never
 *      reached the client. `abortable()` raced the caller's promise instead,
 *      so an abort freed the CALLER while the request stayed in flight and the
 *      server generated to completion, holding its model slot. A periodic job
 *      that retries on timeout then queues behind the pile its own timeouts
 *      left, and a loaded backend gets progressively LESS able to answer.
 *   2. `maxOutputTokens` was documented as unsupported by native Ollama and
 *      dropped. `options.num_predict` is exactly that cap, so generation ran
 *      unbounded — fatal in combination with a grammar-constrained array whose
 *      schema set no `maxItems`.
 *   3. No `keep_alive`, so a job firing less often than the backend's
 *      5-minute eviction window reloaded a multi-gigabyte model on nearly
 *      every run, INSIDE the caller's timeout budget.
 *
 * Each case below drives the real `runNativeChat` against a fake client and
 * fails against the pre-fix code: (1) never called `abort()`, (2) sent no
 * `options`, (3) sent no `keep_alive`.
 */
import { ModelTierRouter } from '@ci/domains/model-routing';
import { ToolRegistry } from '@ci/domains/tools';

import { OllamaService, type ChatRequestContext } from '../OllamaService';

const MODEL = 'test-model';

const chatMock = jest.fn();
const abortMock = jest.fn();
// Retained only so the fake client shape matches the real one; the fix does not
// rely on abort(), which is a no-op for non-streaming requests.

const listMock = jest.fn();

/**
 * Every config the service handed to `new Ollama(...)`. The signal reaches the
 * socket through `config.fetch` and nowhere else, so the test has to be able to
 * reach in and exercise that wrapper — asserting on the client's `abort()`
 * instead would assert nothing, since on a non-streaming request that method
 * provably does nothing (it walks `ongoingStreamedRequests`, which only the
 * streaming branch populates).
 */
const constructedWith: any[] = [];

jest.mock('ollama', () => ({
  Ollama: jest.fn().mockImplementation((config: any) => {
    constructedWith.push(config);

    return {
      chat: (...args: any[]) => chatMock(...args),
      abort: (...args: any[]) => abortMock(...args),
      list: (...args: any[]) => listMock(...args),
    };
  }),
}));

function makeLogger() {
  return {
    setContext: jest.fn(),
    debug: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  } as any;
}

function makeService() {
  // getOpenAiDriver returning null is what selects the native path.
  const llmEndpointService = {
    getOpenAiDriver: () => null,
    getOllamaHost: () => 'http://localhost:11434',
  } as any;

  return new OllamaService(
    llmEndpointService,
    new ToolRegistry(
      makeLogger(),
      { send: jest.fn().mockResolvedValue([]) } as any,
      { evaluate: jest.fn(), propose: jest.fn() } as any,
    ),
    makeLogger(),
    { isFeatureEnabled: jest.fn(async () => false) } as any,
    new ModelTierRouter(),
  );
}

const context: ChatRequestContext = { userId: 'user-1' };
const messages = [{ role: 'user' as const, content: 'hi' }];

beforeEach(() => {
  jest.clearAllMocks();
  listMock.mockResolvedValue({ models: [{ name: MODEL }] });
  chatMock.mockResolvedValue({ model: MODEL, message: { role: 'assistant', content: '{}' } });
});

describe('native chat is cancellable', () => {
  /** The config used for the `chat` call, i.e. the last one constructed. */
  function chatClientConfig() {
    return constructedWith[constructedWith.length - 1];
  }

  it('gives the client a fetch that carries the caller signal to the socket', async () => {
    const controller = new AbortController();
    const service = makeService();

    await service.chat(context, messages, { model: MODEL, signal: controller.signal });

    // The mechanism, asserted directly: drive the injected fetch and confirm the
    // signal reaches the underlying one. Asserting `client.abort()` was called
    // would prove nothing — on a non-streaming request that method walks an
    // empty list. This is the only path by which the request can be torn down.
    const injected = chatClientConfig().fetch;

    expect(typeof injected).toBe('function');

    const seen: any[] = [];
    const realFetch = globalThis.fetch;

    globalThis.fetch = (async (input: any, init: any) => {
      seen.push({ input, init });

      return { ok: true, json: async () => ({}) };
    }) as never;

    try {
      await injected('http://example.invalid/api/chat', { method: 'POST' });
    } finally {
      globalThis.fetch = realFetch;
    }

    expect(seen).toHaveLength(1);
    expect(seen[0].init.signal).toBe(controller.signal);
    // The wrapper must forward what it was given, not replace it.
    expect(seen[0].init.method).toBe('POST');
  });

  it('leaves fetch alone when the caller passes no signal', async () => {
    const service = makeService();

    await service.chat(context, messages, { model: MODEL });

    // No signal means nothing to forward; overriding fetch anyway would be a
    // behavior change for every caller that never asked for cancellation.
    expect(chatClientConfig().fetch).toBeUndefined();
  });

  it('does not start a generation when the signal already aborted', async () => {
    const controller = new AbortController();
    const service = makeService();

    // `abortable` only races — it frees the caller without stopping `runChat`,
    // which continues through `validateModel` (its own network round trip) into
    // the chat call. So on a slow host the budget can expire before the request
    // is even issued, and issuing it then would orphan it outright: a listener
    // added to an already-aborted signal never fires, so nothing could cancel
    // it. Aborting up front reproduces that ordering deterministically.
    controller.abort();

    await service.chat(context, messages, { model: MODEL, signal: controller.signal }).catch(() => undefined);

    // Let `runChat` finish walking past validateModel to where the request
    // would be issued, so this asserts the guard rather than just the race.
    await new Promise((resolve) => setImmediate(resolve));

    expect(chatMock).not.toHaveBeenCalled();
  });
});

describe('native chat generation bounds', () => {
  it('sends maxOutputTokens as options.num_predict', async () => {
    const service = makeService();

    await service.chat(context, messages, { model: MODEL, maxOutputTokens: 1_500 });

    expect(chatMock).toHaveBeenCalledTimes(1);
    expect(chatMock.mock.calls[0]![0]).toMatchObject({ options: { num_predict: 1_500 } });
  });

  it('sends keepAlive as keep_alive so the model stays resident between runs', async () => {
    const service = makeService();

    await service.chat(context, messages, { model: MODEL, keepAlive: '1h' });

    expect(chatMock.mock.calls[0]![0]).toMatchObject({ keep_alive: '1h' });
  });

  it('omits both when the caller sets neither, leaving backend defaults alone', async () => {
    const service = makeService();

    await service.chat(context, messages, { model: MODEL });

    const request = chatMock.mock.calls[0]![0];

    expect(request).not.toHaveProperty('options');
    expect(request).not.toHaveProperty('keep_alive');
  });

  it('omits num_predict for a non-positive cap rather than sending a nonsense one', async () => {
    const service = makeService();

    await service.chat(context, messages, { model: MODEL, maxOutputTokens: 0 });

    expect(chatMock.mock.calls[0]![0]).not.toHaveProperty('options');
  });
});
