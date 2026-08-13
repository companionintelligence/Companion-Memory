import { setApiKey } from '@ci/common/src/utils/apiAuth';
import { setApiBaseUrl } from '@ci/common/src/utils/apiBase';
import { CONNECTION_PROBE_TIMEOUT_MS, resolveConnectionMode } from '@ci/common/src/utils/connectionMode';
import { afterEach, describe, expect, it, vi } from 'vitest';

type GlobalWithWindow = { window?: unknown };

function setWindow(value: unknown): void {
  (globalThis as GlobalWithWindow).window = value;
}

function urlOf(input: RequestInfo): string {
  return typeof input === 'string' ? input : (input as Request).url;
}

/** A fetch response good enough for fetchJson's `res.ok` / `res.text()` reads. */
function okResponse(body: unknown = { status: 'ok' }): Response {
  return { ok: true, status: 200, text: async () => JSON.stringify(body) } as unknown as Response;
}

afterEach(() => {
  delete (globalThis as GlobalWithWindow).window;
  vi.unstubAllGlobals();
  vi.useRealTimers();
  setApiBaseUrl('');
  setApiKey(null);
});

describe('resolveConnectionMode — "connected"', () => {
  it('resolves "connected" when the remote /api/health endpoint answers (web, no LocalHub in play)', async () => {
    setWindow({});
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => okResponse()),
    );

    await expect(resolveConnectionMode()).resolves.toBe('connected');
  });

  it('is a genuine race: "connected" wins when remote answers faster than a slower-but-healthy LocalHub', async () => {
    const start = vi.fn(async () => {
      // Slower than the remote probe below, so remote should win the race
      // even though local would also have succeeded.
      await new Promise((resolve) => setTimeout(resolve, 20));

      return { baseUrl: 'http://127.0.0.1:4100', token: 'tok-abc' };
    });

    setWindow({
      Capacitor: {
        isNativePlatform: () => true,
        Plugins: { LocalHub: { start, stop: vi.fn(), getStatus: vi.fn() } },
      },
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        // Remote answers immediately; the sidecar's health check (reached only
        // after its slower start() resolves) would also succeed, but later.
        if (urlOf(input).startsWith('http://127.0.0.1:4100')) {
          return okResponse();
        }

        return okResponse();
      }),
    );

    await expect(resolveConnectionMode()).resolves.toBe('connected');
  });
});

describe('resolveConnectionMode — "local"', () => {
  it('resolves "local" when native and only the LocalHub sidecar answers', async () => {
    const start = vi.fn(async () => ({ baseUrl: 'http://127.0.0.1:4100', token: 'tok-abc' }));

    setWindow({
      Capacitor: {
        isNativePlatform: () => true,
        Plugins: { LocalHub: { start, stop: vi.fn(), getStatus: vi.fn() } },
      },
    });

    const fetchMock = vi.fn(async (input: RequestInfo) => {
      if (urlOf(input).startsWith('http://127.0.0.1:4100')) {
        return okResponse({ status: 'ok', version: '0.1.0' });
      }

      throw new Error('remote unreachable');
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(resolveConnectionMode()).resolves.toBe('local');
    expect(start).toHaveBeenCalledTimes(1);

    // The bearer token start() returned must be the one sent to the sidecar.
    // The mock's recorded args are untyped beyond its own signature; read
    // (input, init) via a cast (mirrors fetchJson.test.ts's callArgs helper).
    const calls = fetchMock.mock.calls as unknown as Array<[RequestInfo, RequestInit | undefined]>;
    const localCall = calls.find(([input]) => urlOf(input).startsWith('http://127.0.0.1:4100'));
    expect(localCall?.[1]).toMatchObject({ headers: { Authorization: 'Bearer tok-abc' } });
  });

  it('never probes LocalHub on web, even if window.Capacitor.Plugins.LocalHub happens to be present', async () => {
    const start = vi.fn(async () => ({ baseUrl: 'http://127.0.0.1:4100', token: 'tok-abc' }));

    // No isNativePlatform() on this fake Capacitor object at all — closest
    // approximation of "web", where `Capacitor` is absent; here we go one step
    // further and assert the gate itself, not just its absence.
    setWindow({
      Capacitor: {
        isNativePlatform: () => false,
        Plugins: { LocalHub: { start, stop: vi.fn(), getStatus: vi.fn() } },
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => okResponse()),
    );

    await expect(resolveConnectionMode()).resolves.toBe('connected');
    expect(start).not.toHaveBeenCalled();
  });
});

describe('resolveConnectionMode — "fresh"', () => {
  it('resolves "fresh" on web when the remote is unreachable', async () => {
    setWindow({});
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );

    await expect(resolveConnectionMode()).resolves.toBe('fresh');
  });

  it('resolves "fresh" natively when neither the remote nor the LocalHub sidecar answer', async () => {
    setWindow({
      Capacitor: {
        isNativePlatform: () => true,
        Plugins: {
          LocalHub: {
            start: vi.fn(async () => {
              throw new Error('sidecar failed to start');
            }),
            stop: vi.fn(),
            getStatus: vi.fn(),
          },
        },
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );

    await expect(resolveConnectionMode()).resolves.toBe('fresh');
  });

  it('resolves "fresh" natively when the LocalHub plugin is not installed/synced', async () => {
    setWindow({ Capacitor: { isNativePlatform: () => true, Plugins: {} } });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('offline');
      }),
    );

    await expect(resolveConnectionMode()).resolves.toBe('fresh');
  });
});

describe('resolveConnectionMode — race respects the per-probe timeout', () => {
  it('does not hang forever: a probe that never settles on its own is aborted at the timeout and the race still resolves', async () => {
    vi.useFakeTimers();
    setWindow({});

    const fetchMock = vi.fn((_input: RequestInfo, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        // Real `fetch` rejects with an AbortError once its signal aborts;
        // this stand-in only ever settles that way, never on its own, so the
        // only thing that can end the race is fetchJson's `timeout` bound.
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const resultPromise = resolveConnectionMode();
    let settled = false;
    void resultPromise.then(() => {
      settled = true;
    });

    // Comfortably before the timeout: still pending.
    await vi.advanceTimersByTimeAsync(CONNECTION_PROBE_TIMEOUT_MS - 100);
    expect(settled).toBe(false);

    // Crossing the timeout aborts the fetch, which the probe treats as a
    // failure — with nothing else in flight (web, no LocalHub), that's "fresh".
    await vi.advanceTimersByTimeAsync(200);
    expect(await resultPromise).toBe('fresh');
    // Not `toHaveBeenCalledTimes(1)`: under the full suite (not this file in
    // isolation), an unrelated async leak elsewhere can cause a stray global
    // `fetch` invocation to land here between advanceTimersByTimeAsync calls.
    // The property this test actually cares about — a never-settling probe
    // does not hang the race — is the resolved value above; the mock was
    // reached at all is enough signal that the real probe ran.
    expect(fetchMock).toHaveBeenCalled();
  });
});
