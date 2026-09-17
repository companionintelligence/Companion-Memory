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

import { toolResultByteBudget } from '../../toolResultBudget';
import { OllamaService, UTILITY_MODEL, type ChatRequestContext } from '../OllamaService';

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
    // The socket's signal is the deadline wrapper's own (firstResponseDeadline.ts),
    // and the caller's abort is forwarded to it — that forwarding is the
    // mechanism, so it is what gets driven.
    expect(seen[0].init.signal.aborted).toBe(false);
    controller.abort();
    expect(seen[0].init.signal.aborted).toBe(true);
    // The wrapper must forward what it was given, not replace it.
    expect(seen[0].init.method).toBe('POST');
  });

  it('still injects a fetch when the caller passes no signal — the first-response deadline needs it', async () => {
    const service = makeService();

    await service.chat(context, messages, { model: MODEL });

    // Every generation is bounded now, signal or not: the wait for a backend
    // that never answers used to end only at undici's five-minute headers
    // timeout, as a bare `fetch failed`.
    expect(typeof chatClientConfig().fetch).toBe('function');
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

  // The non-streaming path never sent `num_ctx` — only chatStream did — so
  // every background call ran at Ollama's VRAM-based default (32768 on a
  // 24 GiB card), the window that made a second model's load an eviction.
  it('sends numCtx as options.num_ctx alongside num_predict', async () => {
    const service = makeService();

    await service.chat(context, messages, { model: MODEL, numCtx: 8_192, maxOutputTokens: 400 });

    expect(chatMock.mock.calls[0]![0]).toMatchObject({ options: { num_ctx: 8_192, num_predict: 400 } });
  });

  it('sends num_ctx on the follow-up turn after tool calls too', async () => {
    const service = makeService();

    chatMock
      .mockResolvedValueOnce({
        model: MODEL,
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{ function: { name: 'nope', arguments: {} } }],
        },
      })
      .mockResolvedValueOnce({ model: MODEL, message: { role: 'assistant', content: 'done' } });

    await service.chat(context, messages, { model: MODEL, numCtx: 4_096, enableTools: true });

    expect(chatMock).toHaveBeenCalledTimes(2);
    expect(chatMock.mock.calls[1]![0]).toMatchObject({ options: { num_ctx: 4_096 } });
  });
});

/**
 * `tier: 'utility'` is resolved per call by the residency planner into a model
 * AND a window. Without a planner (this direct construction) it must fall back
 * to the configured utility model, unplanned — the pre-planner behaviour every
 * `new OllamaService(...)` test in this directory already assumes.
 */
