/**
 * A first-response deadline for one model request.
 *
 * The failure this bounds, measured 2026-09-11: a chat turn asked Ollama for a
 * model the scheduler could not swap in (the GPU was never idle), and the
 * request sat with NO response at all — no headers, no token — until undici's
 * five-minute headers timeout tore it down as a bare `fetch failed`. The queue
 * job then rode pg-boss's 15-minute expiry. Neither number was chosen for
 * this; they were just what was there.
 *
 * This wraps `fetch` so the connect-and-wait-for-headers phase is bounded by
 * `llm.firstResponseTimeoutMs`, and ONLY that phase: once the backend has
 * started answering the timer is cleared, so a long generation is never cut
 * by it (output length is `num_predict`'s job). The caller's own signal keeps
 * aborting the body for the life of the request, exactly as before.
 *
 * A deadline that fires rejects with {@link LlmFirstResponseTimeoutError}, a
 * typed error with the model and the budget in its message, so a job that
 * fails this way is diagnosable in `pgboss.job.output` — the `fetch failed`
 * it replaces said nothing.
 */
export class LlmFirstResponseTimeoutError extends Error {
  constructor(
    readonly model: string,
    readonly deadlineMs: number,
  ) {
    super(
      `LLM backend sent no response within ${deadlineMs}ms for model "${model}"; ` +
        'the request was aborted before the model started answering',
    );
    this.name = 'LlmFirstResponseTimeoutError';
  }
}

export function isFirstResponseTimeout(error: unknown): error is LlmFirstResponseTimeoutError {
  return error instanceof LlmFirstResponseTimeoutError;
}

export interface FirstResponseFetch {
  /** Hand this to the client as `config.fetch`. */
  fetch: typeof fetch;
  /** `true` once the deadline has fired on any request made through {@link fetch}. */
  timedOut(): boolean;
  /** The error the deadline rejected with, for callers whose client re-wraps rejections. */
  error(): LlmFirstResponseTimeoutError | undefined;
}

/**
 * Build a `fetch` whose wait for response headers is bounded by `deadlineMs`,
 * and which still honours `signal` for the whole request.
 *
 * Aborted with a REASON (the typed error), which is what `fetch` rejects with
 * on Node 18+, so the client's rejection is the error itself rather than a
 * generic `AbortError` the caller has to correlate with a timer.
 */
export function createFirstResponseFetch(options: {
  model: string;
  deadlineMs: number;
  signal?: AbortSignal;
  baseFetch?: typeof fetch;
}): FirstResponseFetch {
  const { model, deadlineMs, signal } = options;
  let firedWith: LlmFirstResponseTimeoutError | undefined;

  const wrapped: typeof fetch = async (input, init) => {
    // A caller whose budget already expired gets no request at all — see
    // runNativeChat on why a request issued after its abort is orphaned.
    signal?.throwIfAborted();

    const controller = new AbortController();
    const forwardAbort = () => controller.abort(signal?.reason);

    signal?.addEventListener('abort', forwardAbort, { once: true });

    const timer = setTimeout(() => {
      firedWith = new LlmFirstResponseTimeoutError(model, deadlineMs);
      controller.abort(firedWith);
    }, deadlineMs);

    try {
      // Resolves when the response HEADERS arrive; the body streams after.
      // `globalThis.fetch` is read per call, not captured at construction, so
      // a test (or an instrumented runtime) that swaps it sees the swap.
      const baseFetch = options.baseFetch ?? globalThis.fetch;

      return await baseFetch(input, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  };

  return {
    fetch: wrapped,
    timedOut: () => firedWith != null,
    error: () => firedWith,
  };
}
