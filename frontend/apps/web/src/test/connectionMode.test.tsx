import { type ReactNode } from 'react';

import { setApiKey } from '@ci/common/src/utils/apiAuth';
import { setApiBaseUrl } from '@ci/common/src/utils/apiBase';
import {
  ConnectionModeProvider,
  LOCAL_PROBE_TIMEOUT_MS,
  REMOTE_PROBE_TIMEOUT_MS,
  resolveConnectionMode,
  useConnectionMode,
} from '@ci/common/src/utils/connectionMode';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { okResponse, slowServer, urlOf } from './fetchFakes';

type GlobalWithWindow = { window?: unknown };

function setWindow(value: unknown): void {
  (globalThis as GlobalWithWindow).window = value;
}

// Captured at module load, before any test below replaces `globalThis.window` with a
// bare fake for the pure-function tests. The `useConnectionMode` tests mount a real
// component tree and need the genuine jsdom `window` (with a real `addEventListener`)
// restored, regardless of what an earlier test in this file left `window` set to.
const REAL_WINDOW = (globalThis as GlobalWithWindow).window;

afterEach(() => {
  // Unmount any real component tree (from the `useConnectionMode` tests below) BEFORE
  // deleting `window`: its effect cleanup calls `window.removeEventListener`, and the
  // shared setup.ts `afterEach(() => cleanup())` is not guaranteed to run before this one.
  cleanup();
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

  it('prefers "connected" when remote answers, even if LocalHub is also healthy', async () => {
    // Fake timers so the LOSING (local) leg's 20ms delay, below, never becomes a real
    // pending timer that outlives this test: left real, it fires ~20ms of wall-clock
    // time later — often while a *later* test has since become the one with a `fetch`
    // stub installed — and silently calls that neighbor's mock, inflating its call
    // count. `afterEach`'s `vi.useRealTimers()` discards a still-pending fake timer
    // for free; there is nothing to advance since the winning leg needs no timer at all.
    vi.useFakeTimers();

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

  it('still resolves "connected" when the on-device sidecar answers first', async () => {
    const start = vi.fn(async () => ({ baseUrl: 'http://127.0.0.1:4100', token: 'tok-abc' }));

    setWindow({
      Capacitor: {
        isNativePlatform: () => true,
        Plugins: { LocalHub: { start, stop: vi.fn(), getStatus: vi.fn() } },
      },
    });

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo) => {
        if (urlOf(input).startsWith('http://127.0.0.1:4100')) {
          return okResponse();
        }

        await new Promise((resolve) => setTimeout(resolve, 30));

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
    await vi.advanceTimersByTimeAsync(REMOTE_PROBE_TIMEOUT_MS - 100);
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

  it('resolves "connected" for a remote that answers slower than an on-device server would', async () => {
    vi.useFakeTimers();
    setWindow({});

    // A remote appliance reached over a WAN/tunnel: healthy, but well past the
    // budget that suits an on-device sidecar. Aborting here is what made the
    // indicator read "Not synced yet" against a perfectly reachable server.
    const remoteLatencyMs = LOCAL_PROBE_TIMEOUT_MS + 200;

    // The stand-in honours the abort signal (see `slowServer`), which is what
    // makes this assert anything at all under a changed budget.
    vi.stubGlobal('fetch', slowServer(remoteLatencyMs));

    const resultPromise = resolveConnectionMode();

    await vi.advanceTimersByTimeAsync(remoteLatencyMs + 10);

    expect(await resultPromise).toBe('connected');
  });

  it('bounds a server that answers its headers and then stalls the body, releasing the request', async () => {
    vi.useFakeTimers();
    setWindow({});

    // The budget has to cover the whole exchange, not just the headers: an
    // unbounded body read leaves one hung request per re-probe tick open
    // against the origin. The stub only ends when the probe's own signal
    // aborts, so nothing but that abort can resolve this race.
    let bodyAborted = false;

    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: RequestInfo, init?: RequestInit) => {
        return {
          ok: true,
          status: 200,
          text: () =>
            new Promise<string>((_resolve, reject) => {
              init?.signal?.addEventListener('abort', () => {
                bodyAborted = true;
                const err = new Error('The operation was aborted');
                err.name = 'AbortError';
                reject(err);
              });
            }),
        } as unknown as Response;
      }),
    );

    const resultPromise = resolveConnectionMode();

    await vi.advanceTimersByTimeAsync(REMOTE_PROBE_TIMEOUT_MS - 100);
    expect(bodyAborted).toBe(false);

    await vi.advanceTimersByTimeAsync(200);

    expect(await resultPromise).toBe('fresh');
    expect(bodyAborted).toBe(true);
  });
});

function useConnectionModeWrapper({ children }: { children: ReactNode }) {
  return <ConnectionModeProvider args={[]}>{children}</ConnectionModeProvider>;
}

/**
 * `resolveConnectionMode` above is the probe race in isolation. This is the coalescing
 * layer around it, inside `useConnectionMode` — the part that stops an `online` event
 * landing mid-probe from either running a second concurrent fetch, or being silently
 * dropped and leaving the mode pinned to a stale answer until the next re-probe tick.
 */
describe('useConnectionMode — refresh coalescing', () => {
  it('does not start a second probe for a refresh requested while one is in flight, but does not drop it either', async () => {
    // Fake timers make this deterministic: `setInterval`/`addEventListener` targets the
    // real window (restored below, since the mount effect needs a genuine
    // `window.addEventListener`), but nothing here depends on real wall-clock timing —
    // every step is advanced explicitly.
    vi.useFakeTimers();
    setWindow(REAL_WINDOW);

    let releaseFirstProbe: (() => void) | undefined;
    const fetchMock = vi.fn(() => {
      // First call: the probe already running when the caller's `online` event fires.
      // Held open until the test releases it, then reports failure — modelling the
      // still-offline read that was in flight the instant connectivity actually returned.
      if (fetchMock.mock.calls.length === 1) {
        return new Promise<Response>((_resolve, reject) => {
          releaseFirstProbe = () => reject(new Error('still offline'));
        });
      }

      // Second call: the trailing re-run's probe, made after the real reconnect.
      return Promise.resolve(okResponse());
    });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useConnectionMode(), { wrapper: useConnectionModeWrapper });

    // The provider's own mount effect calls refresh() immediately.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Three refresh() calls land while that first probe is still pending (e.g. `online`
    // firing, then a render re-running an effect that also calls refresh()). All three
    // must collapse into a single trailing re-run, not one each and not zero.
    act(() => {
      result.current.refresh();
      result.current.refresh();
      result.current.refresh();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The in-flight (offline-era) probe finally settles...
    await act(async () => {
      releaseFirstProbe?.();
      await vi.advanceTimersByTimeAsync(0);
    });

    // ...which must trigger exactly the one coalesced re-run, not zero (the request that
    // arrived mid-flight would be lost forever) and not three (one per requeued call).
    expect(fetchMock).toHaveBeenCalledTimes(2);

    // And that re-run is what actually answers the request that arrived mid-flight: the
    // mode ends up "connected", not stuck on the stale failure the first probe reported.
    expect(result.current.mode).toBe('connected');
  });

  it('runs a refresh requested after the in-flight one has already settled as its own probe', async () => {
    vi.useFakeTimers();
    setWindow(REAL_WINDOW);
    const fetchMock = vi.fn(async () => okResponse());
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useConnectionMode(), { wrapper: useConnectionModeWrapper });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(result.current.isResolved).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // Nothing in flight now — this is a genuinely new request, not a coalesced one, and
    // must run its own probe rather than being mistaken for a stale requeue.
    await act(async () => {
      result.current.refresh();
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
