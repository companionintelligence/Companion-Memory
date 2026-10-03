/* eslint-disable @typescript-eslint/no-explicit-any */
import { isUnreachable } from '@ci/domains/pipeline/stages/index/embedVersion';

import {
  EMBED_TIMEOUT_MESSAGE,
  EMBED_TIMEOUT_MS,
  EmbeddingGenerationService,
} from '../services/EmbeddingGenerationService';

// Capture the embed mock so each test can assert how many HTTP calls were made
// and with what batched `input`.
const embedMock = jest.fn();

// Every `Ollama` config the service constructs, in order. The service builds a
// client PER CALL so it can inject an abort signal through `Config.fetch` (the
// pinned client exposes no other seam — `EmbedRequest` has no `signal` and the
// client's own `abort()` only walks streamed requests), so these are what the
// cancellation tests inspect.
const ollamaConfigs: Array<{ host?: string; fetch?: typeof fetch }> = [];

jest.mock('ollama', () => ({
  Ollama: jest.fn().mockImplementation((cfg: { host?: string; fetch?: typeof fetch }) => {
    ollamaConfigs.push(cfg ?? {});

    return { embed: embedMock };
  }),
}));

/**
 * Default embed implementation: returns one deterministic 2-d vector per input,
 * mirroring Ollama's array-input `/api/embed` contract (embeddings: number[][]).
 */
function defaultEmbedImpl({ input }: { input: string | string[] }) {
  const inputs = Array.isArray(input) ? input : [input];

  return Promise.resolve({
    model: 'nomic-embed-text',
    embeddings: inputs.map((text: string) => [text.length, 1]),
    total_duration: 0,
    load_duration: 0,
    prompt_eval_count: inputs.length,
  });
}

/**
 * A stand-in for `LlmEndpointService`: chat on Ollama by default, or on an
 * OpenAI-compatible backend that lists `served` (or throws, when `served` is an
 * Error) when a driver is given.
 */
function makeEndpoint(
  options: {
    ollamaHost?: string;
    driver?: { baseUrl: string; apiKey?: string; served: string[] | Error };
  } = {},
) {
  const listModels = jest.fn(async () => {
    if (options.driver?.served instanceof Error) {
      throw options.driver.served;
    }

    return options.driver?.served ?? [];
  });

  return {
    getOllamaHost: () => options.ollamaHost ?? 'http://ollama.test:11434',
    getOpenAiDriver: () =>
      options.driver
        ? { baseUrl: options.driver.baseUrl, apiKey: options.driver.apiKey ?? 'k', listModels }
        : null,
    listModels,
  };
}

function makeService(endpoint: ReturnType<typeof makeEndpoint> = makeEndpoint()): EmbeddingGenerationService {
  const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() } as any;

  return new EmbeddingGenerationService(logger, endpoint as any);
}

/** Stub the global `fetch` for the OpenAI-dialect path and return the recorded calls. */
function stubFetch(
  respond: (url: string, init: RequestInit) => { status: number; body: unknown } = () => ({
    status: 200,
    body: {},
  }),
) {
  const calls: Array<{ url: string; body: any; headers: Record<string, string> }> = [];

  globalThis.fetch = (async (input: unknown, init: RequestInit | undefined) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;

    calls.push({ url, body, headers: (init?.headers ?? {}) as Record<string, string> });

    const { status, body: payload } = respond(url, init ?? {});

    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => payload,
      text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)),
    } as unknown as Response;
  }) as unknown as typeof fetch;

  return calls;
}