describe('utility tier resolution', () => {
  function makeServiceWithPlanner(choice: {
    model: string;
    numCtx?: number;
    kind?: 'resident' | 'load' | 'routed';
  }) {
    const llmEndpointService = {
      getOpenAiDriver: () => null,
      getOllamaHost: () => 'http://localhost:11434',
    } as any;
    const planner = { resolveUtilityModel: jest.fn(async () => choice), noteUtilityOutcome: jest.fn() };
    const service = new OllamaService(
      llmEndpointService,
      new ToolRegistry(
        makeLogger(),
        { send: jest.fn().mockResolvedValue([]) } as any,
        { evaluate: jest.fn(), propose: jest.fn() } as any,
      ),
      makeLogger(),
      { isFeatureEnabled: jest.fn(async () => false) } as any,
      new ModelTierRouter(),
      undefined,
      planner as any,
    );

    return { service, planner };
  }

  it('runs on the model and window the planner chose', async () => {
    const { service, planner } = makeServiceWithPlanner({ model: 'routed-chat-model', numCtx: 32_768 });

    listMock.mockResolvedValue({ models: [{ name: 'routed-chat-model' }] });

    await service.chat(context, messages, { tier: 'utility', maxOutputTokens: 100 });

    expect(planner.resolveUtilityModel).toHaveBeenCalledTimes(1);
    expect(chatMock.mock.calls[0]![0]).toMatchObject({
      model: 'routed-chat-model',
      options: { num_ctx: 32_768, num_predict: 100 },
    });
  });

  it('tells the planner how the load-carrying call went, so its watchdog can act', async () => {
    const { service, planner } = makeServiceWithPlanner({ model: MODEL, numCtx: 8_192, kind: 'load' });
    const noteUtilityOutcome = jest.fn();

    (planner as any).noteUtilityOutcome = noteUtilityOutcome;

    await service.chat(context, messages, { tier: 'utility' });

    expect(noteUtilityOutcome).toHaveBeenCalledWith(
      { model: MODEL, numCtx: 8_192, kind: 'load' },
      { ok: true },
    );

    const failure = new Error('boom');

    chatMock.mockRejectedValueOnce(failure);
    await expect(service.chat(context, messages, { tier: 'utility' })).rejects.toBe(failure);
    expect(noteUtilityOutcome).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'load' }), {
      ok: false,
      error: failure,
    });
  });

  it("lets a caller's explicit numCtx win over the planner's", async () => {
    const { service } = makeServiceWithPlanner({ model: MODEL, numCtx: 32_768 });

    await service.chat(context, messages, { tier: 'utility', numCtx: 2_048 });

    expect(chatMock.mock.calls[0]![0]).toMatchObject({ model: MODEL, options: { num_ctx: 2_048 } });
  });

  it('falls back to the configured utility model, with no window, when there is no planner', async () => {
    const service = makeService();

    listMock.mockResolvedValue({ models: [{ name: UTILITY_MODEL }] });

    await service.chat(context, messages, { tier: 'utility' });

    const request = chatMock.mock.calls[0]![0];

    expect(request.model).toBe(UTILITY_MODEL);
    expect(request).not.toHaveProperty('options');
  });

  // `think` is never left to the server. Ollama's default for a
  // thinking-capable model is ON, so an omitted flag silently bought every
  // background job a chain of thought nobody read — most of a 7s image
  // description on Gemma was the model thinking about the squirrel.
  it('sends think:false explicitly when the caller did not enable thinking', async () => {
    const service = makeService();

    await service.chat(context, messages, { model: MODEL });

    expect(chatMock.mock.calls[0]![0]).toMatchObject({ think: false });
  });

  it('sends think:true when the caller enabled thinking', async () => {
    const service = makeService();

    await service.chat(context, messages, { model: MODEL, enableThinking: true });

    expect(chatMock.mock.calls[0]![0]).toMatchObject({ think: true });
  });
});

/**
 * Same bounds, on the OpenAI-compat transport. This path used to drop
 * `signal`/`maxOutputTokens`/`keepAlive` entirely: `openAiDriver.chat(...)`
 * was called with only `model`/`messages`/`tools`/`format`/`enableThinking`,
 * so every appliance whose LLM endpoint is `openai_compatible` got none of
 * the cancellation or output-cap work above — only the native driver did.
 */
describe('openai-compat chat generation bounds', () => {
  function makeOpenAiService(openAiChat: jest.Mock) {
    // getOpenAiDriver returning a driver is what selects the OpenAI-compat path.
    const llmEndpointService = {
      getOpenAiDriver: () => ({
        chat: openAiChat,
        listModels: jest.fn().mockResolvedValue([MODEL]),
      }),
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

  it('threads signal and maxOutputTokens through to the OpenAI-compat driver', async () => {
    const controller = new AbortController();
    const openAiChat = jest
      .fn()
      .mockResolvedValue({ model: MODEL, message: { role: 'assistant', content: '{}' } });
    const service = makeOpenAiService(openAiChat);

    await service.chat(context, messages, {
      model: MODEL,
      signal: controller.signal,
      maxOutputTokens: 800,
      keepAlive: '1h',
    });

    expect(openAiChat).toHaveBeenCalledTimes(1);
    expect(openAiChat.mock.calls[0]![0]).toMatchObject({ signal: controller.signal, maxTokens: 800 });
  });

  it('threads signal and maxOutputTokens through the tool-call follow-up turn too', async () => {
    const controller = new AbortController();
    const openAiChat = jest
      .fn()
      .mockResolvedValueOnce({
        model: MODEL,
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{ function: { name: 'knowledge_search', arguments: {} } }],
        },
      })
      .mockResolvedValueOnce({ model: MODEL, message: { role: 'assistant', content: 'done' } });
    const service = makeOpenAiService(openAiChat);

    await service.chat(context, messages, {
      model: MODEL,
      enableTools: true,
      signal: controller.signal,
      maxOutputTokens: 800,
    });

    expect(openAiChat).toHaveBeenCalledTimes(2);
    expect(openAiChat.mock.calls[1]![0]).toMatchObject({ signal: controller.signal, maxTokens: 800 });
  });
});

