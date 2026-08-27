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
const listMock = jest.fn();

jest.mock('ollama', () => ({
  Ollama: jest.fn().mockImplementation(() => ({
    chat: (...args: any[]) => chatMock(...args),
    abort: (...args: any[]) => abortMock(...args),
    list: (...args: any[]) => listMock(...args),
  })),
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
  it('tears down the in-flight request when the signal aborts', async () => {
    const controller = new AbortController();

    // A generation that never settles on its own — the only way it can end is
    // if something actually cancels it, which is the whole point.
    chatMock.mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          abortMock.mockImplementation(() => reject(new Error('aborted by client')));
        }),
    );

    const service = makeService();
    const promise = service.chat(context, messages, { model: MODEL, signal: controller.signal });

    // Let validateModel's round trip settle so the chat call is genuinely in flight.
    await Promise.resolve();
    await Promise.resolve();

    controller.abort();

    await expect(promise).rejects.toThrow();

    // The assertion that matters: the pre-fix code freed the caller via the
    // abortable() race and left the server generating, so abort() was never
    // reached.
    expect(abortMock).toHaveBeenCalledTimes(1);
  });

  it('does not abort a call that completes normally', async () => {
    const controller = new AbortController();
    const service = makeService();

    await service.chat(context, messages, { model: MODEL, signal: controller.signal });

    expect(abortMock).not.toHaveBeenCalled();
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
