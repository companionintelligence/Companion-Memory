import { Injectable } from '@nestjs/common';
import { Ollama } from 'ollama';
import plimit, { type LimitFunction } from 'p-limit';

import { LoggerService } from '@ci/common/logging';
import config, { EMBED_HOST_EXPLICITLY_CONFIGURED } from '@ci/configuration';
import { LlmEndpointService } from '@ci/domains/llm/services/LlmEndpointService';

import { embedSkipReason } from '../embeddable';
import { canonicalEmbedModel } from '../embedModelIdentity';

interface PendingEmbedding {
  input: string;
  resolve: (vector: number[]) => void;
  reject: (error: unknown) => void;
}

/**
 * Where a batch goes and in which dialect. `model` is the spelling THAT engine
 * lists the embedder under (Lemonade lists the weights Ollama calls
 * `nomic-embed-text` as `user.nomic-embed-text-v1.5-GGUF`), which is why it is
 * part of the target rather than read from config at call time.
 */
export type EmbedTarget =
  | { dialect: 'ollama'; host: string; model: string }
  | { dialect: 'openai'; baseUrl: string; apiKey: string; model: string };

/**
 * Per-call ceiling on one batched `/api/embed` request.
 *
 * Until this existed there was no bound at all in this class, and the de-facto
 * one was undici's 300s `headersTimeout` — measured live twice at 301s and
 * 302.66s while a ~20GB chat model sat VRAM-resident and the embedding model
 * could not get a slot.
 *
 * To be clear about what this does NOT fix: `TodoScanService.surfaceItems`
 * advertises a 60s ceiling on the whole scan and reaches this class through
 * `SearchService.search()`, and that promise is still false on the embed leg —
 * this endpoint is SHARED with the bulk index, whose batches legitimately take
 * minutes (see the measurements below), so it cannot be squeezed to 60s on one
 * caller's behalf. Keeping an interactive caller's own deadline is that
 * caller's job.
 *
 * THE VALUE IS PINNED TO MEASUREMENT, NOT TO TASTE. This started at 120s on the
 * reasoning that "a healthy batch returns in well under a second, so anything
 * above that is pathology". That reasoning is wrong, and the appliance's own
 * `~/.ollama/logs/server.log` says so: on 2026-08-30 four separate
 * `POST /api/embed` calls returned **200** — i.e. succeeded, vectors written —
 * at 2m56s, 3m10s, 3m31s and 3m37s (217s worst case), each immediately followed
 * by a burst of sub-50ms embeds as the backlog drained. They are slow for a
 * structural reason, not a broken one: the embedding runner is queued behind a
 * resident multi-GB chat model and cannot get a slot until it yields.
 *
 * A 120s ceiling turns every one of those successes into a failure, and the
 * consequence is not "three minutes late" but "not at all for a long while":
 * `DenseEmbedStageBase` classifies {@link EMBED_TIMEOUT_MESSAGE} as
 * `ollama_unreachable`, refunds the attempt and reschedules on the LONG
 * schedule, and the retry meets the same queue. Rows that were arriving late
 * would instead sit un-embedded and invisible to `ci_search.vectors`. A timeout
 * that fires on working calls is a worse bug than the hang it replaces.
 *
 * 270s is therefore chosen as: comfortably ABOVE the worst measured success
 * (217s, +24% headroom) and strictly BELOW undici's 300s `headersTimeout`, so
 * this remains the binding bound rather than a decoration. What it buys over
 * doing nothing is not speed — it is that the bound is explicit, that the
 * failure carries a deterministic, correctly-classified message instead of
 * undici's incidental one, and above all that the socket is genuinely CLOSED
 * (see `embedBatch`) rather than left for the server to finish answering into.
 *
 * If an operator wants a tighter latency bound for interactive callers, the
 * lever is the search path's own budget, not this ceiling — throttling the
 * shared batch endpoint would starve the bulk index to speed up one query. Not
 * a config key only because `configuration.ts` is out of reach of the change
 * that introduced it; promoting this to `config.embedding.timeoutMs` /
 * `CI_EMBED_TIMEOUT_MS` is a wanted follow-up.
 */
export const EMBED_TIMEOUT_MS = 270_000;

