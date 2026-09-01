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

function makeService(): EmbeddingGenerationService {
  const logger = { setContext: jest.fn(), log: jest.fn(), warn: jest.fn(), error: jest.fn() } as any;

  return new EmbeddingGenerationService(logger);
}

describe('EmbeddingGenerationService', () => {
  beforeEach(() => {
    embedMock.mockReset();
    embedMock.mockImplementation(defaultEmbedImpl);
    ollamaConfigs.length = 0;
  });

  // Belt and braces: a fake-timer test that times out never reaches its own
  // cleanup, and leaked fake timers make every later test hang on a real one.
  afterEach(() => {
    jest.useRealTimers();
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
