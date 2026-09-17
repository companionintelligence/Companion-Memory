import type { LlmFirstResponseTimeoutError } from '../firstResponseDeadline';
import { createFirstResponseFetch, isFirstResponseTimeout } from '../firstResponseDeadline';

/**
 * The deadline bounds ONE phase — the wait for response headers — and must
 * leave the rest alone: a generation that has started streams to the end, and
 * the caller's own signal still tears the body down. What it replaces was
 * undici's five-minute headers timeout surfacing as a bare `fetch failed`.
 */
describe('createFirstResponseFetch', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  /** A fetch that never answers unless told to, recording the signal it got. */
  function pendingFetch() {
    let settle: (response: Response) => void = () => undefined;
    const seen: { signal?: AbortSignal | null }[] = [];
    const baseFetch = jest.fn((_input: unknown, init?: RequestInit) => {
      seen.push({ signal: init?.signal });

      return new Promise<Response>((resolve, reject) => {
        settle = resolve;
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });
    }) as unknown as typeof fetch;

    return { baseFetch, seen, respond: () => settle({ ok: true } as Response) };
  }

  it('rejects with the typed error when the backend sends nothing before the deadline', async () => {
    const { baseFetch, seen } = pendingFetch();
    const bounded = createFirstResponseFetch({ model: 'gemma4:e4b', deadlineMs: 90_000, baseFetch });

    const request = bounded.fetch('http://ollama/api/chat', { method: 'POST' });
    const outcome = request.then(
      () => 'resolved',
      (err: unknown) => err,
    );

    await jest.advanceTimersByTimeAsync(89_999);
    expect(bounded.timedOut()).toBe(false);

    await jest.advanceTimersByTimeAsync(1);

    const err = await outcome;

    expect(isFirstResponseTimeout(err)).toBe(true);
    expect((err as LlmFirstResponseTimeoutError).message).toContain('gemma4:e4b');
    expect((err as LlmFirstResponseTimeoutError).message).toContain('90000ms');
    expect(bounded.timedOut()).toBe(true);
    expect(bounded.error()).toBe(err);
    // The socket was actually torn down, not just the caller freed.
    expect(seen[0].signal?.aborted).toBe(true);
  });

  it('clears the deadline once headers arrive, so a long generation is never cut by it', async () => {
    const { baseFetch, seen, respond } = pendingFetch();
    const bounded = createFirstResponseFetch({ model: 'm', deadlineMs: 1_000, baseFetch });

    const request = bounded.fetch('http://ollama/api/chat');

    await jest.advanceTimersByTimeAsync(500);
    respond();
    await expect(request).resolves.toMatchObject({ ok: true });

    // Far past the deadline: the body would still be streaming in real life.
    await jest.advanceTimersByTimeAsync(60_000);

    expect(bounded.timedOut()).toBe(false);
    expect(seen[0].signal?.aborted).toBe(false);
  });

  it("forwards the caller's abort to the socket, before and after headers", async () => {
    const { baseFetch, seen, respond } = pendingFetch();
    const controller = new AbortController();
    const bounded = createFirstResponseFetch({
      model: 'm',
      deadlineMs: 1_000,
      signal: controller.signal,
      baseFetch,
    });

    const request = bounded.fetch('http://ollama/api/chat');

    respond();
    await request;
    expect(seen[0].signal?.aborted).toBe(false);

    // Stop pressed mid-stream.
    controller.abort();

    expect(seen[0].signal?.aborted).toBe(true);
    expect(bounded.timedOut()).toBe(false);
  });

  it('never issues a request on an already-aborted signal', async () => {
    const { baseFetch, seen } = pendingFetch();
    const controller = new AbortController();

    controller.abort();

    const bounded = createFirstResponseFetch({
      model: 'm',
      deadlineMs: 1_000,
      signal: controller.signal,
      baseFetch,
    });

    await expect(bounded.fetch('http://ollama/api/chat')).rejects.toBeDefined();
    // Nothing reached the socket: a request issued after its abort would be
    // orphaned, since a listener added to an aborted signal never fires.
    expect(seen).toHaveLength(0);
    expect(baseFetch).not.toHaveBeenCalled();
    expect(bounded.timedOut()).toBe(false);
  });

  it('passes the rest of the request through untouched', async () => {
    const { baseFetch, respond } = pendingFetch();
    const bounded = createFirstResponseFetch({ model: 'm', deadlineMs: 1_000, baseFetch });

    const request = bounded.fetch('http://ollama/api/chat', { method: 'POST', body: '{}' });

    respond();
    await request;

    expect(baseFetch).toHaveBeenCalledWith(
      'http://ollama/api/chat',
      expect.objectContaining({ method: 'POST', body: '{}' }),
    );
  });
});
