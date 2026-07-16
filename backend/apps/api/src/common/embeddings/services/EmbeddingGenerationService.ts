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
 * (CI_EMBED_CONCURRENCY) bounds in-flight HTTP requests. If the configured
 * model isn't present on the Ollama host, it's pulled automatically on first
 * use (CI_EMBED_AUTO_INSTALL_MODEL=false to require an explicit pre-pull).
 */
@Injectable()
export class EmbeddingGenerationService {
  private readonly ollama = new Ollama({
    host: config.embedding.host ?? config.services.ollama.host,
  });

  private readonly model = config.embedding.model;

  private readonly batchSize = config.embedding.batchSize;

  private readonly coalesceWindowMs = config.embedding.coalesceWindowMs;

  private readonly limit: LimitFunction = plimit(config.embedding.concurrency);

  /** Texts buffered for the next coalesced flush. */
  private buffer: PendingEmbedding[] = [];

  private flushTimer: NodeJS.Timeout | null = null;

  /**
   * In-flight `ollama pull` for the configured model, memoized so a burst of
   * concurrent embed calls hitting "model not found" only triggers one pull.
   * Cleared on failure so a later embed call can retry the pull.
   */
  private pullPromise: Promise<void> | null = null;

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
   * Single batched Ollama call. Validates that the response contains one vector
   * per input. If the configured model isn't present on the Ollama host and
   * auto-install is enabled (default), pulls it once and retries the call —
   * so a fresh deployment (or a newly-changed CI_EMBED_MODEL) self-heals
   * instead of failing every embed until an operator runs `ollama pull` by hand.
   */
  private async embedBatch(batch: string[]): Promise<number[][]> {
    try {
      return await this.embedBatchOnce(batch);
    } catch (error) {
      if (!config.embedding.autoInstallModel || !isModelNotFoundError(error)) {
        throw error;
      }

      await this.ensureModelPulled();

      return this.embedBatchOnce(batch);
    }
  }

  private async embedBatchOnce(batch: string[]): Promise<number[][]> {
    const response = await this.ollama.embed({
      model: this.model,
      input: batch,
    });

    const embeddings = response.embeddings;

    if (embeddings == null || embeddings.length !== batch.length) {
      throw new Error(`Ollama embed returned ${embeddings?.length ?? 0} vectors for ${batch.length} inputs`);
    }

    return embeddings;
  }

  /**
   * Pulls the configured embedding model, memoizing the in-flight request so
   * concurrent callers share one `ollama pull` instead of racing several.
   */
  private async ensureModelPulled(): Promise<void> {
    if (!this.pullPromise) {
      this.pullPromise = (async () => {
        this.logger.warn(
          `Embedding model "${this.model}" not found on Ollama host; pulling it now (this can take a while for large models)...`,
        );

        await this.ollama.pull({ model: this.model, stream: false });

        this.logger.log(`Pulled embedding model "${this.model}".`);
      })().catch((error: unknown) => {
        // Let a later embed call retry the pull rather than getting stuck on
        // a rejected promise forever (e.g. a transient network blip).
        this.pullPromise = null;

        throw error;
      });
    }

    return this.pullPromise;
  }
}

/**
 * Ollama's client throws `ResponseError` (status_code 404) with a message
 * like `model "foo" not found, try pulling it first` when the model isn't
 * present locally. Match on status code first (cheap, precise); fall back to
 * the message text since the client's ResponseError isn't a public export we
 * can `instanceof`-check against.
 */
function isModelNotFoundError(error: unknown): boolean {
  if (error == null || typeof error !== 'object') {
    return false;
  }

  const { status_code: statusCode, message } = error as { status_code?: number; message?: string };

  if (statusCode === 404) {
    return true;
  }

  return typeof message === 'string' && /not found/i.test(message);
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
