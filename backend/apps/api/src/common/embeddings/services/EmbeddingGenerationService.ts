import { Injectable } from '@nestjs/common';
import { Ollama } from 'ollama';
import plimit, { type LimitFunction } from 'p-limit';

import { LoggerService } from '@ci/common/logging';
import config from '@ci/configuration';

import { embedSkipReason } from '../embeddable';

interface PendingEmbedding {
  input: string;
  resolve: (vector: number[]) => void;
  reject: (error: unknown) => void;
}

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
 * Generates embedding vectors via Ollama's batched `/api/embed` endpoint.
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
 * Model and host are configurable (CI_EMBED_MODEL / OLLAMA_EMBED_HOST) so a
 * GPU/alternate-host Ollama can be targeted without code changes; concurrency
 * (CI_EMBED_CONCURRENCY) bounds in-flight HTTP requests, and
 * {@link EMBED_TIMEOUT_MS} bounds how long any one of them may take.
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
  private readonly host = config.embedding.host ?? config.services.ollama.host;

  private readonly model = config.embedding.model;

  private readonly batchSize = config.embedding.batchSize;

  private readonly coalesceWindowMs = config.embedding.coalesceWindowMs;

  private readonly limit: LimitFunction = plimit(config.embedding.concurrency);

  /** Texts buffered for the next coalesced flush. */
  private buffer: PendingEmbedding[] = [];

  private flushTimer: NodeJS.Timeout | null = null;

  constructor(private readonly logger: LoggerService) {
    this.logger.setContext(EmbeddingGenerationService.name);
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
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), EMBED_TIMEOUT_MS);

    const client = new Ollama({
      host: this.host,
      fetch: (input, init) => fetch(input, { ...init, signal: controller.signal }),
    });

    let response: Awaited<ReturnType<Ollama['embed']>>;

    try {
      response = await client.embed({
        model: this.model,
        input: batch,
      });
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

    const embeddings = response.embeddings;

    if (embeddings == null || embeddings.length !== batch.length) {
      throw new Error(`Ollama embed returned ${embeddings?.length ?? 0} vectors for ${batch.length} inputs`);
    }

    return embeddings;
  }
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