/**
 * Message thrown when {@link EMBED_TIMEOUT_MS} fires. THE `ETIMEDOUT` TOKEN IS
 * LOAD-BEARING — do not reword this string without reading the following.
 *
 * `DenseEmbedStageBase` (src/domains/pipeline/stages/index/DenseEmbedStageBase.ts)
 * classifies an embed failure by matching its MESSAGE against
 * `UNREACHABLE_PATTERNS` in `stages/index/embedVersion.ts`:
 *
 *   - matches  -> `ollama_unreachable`, which is in `TRANSIENT_FAILURE_REASONS`
 *     (src/domains/pipeline/constants.ts), so the quarantine attempt is REFUNDED
 *     and the row is retried on the long schedule.
 *   - no match -> `embed_call_failed`, which SPENDS one of five attempts. Once
 *     spent, nothing reclaims a quarantined row: `constants.ts` records a brief
 *     provider outage permanently quarantining 12,237 `ci.position` rows (19% of
 *     that corpus) exactly this way.
 *
 * Today's 300s hang surfaces as `fetch failed`, which matches, so it is treated
 * as transient. An `AbortError`'s own message is "This operation was aborted",
 * which matches NOTHING — throwing it raw would silently convert a slow-Ollama
 * period into permanent data loss across the search index. `ETIMEDOUT` is both
 * a listed pattern and semantically exact for a client-side transport timeout,
 * so it is the token used here, and a test asserts it is still present.
 *
 * The coupling is fragile and crosses a module boundary; the clean follow-up is
 * to add an explicit 'timed out' pattern to `UNREACHABLE_PATTERNS` and drop it.
 */
export const EMBED_TIMEOUT_MESSAGE = `Ollama embed timed out after ${EMBED_TIMEOUT_MS}ms (ETIMEDOUT) and the request was aborted`;

/**
 * Generates embedding vectors, batched, on whichever engine serves the embedder.
 *
 * Two dialects (see {@link EmbedTarget} and {@link resolveTarget}):
 *
 *  - Ollama's native `/api/embed`, which Ollama, Lemonade and CI-Hub's pool all
 *    serve. This is the path every measurement below was taken on.
 *  - OpenAI's `/v1/embeddings`, which every OpenAI-compatible engine serves
 *    (vLLM, llama.cpp, SGLang, Lemonade, Ollama's own `/v1`). Until 2026-09-30
 *    this class spoke only the native dialect, so a CI-Server whose chat backend
 *    was vLLM or llama.cpp — and had no Ollama beside it — embedded nothing.
 *
 * Two batching mechanisms work together:
 *
 *  1. {@link generateEmbeddings} — an explicit array API: many texts in, one (or
 *     a few `CI_EMBED_BATCH_SIZE`-sized) HTTP request(s) out. Use this when a
 *     caller already has N texts in hand.
 *
 *  2. A transparent COALESCING BUFFER behind {@link generateEmbedding}: the many
 *     concurrent per-row search-index workers each call `generateEmbedding(text)`
 *     with a single string; instead of one HTTP call per row, calls that arrive
 *     within `CI_EMBED_COALESCE_WINDOW_MS` are packed into a single `embed` call.
 *     This collapses the "one row = one Ollama call" hot path into batched calls
 *     without restructuring every listener, and is idempotent w.r.t. upserts (the
 *     callers still upsert per entity).
 *
 * The model is configurable (CI_EMBED_MODEL, or CI-Hub's handout), and an
 * explicit LLM_EMBEDDING_API_BASE pins the endpoint; without one the embedder follows the
 * chat backend when that backend serves it, else the Ollama host (see
 * {@link resolveTarget}). Concurrency (CI_EMBED_CONCURRENCY) bounds in-flight
 * HTTP requests, and {@link EMBED_TIMEOUT_MS} bounds how long any one may take.
 *
 * Note what a timeout costs the coalescing buffer: `flush()` rejects EVERY
 * buffered caller when the batch fails, so one slow call fails up to
 * `batchSize` unrelated per-row listeners at once. That is pre-existing
 * behaviour for any embed error — the timeout only makes it a routine event
 * rather than an outage-only one, and callers already treat a rejection as
 * "no vector this cycle" rather than as fatal.
 */
@Injectable()
export class EmbeddingGenerationService {
  private readonly model = config.embedding.model;