describe('EmbeddingGenerationService', () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    embedMock.mockReset();
    embedMock.mockImplementation(defaultEmbedImpl);
    ollamaConfigs.length = 0;
  });

  // Belt and braces: a fake-timer test that times out never reaches its own
  // cleanup, and leaked fake timers make every later test hang on a real one.
  afterEach(() => {
    jest.useRealTimers();
    globalThis.fetch = realFetch;
  });

  describe('resolveTarget (where a batch goes)', () => {
    it('embeds on the Ollama host, natively, when chat runs on Ollama', async () => {
      const service = makeService(makeEndpoint({ ollamaHost: 'http://gpu-box:11434' }));

      await expect(service.resolveTarget()).resolves.toEqual({
        dialect: 'ollama',
        host: 'http://gpu-box:11434',
        model: 'nomic-embed-text',
      });

      await service.generateEmbeddings(['x']);

      expect(ollamaConfigs[0]?.host).toBe('http://gpu-box:11434');
      expect(embedMock).toHaveBeenCalledWith(expect.objectContaining({ model: 'nomic-embed-text' }));
    });

    it('embeds on the chat backend, in the OpenAI dialect and under the spelling it lists, when it serves the same weights', async () => {
      // Lemonade lists Ollama's `nomic-embed-text` (nomic v1.5) as `user.nomic-embed-text-v1.5-GGUF`.
      const endpoint = makeEndpoint({
        driver: {
          baseUrl: 'http://lemonade.test:13305/api/v1',
          apiKey: 'lemon',
          served: ['Qwen3.8-27B-GGUF', 'user.nomic-embed-text-v1.5-GGUF'],
        },
      });
      const service = makeService(endpoint);
      const calls = stubFetch(() => ({
        status: 200,
        // Out of request order on purpose: vectors are placed by `index`.
        body: {
          data: [
            { index: 1, embedding: [2, 2] },
            { index: 0, embedding: [1, 1] },
          ],
        },
      }));

      await expect(service.resolveTarget()).resolves.toEqual({
        dialect: 'openai',
        baseUrl: 'http://lemonade.test:13305/api/v1',
        apiKey: 'lemon',
        model: 'user.nomic-embed-text-v1.5-GGUF',
      });

      const vectors = await service.generateEmbeddings(['a', 'b']);

      expect(vectors).toEqual([
        [1, 1],
        [2, 2],
      ]);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.url).toBe('http://lemonade.test:13305/api/v1/embeddings');
      expect(calls[0]?.body).toEqual({ model: 'user.nomic-embed-text-v1.5-GGUF', input: ['a', 'b'] });
      expect(calls[0]?.headers.Authorization).toBe('Bearer lemon');
      expect(embedMock).not.toHaveBeenCalled();
      // Memoised: one listing serves every batch on this endpoint.
      expect(endpoint.listModels).toHaveBeenCalledTimes(1);
    });

    it('falls back to the Ollama host when the chat backend serves no embedder (vLLM)', async () => {
      const service = makeService(
        makeEndpoint({
          ollamaHost: 'http://ollama.test:11434',
          driver: { baseUrl: 'http://vllm.test:8000/v1', served: ['Qwen/Qwen3-8B'] },
        }),
      );

      await expect(service.resolveTarget()).resolves.toEqual({
        dialect: 'ollama',
        host: 'http://ollama.test:11434',
        model: 'nomic-embed-text',
      });
    });

    it('does not memoise a failed listing: a backend that was slow to start is asked again on the next batch', async () => {
      const endpoint = makeEndpoint({
        driver: { baseUrl: 'http://vllm.test:8000/v1', served: new Error('fetch failed') },
      });
      const service = makeService(endpoint);

      await expect(service.resolveTarget()).resolves.toMatchObject({ dialect: 'ollama' });
      await expect(service.resolveTarget()).resolves.toMatchObject({ dialect: 'ollama' });

      expect(endpoint.listModels).toHaveBeenCalledTimes(2);
    });

    it('re-resolves when the chat endpoint changes', async () => {
      const endpoint = makeEndpoint({
        driver: { baseUrl: 'http://lemonade.test:13305/api/v1', served: ['nomic-embed-text-v1.5-GGUF'] },
      });
      const service = makeService(endpoint);

      await expect(service.resolveTarget()).resolves.toMatchObject({
        dialect: 'openai',
        model: 'nomic-embed-text-v1.5-GGUF',
      });

      endpoint.getOpenAiDriver = () => null;

      await expect(service.resolveTarget()).resolves.toMatchObject({ dialect: 'ollama' });
    });

    it('surfaces a non-2xx answer from the OpenAI-dialect engine with its status and body', async () => {
      const service = makeService(
        makeEndpoint({ driver: { baseUrl: 'http://vllm.test:8000/v1', served: ['nomic-embed-text'] } }),
      );
      stubFetch(() => ({ status: 400, body: { error: { message: 'input too long' } } }));

      await expect(service.generateEmbeddings(['x'])).rejects.toThrow(/answered 400: .*input too long/);
    });
  });

  describe('resolveTarget with LLM_EMBEDDING_API_BASE pinned', () => {
    /**
     * `EMBED_HOST_EXPLICITLY_CONFIGURED` is decided when `configuration.ts`
     * loads, so the service is loaded fresh with the variable set. The `ollama`
     * mock above applies inside the isolated registry too.
     */
    function loadPinned(
      host: string,
      variable = 'LLM_EMBEDDING_API_BASE',
    ): typeof EmbeddingGenerationService {
      const saved = {
        LLM_EMBEDDING_API_BASE: process.env.LLM_EMBEDDING_API_BASE,
        OLLAMA_EMBED_HOST: process.env.OLLAMA_EMBED_HOST,
      };
      delete process.env.LLM_EMBEDDING_API_BASE;
      delete process.env.OLLAMA_EMBED_HOST;
      process.env[variable] = host;

      try {
        let loaded: typeof EmbeddingGenerationService | undefined;
        jest.isolateModules(() => {
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          loaded = require('../services/EmbeddingGenerationService').EmbeddingGenerationService;
        });

        return loaded as typeof EmbeddingGenerationService;
      } finally {
        for (const [key, value] of Object.entries(saved)) {
          if (value === undefined) {
            delete process.env[key];
          } else {
            process.env[key] = value;
          }
        }
      }
    }

    function pinnedService(Service: typeof EmbeddingGenerationService, endpoint = makeEndpoint()) {
      const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() } as any;

      return new Service(logger, endpoint as any);
    }

    it('takes an OpenAI-style base and pins its root: /v1 is dropped, the native route is tried there first', async () => {
      const Service = loadPinned('http://lemonade.test:13305/api/v1');
      const service = pinnedService(Service);

      await expect(service.resolveTarget()).resolves.toEqual({
        dialect: 'ollama',
        host: 'http://lemonade.test:13305/api',
        model: 'nomic-embed-text',
      });
    });

    it('still honours OLLAMA_EMBED_HOST, the deprecated name, with a warning', async () => {
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

      try {
        const Service = loadPinned('http://ollama.test:11434', 'OLLAMA_EMBED_HOST');
        const service = pinnedService(Service);

        await expect(service.resolveTarget()).resolves.toEqual({
          dialect: 'ollama',
          host: 'http://ollama.test:11434',
          model: 'nomic-embed-text',
        });
        expect(warn.mock.calls.map((call) => call.join(' ')).join('\n')).toMatch(
          /OLLAMA_EMBED_HOST is deprecated; set LLM_EMBEDDING_API_BASE/,
        );
      } finally {
        warn.mockRestore();
      }
    });

    it('embeds on the pinned host, natively, even when the chat backend serves the embedder', async () => {
      const Service = loadPinned('http://pool.test:5002/api/inference/pool');
      const service = pinnedService(
        Service,
        makeEndpoint({
          driver: { baseUrl: 'http://lemonade.test:13305/api/v1', served: ['nomic-embed-text-v1.5-GGUF'] },
        }),
      );

      await expect(service.resolveTarget()).resolves.toEqual({
        dialect: 'ollama',
        host: 'http://pool.test:5002/api/inference/pool',
        model: 'nomic-embed-text',
      });
    });

    it('switches to /v1/embeddings on the pinned host once /api/embed has answered 404 there', async () => {
      const Service = loadPinned('http://vllm.test:8000');
      const service = pinnedService(Service);
      embedMock.mockRejectedValueOnce(Object.assign(new Error('Not Found'), { status_code: 404 }));

      await expect(service.generateEmbeddings(['x'])).rejects.toThrow('Not Found');

      const calls = stubFetch(() => ({ status: 200, body: { data: [{ index: 0, embedding: [1, 1] }] } }));

      await expect(service.resolveTarget()).resolves.toEqual({
        dialect: 'openai',
        baseUrl: 'http://vllm.test:8000/v1',
        apiKey: expect.any(String),
        model: 'nomic-embed-text',
      });
      await expect(service.generateEmbeddings(['x'])).resolves.toEqual([[1, 1]]);
      expect(calls[0]?.url).toBe('http://vllm.test:8000/v1/embeddings');
    });

    it('stays native on a 404 that is Ollama saying the MODEL is missing, not the route', async () => {
      const Service = loadPinned('http://ollama.test:11434');
      const service = pinnedService(Service);
      embedMock.mockRejectedValueOnce(
        Object.assign(new Error('model "nomic-embed-text" not found, try pulling it first'), {
          status_code: 404,
        }),
      );

      await expect(service.generateEmbeddings(['x'])).rejects.toThrow(/not found/);
      await expect(service.resolveTarget()).resolves.toMatchObject({
        dialect: 'ollama',
        host: 'http://ollama.test:11434',
      });
    });
  });

  describe('inputs the engine refuses as too long', () => {
    const lemonadeRefusal = {
      status: 500,
      body: {
        error: {
          message:
            'input (4021 tokens) is too large to process. increase the physical batch size (current batch size: 512)',
        },
      },
    };

    it('cuts every input to the configured maximum before sending', async () => {
      const service = makeService(
        makeEndpoint({
          driver: { baseUrl: 'http://lemonade.test:13305/api/v1', served: ['nomic-embed-text-v1.5-GGUF'] },
        }),
      );
      const calls = stubFetch(() => ({ status: 200, body: { data: [{ index: 0, embedding: [1] }] } }));

      await service.generateEmbeddings(['x'.repeat(20_000)]);

      expect(calls[0]?.body.input[0]).toHaveLength(8000);
    });

    it('halves the inputs and retries when llama-server says the batch is too large, then succeeds', async () => {
      const service = makeService(
        makeEndpoint({
          driver: { baseUrl: 'http://lemonade.test:13305/api/v1', served: ['nomic-embed-text-v1.5-GGUF'] },
        }),
      );
      let attempts = 0;
      const calls = stubFetch(() => {
        attempts += 1;

        return attempts < 3
          ? lemonadeRefusal
          : {
              status: 200,
              body: {
                data: [
                  { index: 0, embedding: [1] },
                  { index: 1, embedding: [2] },
                ],
              },
            };
      });

      await expect(service.generateEmbeddings(['a'.repeat(8000), 'short'])).resolves.toEqual([[1], [2]]);

      expect(calls.map((call) => call.body.input[0].length)).toEqual([8000, 4000, 2000]);
      // An input already under the floor is left alone.
      expect(calls[2]?.body.input[1]).toBe('short');
    });

    it('remembers the accepted length, so later batches on the same engine are cut up front', async () => {
      const service = makeService(
        makeEndpoint({
          driver: { baseUrl: 'http://lemonade.test:13305/api/v1', served: ['nomic-embed-text-v1.5-GGUF'] },
        }),
      );
      const calls = stubFetch((_url, init) => {
        const inputs = JSON.parse(String(init.body)).input as string[];

        return inputs.some((text) => text.length > 4000)
          ? lemonadeRefusal
          : { status: 200, body: { data: inputs.map((_, index) => ({ index, embedding: [index] })) } };
      });

      await service.generateEmbeddings(['a'.repeat(8000)]);
      await service.generateEmbeddings(['b'.repeat(8000), 'c'.repeat(3000)]);

      expect(calls.map((call) => call.body.input.map((text: string) => text.length))).toEqual([
        [8000],
        [4000],
        [4000, 3000],
      ]);
    });

    it("gives up after the shrink budget, with the engine's own message", async () => {
      const service = makeService(
        makeEndpoint({
          driver: { baseUrl: 'http://lemonade.test:13305/api/v1', served: ['nomic-embed-text-v1.5-GGUF'] },
        }),
      );
      const calls = stubFetch(() => lemonadeRefusal);

      await expect(service.generateEmbeddings(['a'.repeat(8000)])).rejects.toThrow(/too large to process/);
      expect(calls).toHaveLength(4);
    });

    it('does not retry a failure that is not about length', async () => {
      const service = makeService(
        makeEndpoint({
          driver: { baseUrl: 'http://lemonade.test:13305/api/v1', served: ['nomic-embed-text-v1.5-GGUF'] },
        }),
      );
      const calls = stubFetch(() => ({ status: 503, body: 'loading model' }));

      await expect(service.generateEmbeddings(['a'.repeat(8000)])).rejects.toThrow(/503/);
      expect(calls).toHaveLength(1);
    });
  });

  describe('generateEmbeddings (explicit batch API)', () => {
    it('returns one vector per input, in order', async () => {
      const service = makeService();

      const vectors = await service.generateEmbeddings(['aa', 'bbbb', 'c']);

      expect(vectors).toEqual([
        [2, 1],
        [4, 1],
        [1, 1],
      ]);
    });

    it('sends a single batched call for inputs under the batch size', async () => {
      const service = makeService();

      await service.generateEmbeddings(['one', 'two', 'three']);

      expect(embedMock).toHaveBeenCalledTimes(1);
      expect(embedMock).toHaveBeenCalledWith(expect.objectContaining({ input: ['one', 'two', 'three'] }));
    });

    it('chunks inputs that exceed the batch size into multiple calls', async () => {
      const service = makeService();
      // default CI_EMBED_BATCH_SIZE is 32; 70 inputs => 3 chunks (32 + 32 + 6)
      const inputs = Array.from({ length: 70 }, (_, i) => `text-${i}`);

      const vectors = await service.generateEmbeddings(inputs);

      expect(vectors).toHaveLength(70);
      expect(embedMock).toHaveBeenCalledTimes(3);
      const batchSizes = embedMock.mock.calls.map((c) => (c[0].input as string[]).length);
      expect(batchSizes).toEqual([32, 32, 6]);
    });

    it('returns [] without calling Ollama for an empty input list', async () => {
      const service = makeService();

      const vectors = await service.generateEmbeddings([]);

      expect(vectors).toEqual([]);
      expect(embedMock).not.toHaveBeenCalled();
    });

    it('throws if Ollama returns the wrong number of vectors', async () => {
      embedMock.mockResolvedValueOnce({ embeddings: [[1, 2]] }); // 1 vec for 2 inputs
      const service = makeService();

      await expect(service.generateEmbeddings(['a', 'b'])).rejects.toThrow(/1 vectors for 2 inputs/);
    });
  });

  describe('generateEmbedding (coalesced single-text path)', () => {
    it('coalesces concurrent single-text calls into ONE batched Ollama call', async () => {
      const service = makeService();

      const [v1, v2, v3] = await Promise.all([
        service.generateEmbedding('alpha'),
        service.generateEmbedding('bravo'),
        service.generateEmbedding('charlie'),
      ]);

      // Three logical calls, but only one HTTP request thanks to coalescing.
      expect(embedMock).toHaveBeenCalledTimes(1);
      expect(embedMock.mock.calls[0][0].input).toEqual(['alpha', 'bravo', 'charlie']);
      expect(v1).toEqual([5, 1]);
      expect(v2).toEqual([5, 1]);
      expect(v3).toEqual([7, 1]);
    });

    it('rejects empty text without hitting Ollama', async () => {
      const service = makeService();

      await expect(service.generateEmbedding('   ')).rejects.toThrow(/empty/i);
      expect(embedMock).not.toHaveBeenCalled();
    });

    it('rejects the matching caller when Ollama returns an empty vector', async () => {
      embedMock.mockResolvedValueOnce({ embeddings: [[]] });
      const service = makeService();

      await expect(service.generateEmbedding('lonely')).rejects.toThrow(/empty embedding vector/i);
    });

    it('propagates Ollama errors to all coalesced callers', async () => {
      embedMock.mockRejectedValueOnce(new Error('ollama down'));
      const service = makeService();

      const results = await Promise.allSettled([
        service.generateEmbedding('a-real-text'),
        service.generateEmbedding('another-real-text'),
      ]);

      expect(results.every((r) => r.status === 'rejected')).toBe(true);
    });
  });

  describe('embed timeout', () => {
    /**
     * Pull the AbortSignal the service injected through `Config.fetch`.
     *
     * The wrapper is `(input, init) => fetch(input, { ...init, signal })`, so
     * the only way to see the signal is to call it with the global `fetch`
     * stubbed out. Nothing leaves the process — the stub records and returns a
     * promise that never settles.
     */
    function injectedSignal(index = 0): AbortSignal {
      const wrapped = ollamaConfigs[index]?.fetch;

      if (wrapped == null) {
        throw new Error(`no Ollama client was constructed at index ${index}`);
      }

      const realFetch = globalThis.fetch;
      let captured: AbortSignal | undefined;

      globalThis.fetch = ((_input: unknown, init: RequestInit | undefined) => {
        captured = init?.signal ?? undefined;

        return new Promise<Response>(() => {});
      }) as unknown as typeof fetch;

      try {
        void wrapped('http://embedding-timeout.test/api/embed', {});
      } finally {
        globalThis.fetch = realFetch;
      }

      if (captured == null) {
        throw new Error('the service did not pass a signal to fetch');
      }

      return captured;
    }

    /**
     * Stand in for the real client's behaviour on abort: `embed()` rejects
     * because the underlying fetch rejects. The mocked client has no fetch of
     * its own, so wire the rejection to the injected signal by hand.
     */
    function embedThatOnlyEndsOnAbort(): void {
      embedMock.mockImplementation(
        () =>
          new Promise((_resolve, reject) => {
            const signal = injectedSignal(ollamaConfigs.length - 1);

            signal.addEventListener('abort', () => {
              reject(new DOMException('This operation was aborted', 'AbortError'));
            });
          }),
      );
    }

    it('aborts the in-flight request and rejects with the timeout message', async () => {
      // The point of this test is the ABORT, not the rejection. A helper that
      // merely races the caller's promise against a timer would free the caller
      // while the server kept generating and holding its model slot — the
      // failure mode OllamaService.runNativeChat documents, where timed-out
      // retries pile orphaned work onto an already-loaded backend. So assert on
      // the signal the service actually handed to fetch.
      jest.useFakeTimers();

      embedThatOnlyEndsOnAbort();
      const service = makeService();

      // Attach the rejection handler up front: the throw happens while the
      // timers below are being advanced, and a late `.rejects` would surface as
      // an unhandled rejection instead of an assertion.
      const settled = service.generateEmbeddings(['needs-a-vector']).then(
        () => null,
        (err: Error) => err,
      );

      // Let p-limit admit the chunk so the client (and its timer) exist.
      await jest.advanceTimersByTimeAsync(0);

      const signal = injectedSignal();
      expect(signal.aborted).toBe(false);

      await jest.advanceTimersByTimeAsync(EMBED_TIMEOUT_MS);

      expect(signal.aborted).toBe(true);
      expect((await settled)?.message).toBe(EMBED_TIMEOUT_MESSAGE);
    });

    it('keeps the underlying AbortError as `cause`', async () => {
      jest.useFakeTimers();

      embedThatOnlyEndsOnAbort();
      const service = makeService();

      const settled = service.generateEmbeddings(['needs-a-vector']).catch((err: unknown) => err as Error);
      await jest.advanceTimersByTimeAsync(EMBED_TIMEOUT_MS);

      const err = (await settled) as Error;
      expect(err.message).toBe(EMBED_TIMEOUT_MESSAGE);
      expect((err.cause as Error).name).toBe('AbortError');
    });

    it('fails every coalesced caller of a timed-out batch', async () => {
      jest.useFakeTimers();

      embedThatOnlyEndsOnAbort();
      const service = makeService();

      const settled = Promise.allSettled([
        service.generateEmbedding('a-real-text'),
        service.generateEmbedding('another-real-text'),
        service.generateEmbedding('a-third-real-text'),
      ]);

      // Two advances, not one: the first fires the coalescing window, and only
      // THEN does embedBatch arm its own timeout — which would otherwise sit
      // past the end of a single advance.
      await jest.advanceTimersByTimeAsync(50);
      await jest.advanceTimersByTimeAsync(EMBED_TIMEOUT_MS);

      const results = await settled;
      expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected', 'rejected']);
      for (const result of results) {
        expect((result as PromiseRejectedResult).reason.message).toBe(EMBED_TIMEOUT_MESSAGE);
      }
    });

    it('does not abort or rewrite the error for a fast failure', async () => {
      // A non-timeout error must keep its ORIGINAL message: `fetch failed` and
      // `ECONNREFUSED` are what the pipeline matches on to classify a failure as
      // transient, and rewriting them would spend quarantine budget instead of
      // refunding it (see EMBED_TIMEOUT_MESSAGE's docs).
      embedMock.mockRejectedValueOnce(new Error('fetch failed'));
      const service = makeService();

      await expect(service.generateEmbeddings(['a'])).rejects.toThrow('fetch failed');
      expect(injectedSignal().aborted).toBe(false);
    });

    it('clears the timer on the happy path so the signal is never aborted', async () => {
      const service = makeService();

      await service.generateEmbeddings(['a', 'b']);

      expect(injectedSignal().aborted).toBe(false);
    });

    it('keeps the timeout message classifiable as a transient Ollama failure', () => {
      // REGRESSION GUARD, not a tautology. DenseEmbedStageBase classifies an
      // embed failure by matching its message against UNREACHABLE_PATTERNS in
      // domains/pipeline/stages/index/embedVersion.ts: a match is
      // `ollama_unreachable` (in TRANSIENT_FAILURE_REASONS — the attempt is
      // refunded), anything else is `embed_call_failed`, which SPENDS one of
      // five quarantine attempts that nothing ever reclaims. Rewording this
      // message — or throwing the raw AbortError, whose message "This operation
      // was aborted" matches nothing — would silently turn a slow-Ollama period
      // into permanent search-index loss. constants.ts records 12,237 ci.position
      // rows lost exactly that way. Fail here instead.
      expect(isUnreachable(EMBED_TIMEOUT_MESSAGE)).toBe(true);
      expect(EMBED_TIMEOUT_MESSAGE).toMatch(/ETIMEDOUT/);
      expect(isUnreachable('This operation was aborted')).toBe(false);
    });

    it('sits between the slowest measured SUCCESS and undici’s 300s headers timeout', () => {
      // Both bounds are load-bearing and neither is arbitrary.
      //
      // Upper: undici's `headersTimeout` default is the de-facto bound this
      // replaces (measured live at 301s/302.66s). At or above it, our timer
      // never fires, the socket is closed by undici instead of by us, and the
      // error message is whatever undici chose — so the whole point of
      // EMBED_TIMEOUT_MESSAGE's careful classification is lost.
      expect(EMBED_TIMEOUT_MS).toBeLessThan(300_000);

      // Lower: the appliance's ollama server.log recorded four SUCCESSFUL
      // (HTTP 200) /api/embed calls on 2026-08-30 at 2m56s, 3m10s, 3m31s and
      // 3m37s, queued behind a resident chat model. A ceiling below 217s
      // converts those working calls into `ollama_unreachable` failures that
      // are refunded onto the long retry schedule and meet the same queue —
      // rows silently never reach ci_search.vectors instead of arriving late.
      // The first version of this file set 120s and would have done exactly
      // that. Guard the evidence, not a round number.
      const SLOWEST_MEASURED_SUCCESS_MS = 217_000;
      expect(EMBED_TIMEOUT_MS).toBeGreaterThan(SLOWEST_MEASURED_SUCCESS_MS);
    });
  });

  describe('generateEmbeddingString', () => {
    it('formats the vector as a pgvector string literal', async () => {
      const service = makeService();

      const str = await service.generateEmbeddingString('hello');

      expect(str).toBe('[5,1]');
    });
  });
});
