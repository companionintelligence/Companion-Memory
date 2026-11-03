/**
 * Shared `fetch` stand-ins for tests that drive real network-facing code.
 *
 * These were copied per-file for a while, which let them drift: some modelled
 * `statusText`, some routed by URL, some honoured the abort signal. Keeping one
 * copy means a fix to how a fake models a Response or an AbortError lands
 * everywhere at once, rather than leaving the missed copies quietly asserting
 * nothing.
 */

import { vi } from 'vitest';

/** The URL of a `fetch` argument, whichever of the two forms it takes. */
export function urlOf(input: RequestInfo): string {
  return typeof input === 'string' ? input : (input as Request).url;
}

/** A response good enough for fetchJson's `res.ok` / `res.text()` reads. */
export function okResponse(body: unknown = { status: 'ok' }): Response {
  return { ok: true, status: 200, text: async () => JSON.stringify(body) } as unknown as Response;
}

/** Models both endpoints required for a healthy Companion Memory connection. */
export function memoryApiResponse(input: RequestInfo): Response {
  const path = new URL(urlOf(input), 'http://localhost').pathname;

  return okResponse(path.endsWith('/api/graphql') ? { data: { __typename: 'Query' } } : { status: 'ok' });
}

/**
 * A healthy server that takes `latencyMs` to answer, and that honours an abort
 * the way real `fetch` does. Honouring it is the whole point: fetchJson's
 * timeout has no race of its own — it aborts the request and lets the rejection
 * propagate — so a stand-in that ignores the signal answers late and succeeds
 * under any budget, and the test asserts nothing.
 */
export function slowServer(latencyMs: number, body?: unknown) {
  return vi.fn(
    (_input: RequestInfo, init?: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => resolve(okResponse(body)), latencyMs);

        init?.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          reject(err);
        });
      }),
  );
}

/** A delayed health + GraphQL pair that respects the probe's abort signal. */
export function slowMemoryServer(latencyMs: number) {
  return vi.fn(
    (input: RequestInfo, init?: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => resolve(memoryApiResponse(input)), latencyMs);

        init?.signal?.addEventListener('abort', () => {
          clearTimeout(timer);
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          reject(err);
        });
      }),
  );
}