  /**
   * The resolved target, memoised until the chat endpoint changes (keyed on the
   * endpoint's identity in {@link resolveTarget}). Cleared, never replaced, on a
   * `/api/embed` 404 so the next batch re-resolves in the OpenAI dialect.
   */
  private target: { key: string; value: EmbedTarget } | null = null;

  /** Hosts whose `/api/embed` answered 404: they speak only the OpenAI dialect. */
  private readonly nativeRouteMissing = new Set<string>();

  private readonly batchSize = config.embedding.batchSize;

  private readonly maxInputChars = config.embedding.maxInputChars;

  /**
   * A tighter cap than `maxInputChars`, measured from the engine: the input
   * length a batch was accepted at after one it refused as too long. Per
   * target — cleared when the target changes — because the limit is the
   * engine's (nomic on llama-server takes 2,048 tokens; Ollama truncates).
   */
  private learnedInputChars: number | null = null;

  private readonly coalesceWindowMs = config.embedding.coalesceWindowMs;

  private readonly limit: LimitFunction = plimit(config.embedding.concurrency);

  /** Texts buffered for the next coalesced flush. */
  private buffer: PendingEmbedding[] = [];

  private flushTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly logger: LoggerService,
    private readonly endpoint: LlmEndpointService,
  ) {
    this.logger.setContext(EmbeddingGenerationService.name);
  }

  /**
   * Where the next batch goes. Public so the doctor / Settings can say where
   * embeddings run; the answer is memoised per chat endpoint.
   *
   * 1. `LLM_EMBEDDING_API_BASE` set (an operator, or CI-Hub handing out its
   *    pool; `OLLAMA_EMBED_HOST` is its deprecated name): that server, native
   *    dialect — falling to `/v1/embeddings` there once `/api/embed` has
   *    answered 404.
   * 2. Otherwise, chat on an OpenAI-compatible backend: ask it what it serves.
   *    If it lists the configured embedder — under any spelling
   *    `canonicalEmbedModel` folds to the same weights — embed THERE, in the
   *    OpenAI dialect, under the spelling it lists. One engine then holds one
   *    card's budget, which is the whole point: Ollama embedding beside a
   *    Lemonade that holds the card runs the embedder on the CPU.
   * 3. Otherwise (chat on Ollama; or the backend serves no embedder; or its
   *    listing failed): the Ollama host, native dialect. A failed listing is not
   *    memoised, so a backend that was merely slow to start is asked again on
   *    the next batch.
   */
  async resolveTarget(): Promise<EmbedTarget> {
    const driver = this.endpoint.getOpenAiDriver();
    const ollamaHost = this.endpoint.getOllamaHost();
    const key = `${driver?.baseUrl ?? ''}|${ollamaHost}`;

    if (this.target?.key === key) {
      return this.target.value;
    }

    // A new target is a new engine with its own limit.
    this.learnedInputChars = null;

    const pinnedHost = EMBED_HOST_EXPLICITLY_CONFIGURED ? config.embedding.apiBase : undefined;

    if (pinnedHost) {
      const value: EmbedTarget = this.nativeRouteMissing.has(pinnedHost)
        ? {
            dialect: 'openai',
            baseUrl: `${pinnedHost.replace(/\/$/, '')}/v1`,
            apiKey: config.llm.apiKey,
            model: this.model,
          }
        : { dialect: 'ollama', host: pinnedHost, model: this.model };

      this.target = { key, value };

      return value;
    }

    if (driver) {
      let served: string[];

      try {
        served = await driver.listModels();
      } catch (err: unknown) {
        this.logger.warn('Chat backend did not list its models; embedding on the Ollama host this batch', {
          baseUrl: driver.baseUrl,
          error: err instanceof Error ? err.message : String(err),
        });

        return { dialect: 'ollama', host: ollamaHost, model: this.model };
      }

      const wanted = canonicalEmbedModel(this.model);
      const listed =
        served.find((id) => id === this.model) ?? served.find((id) => canonicalEmbedModel(id) === wanted);

      if (listed) {
        const value: EmbedTarget = {
          dialect: 'openai',
          baseUrl: driver.baseUrl,
          apiKey: driver.apiKey,
          model: listed,
        };

        this.logger.log('Embedding on the chat backend, which serves the embedder', {
          baseUrl: driver.baseUrl,
          model: listed,
        });
        this.target = { key, value };

        return value;
      }

      this.logger.log('Chat backend does not serve the embedder; embedding on the Ollama host', {
        baseUrl: driver.baseUrl,
        model: this.model,
        ollamaHost,
      });
    }

    const value: EmbedTarget = { dialect: 'ollama', host: ollamaHost, model: this.model };

    this.target = { key, value };

    return value;
  }

  /**
   * Generate an embedding vector for a single text input.
   *
   * Transparently coalesced with other concurrent calls into a batched Ollama
   * request (see class docs). Throws if the input is empty/whitespace, matching
   * the previous behaviour (callers already guard with their own skip checks).
   */
  async generateEmbedding(input: string): Promise<number[]> {
    if (input == null || input.trim().length === 0) {
      throw new Error('Cannot embed empty text');
    }

    return new Promise<number[]>((resolve, reject) => {
      this.buffer.push({ input, resolve, reject });

      if (this.buffer.length >= this.batchSize) {
        // Buffer is full — flush immediately rather than waiting for the timer.
        this.flush();
      } else {
        this.scheduleFlush();
      }
    });
  }

  /**
   * Generate an embedding vector as a PostgreSQL-compatible string.
   */
  async generateEmbeddingString(input: string): Promise<string> {
    const vector = await this.generateEmbedding(input);

    return toVectorString(vector);
  }

  /**
   * Generate embedding vectors for many texts, batched into `CI_EMBED_BATCH_SIZE`
   * chunks and sent as array-input Ollama `embed` calls with bounded concurrency.
   *
   * Returns one vector per input, in the same order. Inputs must be non-empty;
   * callers should pre-filter with {@link embedSkipReason}/`isEmbeddable`.
   */
  async generateEmbeddings(inputs: string[]): Promise<number[][]> {
    if (inputs.length === 0) {
      return [];
    }

    const chunks = chunk(inputs, this.batchSize);

    const chunkResults = await Promise.all(chunks.map((batch) => this.limit(() => this.embedBatch(batch))));

    return chunkResults.flat();
  }

  /**
   * Schedule a deferred flush of the coalescing buffer. A window of 0 still
   * defers to the next macrotask so synchronously-issued calls coalesce.
   */
  private scheduleFlush(): void {
    if (this.flushTimer != null) {
      return;
    }

    this.flushTimer = setTimeout(() => {
      this.flush();
    }, this.coalesceWindowMs);

    // Don't keep the event loop alive solely for a pending embedding flush.
    this.flushTimer.unref?.();
  }

  /**
   * Drain the current buffer and embed it as batched array-input calls.
   */
  private flush(): void {
    if (this.flushTimer != null) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }

    if (this.buffer.length === 0) {
      return;
    }

    const pending = this.buffer;
    this.buffer = [];

    const inputs = pending.map((item) => item.input);

    // Chunk + concurrency-limit are handled by generateEmbeddings.
    this.generateEmbeddings(inputs)
      .then((vectors) => {
        pending.forEach((item, index) => {
          const vector = vectors[index];

          if (vector == null || vector.length === 0) {
            item.reject(new Error('Received empty embedding vector'));

            return;
          }

          item.resolve(vector);
        });
      })
      .catch((error: unknown) => {
        for (const item of pending) {
          item.reject(error);
        }
      });
  }

  /**
   * Single batched Ollama call, bounded by {@link EMBED_TIMEOUT_MS}. Validates
   * that the response contains one vector per input.
   *
   * The timeout genuinely CANCELS the request; it does not merely free the
   * caller. That distinction is the whole design, and this repo has already
   * been burned by getting it wrong: `OllamaService`'s old `abortable()` helper
   * raced the caller's promise against a signal while the request stayed in
   * flight, so the server generated to completion holding its model slot, and
   * each timed-out retry piled another orphaned generation onto an already
   * loaded backend — retries made it progressively WORSE. On the embed path the
   * same mistake would be worse still, because a batch of 32 would be orphaned
   * at a time.
   *
   * Reaching the socket takes a specific seam, verified against the pinned
   * client (`ollama@0.5.17`) with a server that accepts the POST and never
   * answers:
   *
   *   - `EmbedRequest` has NO `signal` field (`dist/shared/*.d.ts`), and
   *     `embed()` posts with `{ headers }` only (`dist/browser.mjs`), so there
   *     is nothing to pass per-request.
   *   - The client's own `abort()` is a NO-OP here: it walks
   *     `ongoingStreamedRequests`, which only the STREAMING branch ever
   *     populates. Measured — the promise stayed pending and the socket stayed
   *     open.
   *   - `Config.fetch` is the one seam left open (`this.fetch = config?.fetch ??
   *     fetch`). Injecting the signal there rejected in 315ms AND the server
   *     observed the peer close the socket.
   *
   * So the client is constructed per call, exactly as `OllamaService.runNativeChat`
   * already does for `chat()`. Construction is trivial (the constructor only
   * assigns config) and undici pools sockets process-wide, so connection reuse
   * is unaffected.
   *
   * The timer starts HERE rather than in `generateEmbeddings`, i.e. after
   * `p-limit` admits the chunk — a batch waiting behind three others must not
   * burn its budget while queued.
   */
  private async embedBatch(batch: string[]): Promise<number[][]> {
    const target = await this.resolveTarget();
    const cap = Math.min(this.maxInputChars, this.learnedInputChars ?? Number.POSITIVE_INFINITY);
    let inputs = batch.map((text) => text.slice(0, cap));

    // A batch the engine refuses as too long is sent again with every input
    // halved, a few times, rather than failed — see `isInputTooLong` for why
    // the engine's own limit is not known here.
    for (let shrink = 0; ; shrink += 1) {
      try {
        const vectors = await this.embedOnce(target, inputs);

        if (shrink > 0) {
          // The length that got through becomes the cap for every later batch
          // on this engine, so the refusal is paid once per process, not once
          // per long text. Floored: one dense text must not shorten prose for
          // everything that follows.
          const accepted = Math.max(...inputs.map((text) => text.length));

          this.learnedInputChars = Math.max(MIN_LEARNED_INPUT_CHARS, accepted);
          this.logger.log('Embedding input cap measured from the engine', {
            dialect: target.dialect,
            maxInputChars: this.learnedInputChars,
          });
        }

        return vectors;
      } catch (err: unknown) {
        const longest = Math.max(...inputs.map((text) => text.length));

        if (shrink >= MAX_INPUT_SHRINKS || longest <= MIN_INPUT_CHARS || !isInputTooLong(err)) {
          throw err;
        }

        inputs = inputs.map((text) => text.slice(0, Math.max(MIN_INPUT_CHARS, Math.floor(text.length / 2))));
        this.logger.warn('Embedding engine refused the batch as too long; retrying with shorter inputs', {
          dialect: target.dialect,
          longestChars: longest,
          retryLongestChars: Math.max(...inputs.map((text) => text.length)),
          error: err instanceof Error ? err.message.slice(0, 200) : String(err),
        });
      }
    }
  }

  /** One request for one batch, bounded by {@link EMBED_TIMEOUT_MS}. */
  private async embedOnce(target: EmbedTarget, batch: string[]): Promise<number[][]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), EMBED_TIMEOUT_MS);

    let embeddings: number[][] | undefined;

    try {
      embeddings =
        target.dialect === 'ollama'
          ? await this.embedNative(target, batch, controller.signal)
          : await this.embedOpenAi(target, batch, controller.signal);
    } catch (err: unknown) {
      // Rethrow OUR message, not the AbortError's — see EMBED_TIMEOUT_MESSAGE
      // for why the wording decides whether the pipeline refunds or spends a
      // row's quarantine budget. Checked on the controller rather than on the
      // error's shape so an abort is never mistaken for an unrelated failure.
      if (controller.signal.aborted) {
        throw new Error(EMBED_TIMEOUT_MESSAGE, { cause: err });
      }

      // Anything else keeps its original message so existing classification
      // (`fetch failed`, `ECONNREFUSED`, ...) is untouched.
      throw err;
    } finally {
      clearTimeout(timer);
    }

    if (embeddings == null || embeddings.length !== batch.length) {
      throw new Error(
        `${target.dialect === 'ollama' ? 'Ollama' : 'OpenAI-compatible'} embed returned ${embeddings?.length ?? 0} vectors for ${batch.length} inputs`,
      );
    }

    return embeddings;
  }

  /** `POST {host}/api/embed` through the pinned client, with the signal injected at its one seam. */
  private async embedNative(
    target: Extract<EmbedTarget, { dialect: 'ollama' }>,
    batch: string[],
    signal: AbortSignal,
  ): Promise<number[][]> {
    const client = new Ollama({
      host: target.host,
      fetch: (input, init) => fetch(input, { ...init, signal }),
    });

    try {
      const response = await client.embed({ model: target.model, input: batch });

      return response.embeddings;
    } catch (err: unknown) {
      // A pinned endpoint with no `/api/embed` at all (vLLM, llama.cpp, SGLang
      // behind LLM_EMBEDDING_API_BASE) answers 404 before it reads the body. Remember the host
      // and re-resolve in the OpenAI dialect; this batch fails as it would have.
      if (!signal.aborted && isRouteMissing(err)) {
        this.nativeRouteMissing.add(target.host);
        this.target = null;
        this.logger.warn('Embed host has no /api/embed; switching to /v1/embeddings there', {
          host: target.host,
        });
      }

      throw err;
    }
  }

  /**
   * `POST {baseUrl}/embeddings` with an array `input`, which every
   * OpenAI-compatible engine accepts. Plain `fetch` rather than the OpenAI SDK:
   * the SDK retries by default and would double a timed-out batch's cost.
   * Vectors come back in `data[].index` order, which is not guaranteed to be
   * request order, so they are placed by index.
   */
  private async embedOpenAi(
    target: Extract<EmbedTarget, { dialect: 'openai' }>,
    batch: string[],
    signal: AbortSignal,
  ): Promise<number[][]> {
    const response = await fetch(`${target.baseUrl.replace(/\/$/, '')}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(target.apiKey ? { Authorization: `Bearer ${target.apiKey}` } : {}),
      },
      body: JSON.stringify({ model: target.model, input: batch }),
      signal,
    });

    if (!response.ok) {
      const detail = (await response.text().catch(() => '')).slice(0, 300);

      throw new Error(
        `OpenAI-compatible embed at ${target.baseUrl} answered ${response.status}${detail ? `: ${detail}` : ''}`,
      );
    }

    const payload = (await response.json()) as { data?: Array<{ index?: number; embedding?: number[] }> };
    const rows = Array.isArray(payload.data) ? payload.data : [];
    const vectors: number[][] = Array.from({ length: rows.length }, () => []);

    rows.forEach((row, position) => {
      const at = Number.isInteger(row.index) ? (row.index as number) : position;

      vectors[at] = Array.isArray(row.embedding) ? row.embedding : [];
    });

    return vectors;
  }
}

/**
 * How many times a batch the engine refused as too long is halved and sent
 * again before the failure stands, and the length below which an input is
 * never cut further (one llama-server default `--ubatch-size`, 512 tokens,
 * is around 2,000 characters; an input this short that still fails is not a
 * length problem).
 */
const MAX_INPUT_SHRINKS = 3;
const MIN_INPUT_CHARS = 1_000;
/** The measured cap never drops below this: half the default is one refusal's worth, not a text's. */
const MIN_LEARNED_INPUT_CHARS = 4_000;

/**
 * Whether an embed failure is the engine refusing the input for its length.
 * Ollama's `/api/embed` truncates to the model's window by default, so this
 * is the OpenAI dialect's problem: llama-server (so Lemonade) answers 500
 * `input (N tokens) is too large to process. increase the physical batch size`
 * for anything past its `--ubatch-size`, and vLLM/TGI answer 400 with their
 * context-length wording. The limit itself is not reported anywhere a client
 * can read it before sending, so the batch is shrunk on the answer instead.
 */
export function isInputTooLong(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);

  return /too large to process|physical batch size|maximum context length|exceeds? (the )?(available )?context|context (size|length|window)/i.test(
    message,
  );
}

/** Whether an `ollama` client error is the server saying the route does not exist. */
function isRouteMissing(err: unknown): boolean {
  const status = (err as { status_code?: unknown } | null)?.status_code;

  return status === 404 && !/model/i.test(err instanceof Error ? err.message : '');
}

/** Format a numeric vector as a pgvector-compatible string literal. */
export function toVectorString(vector: number[]): string {
  return `[${vector.join(',')}]`;
}

/** Split an array into fixed-size chunks (last chunk may be smaller). */
function chunk<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];

  for (let i = 0; i < items.length; i += size) {
    result.push(items.slice(i, i + size));
  }

  return result;
}

export { embedSkipReason };
