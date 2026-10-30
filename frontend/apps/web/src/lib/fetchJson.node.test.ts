// fetchJson lives in @ci/common, which has no test runner of its own; the web
// app's node project is the nearest place its units can run. Imported through
// the package's public entry so the index.ts re-exports are exercised too.
import { FetchJsonError, fetchJson } from '@ci/common';
import { afterEach, describe, expect, it, vi } from 'vitest';

function jsonResponse(status: number, statusText: string, body: unknown) {
  return new Response(JSON.stringify(body), { status, statusText });
}

function stubFetch(res: Response) {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(res));
}

/** Headers arrive, then the body stalls; like a real fetch, aborting the request signal errors the body stream. */
function stubStalledBody(init: ResponseInit) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_input: unknown, requestInit?: RequestInit) => {
      const body = new ReadableStream({
        start(controller) {
          requestInit?.signal?.addEventListener('abort', () =>
            controller.error(new DOMException('The operation was aborted.', 'AbortError')),
          );
        },
      });

      return new Response(body, init);
    }),
  );
}

function fetchRejection(): Promise<FetchJsonError> {
  return fetchJson('/api/signup', { method: 'POST' }).then(
    () => {
      throw new Error('expected fetchJson to reject');
    },
    (e: unknown) => e as FetchJsonError,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('fetchJson error responses', () => {
  it('surfaces the server message and field issues from a validation 400', async () => {
    stubFetch(
      jsonResponse(400, 'Bad Request', {
        message: 'Validation failed',
        errors: [{ path: ['password'], message: 'Password must be at least 6 characters' }],
      }),
    );

    const err = await fetchRejection();

    expect(err).toBeInstanceOf(FetchJsonError);
    expect(err.status).toBe(400);
    expect(err.message).toBe('Validation failed');
    expect(err.issues).toEqual([{ path: ['password'], message: 'Password must be at least 6 characters' }]);
  });

  it('surfaces a plain NestJS exception message', async () => {
    stubFetch(
      jsonResponse(400, 'Bad Request', {
        statusCode: 400,
        message: 'Email already in use',
        error: 'Bad Request',
      }),
    );

    const err = await fetchRejection();

    expect(err.message).toBe('Email already in use');
    expect(err.issues).toEqual([]);
  });

  it('falls back to a string `error` key when there is no message', async () => {
    stubFetch(jsonResponse(409, 'Conflict', { error: 'orchestration already running' }));

    const err = await fetchRejection();

    expect(err.message).toBe('orchestration already running');
  });

  it('normalizes malformed entries in the errors array', async () => {
    stubFetch(
      jsonResponse(400, 'Bad Request', {
        message: 'Validation failed',
        errors: [
          null,
          'oops',
          42,
          ['password'],
          { path: 'password', message: 'string path is dropped' },
          { path: ['email'], message: { code: 'not_a_string' } },
          { path: ['email'], message: 'Invalid email address' },
        ],
      }),
    );

    const err = await fetchRejection();

    expect(err.issues).toEqual([
      { path: undefined, message: 'string path is dropped' },
      { path: ['email'], message: undefined },
      { path: ['email'], message: 'Invalid email address' },
    ]);
  });

  it('falls back to the status line when the body is not JSON', async () => {
    stubFetch(new Response('<html>upstream error</html>', { status: 502, statusText: 'Bad Gateway' }));

    const err = await fetchRejection();

    expect(err.message).toBe('Fetch failed: 502 Bad Gateway');
    expect(err.issues).toEqual([]);
  });

  it('gives up on a stalled error body instead of hanging', async () => {
    vi.useFakeTimers();
    // 502 headers arrive but the body stream never ends (half-open proxy).
    stubFetch(new Response(new ReadableStream({ start() {} }), { status: 502, statusText: 'Bad Gateway' }));

    const pending = fetchRejection();
    await vi.advanceTimersByTimeAsync(3_000);
    const err = await pending;

    expect(err).toBeInstanceOf(FetchJsonError);
    expect(err.message).toBe('Fetch failed: 502 Bad Gateway');
  });

  it('cancels a stalled body so the connection is not held open', async () => {
    vi.useFakeTimers();

    const cancelled = vi.fn();
    // Headers arrive, then the body stalls; `cancel` fires only if the timeout
    // releases the stream rather than abandoning an in-flight read.
    const body = new ReadableStream({ start() {}, cancel: cancelled });
    stubFetch(new Response(body, { status: 502, statusText: 'Bad Gateway' }));

    const pending = fetchRejection();
    await vi.advanceTimersByTimeAsync(3_000);
    await pending;

    expect(cancelled).toHaveBeenCalled();
  });

  it('lets an abort during the error-body read propagate as AbortError', async () => {
    // Deliberately not via fetchRejection(): that helper is typed for the
    // FetchJsonError path, and this case must NOT produce one.
    const aborted = {
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      text: () => Promise.reject(new DOMException('The operation was aborted.', 'AbortError')),
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(aborted as unknown as Response));

    const err: unknown = await fetchJson('/api/signup', { method: 'POST' }).catch((e: unknown) => e);

    expect(err).not.toBeInstanceOf(FetchJsonError);
    expect((err as Error).name).toBe('AbortError');
  });

  it('aborts a success body that stalls after the headers once `timeout` passes', async () => {
    vi.useFakeTimers();
    stubStalledBody({ status: 200 });

    const pending = fetchJson('/api/session', { timeout: 1_000 }).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(999);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);

    // Checked before awaiting, so a timer that no longer covers the body fails here
    // instead of hanging the test.
    expect(settled).toBe(true);

    const err = await pending;

    expect(err).not.toBeInstanceOf(FetchJsonError);
    expect((err as Error).name).toBe('AbortError');
  });

  it('reads a stalled error body under its own bound, not `timeout`', async () => {
    vi.useFakeTimers();
    stubStalledBody({ status: 502, statusText: 'Bad Gateway' });

    const pending = fetchJson('/api/session', { timeout: 1_000 }).catch((e: unknown) => e);
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(1_000);

    // The deadline ended at the 502's headers: it does not abort the body read.
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(2_000);

    expect(settled).toBe(true);

    const err = await pending;

    expect(err).toBeInstanceOf(FetchJsonError);
    expect((err as FetchJsonError).message).toBe('Fetch failed: 502 Bad Gateway');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears the timeout once the success body is read', async () => {
    vi.useFakeTimers();
    stubFetch(jsonResponse(200, 'OK', { accessToken: 'token' }));

    await expect(fetchJson('/api/session', { timeout: 1_000 })).resolves.toEqual({ accessToken: 'token' });

    expect(vi.getTimerCount()).toBe(0);
  });

  it('clears the timeout when reading a success body fails', async () => {
    vi.useFakeTimers();
    // The connection drops mid-body, well before the deadline.
    const body = new ReadableStream({
      start(controller) {
        controller.error(new TypeError('terminated'));
      },
    });
    stubFetch(new Response(body, { status: 200 }));

    await expect(fetchJson('/api/session', { timeout: 1_000 })).rejects.toThrow('terminated');

    expect(vi.getTimerCount()).toBe(0);
  });

  it('returns parsed JSON for 2xx responses', async () => {
    stubFetch(jsonResponse(200, 'OK', { accessToken: 'token' }));

    await expect(fetchJson('/api/signup')).resolves.toEqual({ accessToken: 'token' });
  });
});