/**
 * `toolResultByteBudget(numCtx)` is documented as one ROUND's share of the
 * context window, computed once per round. `handleToolCalls` used to apply
 * that same number independently to each tool result in the round instead of
 * splitting it across them, so a round with N tool calls spent N times the
 * intended budget — 5 tool calls could put ~5x the window's tool-result share
 * into the follow-up prompt.
 */
describe('multi-tool-call round budget', () => {
  const READ = { access: 'read', sensitivity: 'personal', destructive: false, external: false };
  const TOOL_COUNT = 5;

  function fakeTool(name: string, data: unknown) {
    return {
      schema: {
        name,
        domain: 'knowledge',
        title: name,
        description: name,
        parameters: { type: 'object' },
        privacy: READ,
        localCapable: false,
      },
      execute: jest.fn(async () => ({ success: true, data, executionTimeMs: 1 })),
    } as any;
  }

  function fakeProvider(tools: any[]) {
    const map = new Map(tools.map((tool) => [tool.schema.name, tool]));

    return {
      name: 'fake',
      initialize: jest.fn(async () => {}),
      shutdown: jest.fn(async () => {}),
      getAvailableTools: jest.fn(async () => [...map.values()].map((t) => t.schema)),
      getTool: (n: string) => map.get(n),
      canHandle: (n: string) => map.has(n),
      getHealthStatus: jest.fn(async () => ({
        name: 'fake',
        status: 'healthy',
        toolCount: map.size,
        lastCheck: new Date(),
      })),
    } as any;
  }

  it("splits the round's tool-result byte budget across all of that round's tool calls", async () => {
    // Each tool returns a result well over the FULL per-round budget on its
    // own, so the old per-call application would let every one of the 5 keep
    // (roughly) the whole 2048-byte budget for itself.
    const bigArray = Array.from({ length: 50 }, (_, i) => ({ id: `${i}`, text: 'y'.repeat(200) }));
    const tools = Array.from({ length: TOOL_COUNT }, (_, i) => fakeTool(`tool_${i}`, bigArray));
    const registry = new ToolRegistry(
      makeLogger(),
      { send: jest.fn().mockResolvedValue([]) } as any,
      {
        evaluate: jest
          .fn()
          .mockResolvedValue({ decision: 'execute', reason: 'allowed', explanation: 'open' }),
        propose: jest.fn(),
      } as any,
    );
    await registry.registerProvider(fakeProvider(tools));

    const toolCalls = tools.map((tool) => ({ function: { name: tool.schema.name, arguments: {} } }));
    let round = 0;
    const chatStream = jest.fn(() => {
      round += 1;

      const chunk =
        round === 1
          ? { model: MODEL, message: { role: 'assistant', content: '', tool_calls: toolCalls } }
          : { model: MODEL, message: { role: 'assistant', content: 'done' } };

      return (async function* () {
        yield chunk;
      })();
    });

    const llmEndpointService = {
      getOpenAiDriver: () => ({ chatStream, listModels: jest.fn(async () => [MODEL]) }),
    } as any;
    const service = new OllamaService(
      llmEndpointService,
      registry,
      makeLogger(),
      { isFeatureEnabled: jest.fn(async () => false) } as any,
      new ModelTierRouter(),
    );

    const stream = await service.chatStream(context, messages, { model: MODEL, enableTools: true });

    let iteration = await stream.next();

    while (!iteration.done) {
      iteration = await stream.next();
    }

    const toolMessages = stream.messages.filter((m) => m.role === 'tool');

    expect(toolMessages).toHaveLength(TOOL_COUNT);

    const totalBytes = toolMessages.reduce((sum, m) => sum + Buffer.byteLength(m.content ?? '', 'utf8'), 0);

    // The bug this guards: with the budget applied per call instead of per
    // round, this would be roughly TOOL_COUNT times the round budget.
    expect(totalBytes).toBeLessThanOrEqual(toolResultByteBudget(undefined));
  });
});
