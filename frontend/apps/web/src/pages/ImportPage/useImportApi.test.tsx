import { useEffect, useState } from 'react';

import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useActiveImports, useImportApi, useRunProgress } from './useImportApi';

/**
 * The hook must return a STABLE object.
 *
 * Every call on it is already a `useCallback`, but the object wrapping them was
 * a fresh literal each render. A caller with `[api]` in an effect then re-ran
 * that effect on every render — fetch, set state, re-render, fetch — and /import
 * hammered `/api/import/sources` and `/api/import/runs` as fast as the responses
 * came back. Nothing failed; it just would not stop.
 *
 * The reference test is the direct one, but the loop test is the one that
 * describes the symptom, so both are here.
 */

// `authenticated` as well as `authToken`: the real `useAuth` reports
// `Boolean(accessToken) || Boolean(nativeApiKey)`, and the import API now gates
// on that rather than on the web JWT — the JWT is null inside the Capacitor
// app, whose credential is a keystore key `fetchJson` attaches itself, so
// gating on the token made the whole import surface inert on a phone. A mock
// that omits it is a session the real hook could never produce.
vi.mock('@/hooks', () => ({ useAuth: () => [{ authToken: 'test-token', authenticated: true }] }));

beforeEach(() => {
  vi.restoreAllMocks();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } })),
  );
});

describe('useImportApi', () => {
  it('returns the same object across renders', () => {
    const seen: unknown[] = [];

    function Probe({ tick }: { tick: number }) {
      const api = useImportApi();

      seen.push(api);

      return <span>{tick}</span>;
    }

    const { rerender } = render(<Probe tick={0} />);

    rerender(<Probe tick={1} />);
    rerender(<Probe tick={2} />);

    expect(seen.length).toBeGreaterThanOrEqual(3);
    expect(seen.every((entry) => entry === seen[0])).toBe(true);
  });

  it('does not re-fire an effect that depends on it', async () => {
    // The shape ImportPage uses: fetch on mount, store the result, and depend on
    // the whole api object. If that object churns, this never settles.
    let effectRuns = 0;

    function Consumer() {
      const api = useImportApi();
      const [, setLoaded] = useState<unknown[]>([]);

      useEffect(() => {
        effectRuns += 1;
        void api.listRuns().then(setLoaded);
      }, [api]);

      return null;
    }

    render(<Consumer />);

    await waitFor(() => expect(effectRuns).toBeGreaterThan(0));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(effectRuns).toBe(1);
  });
});

/**
 * Deselecting a run has to CLEAR it.
 *
 * The Close button on an opened import called its handler and set the active id
 * to null, and nothing happened: this hook returned the previous run forever, so
 * the page still had something to render. The component test asserted the
 * handler fired, which it did — the button was never the broken part.
 */
describe('useRunProgress', () => {
  function Probe({ runId }: { runId: string | null }) {
    const { run } = useRunProgress(runId);

    return <span data-testid="run">{run == null ? 'none' : run.id}</span>;
  }

  it('drops the run when the id goes null', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ id: 'run-1', status: 'completed', stages: [], percent: 100 }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
      ),
    );

    const { rerender } = render(<Probe runId="run-1" />);

    await waitFor(() => expect(screen.getByTestId('run')).toHaveTextContent('run-1'));

    rerender(<Probe runId={null} />);

    await waitFor(() => expect(screen.getByTestId('run')).toHaveTextContent('none'));
  });
});

/**
 * `uploadFile` is the one call in this file that does NOT go through
 * `fetchJson`/`fetch` — it needs upload-progress events, which `fetch` has no
 * hook for, so it drives a raw `XMLHttpRequest` by hand. That hand-rolled
 * event wiring (`onerror`, `ontimeout`, the status-code branch, the JSON
 * body-parsing fallback) is exactly the kind of code that looks right and
 * silently isn't, so it gets its own fake XHR rather than trusting fetch mocks
 * to stand in for it.
 */
describe('useImportApi uploadFile', () => {
  class FakeXHR {
    static instances: FakeXHR[] = [];

    method = '';

    url = '';

    headers: Record<string, string> = {};

    upload: {
      onprogress: ((event: { lengthComputable: boolean; loaded: number; total: number }) => void) | null;
    } = { onprogress: null };

    onerror: (() => void) | null = null;

    ontimeout: (() => void) | null = null;

    onload: (() => void) | null = null;

    status = 0;

    responseText = '';

    sentBody: FormData | null = null;

    constructor() {
      FakeXHR.instances.push(this);
    }

    open(method: string, url: string) {
      this.method = method;
      this.url = url;
    }

    setRequestHeader(name: string, value: string) {
      this.headers[name] = value;
    }

    send(body: FormData) {
      this.sentBody = body;
    }
  }

  function useProbeApi() {
    let captured: ReturnType<typeof useImportApi> | null = null;

    function Probe() {
      captured = useImportApi();

      return null;
    }

    render(<Probe />);

    // The hook is memoized and authToken is fixed for this file, so the
    // effect-free render above already produced the stable object.
    return captured as unknown as ReturnType<typeof useImportApi>;
  }

  beforeEach(() => {
    FakeXHR.instances = [];
    vi.stubGlobal('XMLHttpRequest', FakeXHR as unknown as typeof XMLHttpRequest);
  });

  it('POSTs the file with the current auth header', () => {
    const api = useProbeApi();
    const file = new File(['bytes'], 'export.zip');

    void api.uploadFile(file);

    const [xhr] = FakeXHR.instances;

    expect(xhr.method).toBe('POST');
    expect(xhr.url).toBe('/api/import/uploads');
    expect(xhr.headers.Authorization).toBe('Bearer test-token');
    expect(xhr.sentBody?.get('files')).toBe(file);
  });

  it('rejects with a network-error message when the request errors out', async () => {
    const api = useProbeApi();
    const promise = api.uploadFile(new File(['x'], 'a.zip'));

    FakeXHR.instances[0].onerror?.();

    await expect(promise).rejects.toThrow('Upload failed: network error');
  });

  it('rejects with a timeout message on ontimeout', async () => {
    const api = useProbeApi();
    const promise = api.uploadFile(new File(['x'], 'a.zip'));

    FakeXHR.instances[0].ontimeout?.();

    await expect(promise).rejects.toThrow('Upload failed: timed out');
  });

  it('surfaces the server-provided message on a non-2xx JSON response', async () => {
    const api = useProbeApi();
    const promise = api.uploadFile(new File(['x'], 'a.zip'));
    const xhr = FakeXHR.instances[0];

    xhr.status = 422;
    xhr.responseText = JSON.stringify({ message: 'Not enough disk space to unpack' });
    xhr.onload?.();

    await expect(promise).rejects.toThrow('Not enough disk space to unpack');
  });

  it('joins an array message body into one line', async () => {
    const api = useProbeApi();
    const promise = api.uploadFile(new File(['x'], 'a.zip'));
    const xhr = FakeXHR.instances[0];

    xhr.status = 400;
    xhr.responseText = JSON.stringify({ message: ['name is required', 'file is required'] });
    xhr.onload?.();

    await expect(promise).rejects.toThrow('name is required, file is required');
  });

  it('falls back to a status-code message when the failure body is not JSON', async () => {
    const api = useProbeApi();
    const promise = api.uploadFile(new File(['x'], 'a.zip'));
    const xhr = FakeXHR.instances[0];

    xhr.status = 500;
    xhr.responseText = 'Internal Server Error';
    xhr.onload?.();

    await expect(promise).rejects.toThrow('Upload failed (500)');
  });

  it('resolves with the staged drop on a 2xx response', async () => {
    const api = useProbeApi();
    const promise = api.uploadFile(new File(['x'], 'a.zip'));
    const xhr = FakeXHR.instances[0];

    xhr.status = 201;
    xhr.responseText = JSON.stringify([{ dropId: 'drop-1', originalFilename: 'a.zip' }]);
    xhr.onload?.();

    await expect(promise).resolves.toEqual({ dropId: 'drop-1', originalFilename: 'a.zip' });
  });

  it('rejects when a 2xx response carries no drop at all', async () => {
    const api = useProbeApi();
    const promise = api.uploadFile(new File(['x'], 'a.zip'));
    const xhr = FakeXHR.instances[0];

    xhr.status = 200;
    xhr.responseText = '[]';
    xhr.onload?.();

    await expect(promise).rejects.toThrow('Nothing was uploaded');
  });

  it('reports byte progress as the upload streams', () => {
    const api = useProbeApi();
    const onProgress = vi.fn();

    void api.uploadFile(new File(['x'], 'a.zip'), onProgress);

    FakeXHR.instances[0].upload.onprogress?.({ lengthComputable: true, loaded: 512, total: 2048 });

    expect(onProgress).toHaveBeenCalledWith(512, 2048);
  });

  it('does not report progress when the event has no computable length', () => {
    const api = useProbeApi();
    const onProgress = vi.fn();

    void api.uploadFile(new File(['x'], 'a.zip'), onProgress);

    FakeXHR.instances[0].upload.onprogress?.({ lengthComputable: false, loaded: 0, total: 0 });

    expect(onProgress).not.toHaveBeenCalled();
  });
});

/**
 * The one poll that feeds the pinned progress region on every page that shows it.
 *
 * The rule it has to hold, and the reason `useRunsProgress` exists at all: ONE
 * request per tick however many runs are in flight. A 13-source batch import
 * polling `/import/runs/:id` per run was 13 requests every two seconds with 13
 * independent re-render clocks, which is the same shape that pegged the tab's
 * renderer process at a Takeout's 140 runs.
 *
 * And the rule it has to break, deliberately: unlike `useRunsProgress` this
 * cannot stop for good, because it answers "is ANYTHING importing" and that
 * becomes true again when a run starts from the CLI, the inbox or another tab.
 * So it slows to a thirtieth of the rate instead of stopping, and pauses
 * outright on a hidden tab.
 */
describe('useActiveImports', () => {
  function Probe({ activeMs = 20, idleMs = 5_000 }: { activeMs?: number; idleMs?: number } = {}) {
    const { snapshot } = useActiveImports(activeMs, idleMs);

    return <span data-testid="state">{snapshot == null ? 'none' : String(snapshot.active)}</span>;
  }

  const ACTIVE = {
    generatedAt: '2026-08-19T01:24:00.000Z',
    active: true,
    batch: {
      total: 13,
      running: 12,
      queued: 0,
      completed: 1,
      failed: 0,
      cancelled: 0,
      percent: 51,
      records: 2_777,
      startedAt: '2026-08-19T00:17:24.000Z',
      elapsedMs: 3_960_000,
    },
    queue: {
      // Per KIND since the queues were split; `slots` is the total in flight.
      concurrency: { unpack: 1, parse: 1, media: 2, push: 1 },
      slots: 5,
      running: 1,
      waiting: 12,
      blocked: 12,
      longestWaitMs: 3_060_000,
    },
    runs: [],
    truncated: false,
  };

  const IDLE = { ...ACTIVE, active: false, runs: [] };

  function stub(body: unknown) {
    // Typed with the real fetch signature so a test can assert the URL it asked
    // for; a zero-arg mock infers an empty tuple and `calls[0][0]` will not
    // typecheck.
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL) =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );

    vi.stubGlobal('fetch', fetchMock);

    return fetchMock;
  }

  it('asks one endpoint, once, whatever the run count', async () => {
    const fetchMock = stub(ACTIVE);

    // A long active cadence so this assertion cannot race the 20ms poll the
    // other cases use — we are counting first-paint requests, not ticks.
    render(<Probe activeMs={60_000} />);

    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('true'));
    // Thirteen runs in flight; one request.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/import/runs/active');
  });

  it('keeps a fast cadence while something is importing', async () => {
    const fetchMock = stub(ACTIVE);

    render(<Probe />);

    // The 20ms "active" interval this probe configured — a progress bar has to
    // move.
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(3), {
      timeout: 2_000,
    });
  });

  it('slows right down when nothing is importing, rather than stopping dead', async () => {
    // Stopping would be cheaper and wrong: an import started from the CLI, the
    // inbox, or another tab would never appear until someone reloaded.
    const fetchMock = stub(IDLE);

    render(<Probe />);

    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('false'));

    const afterFirst = fetchMock.mock.calls.length;

    // Well past the 20ms active cadence and nowhere near the 5s idle one.
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(fetchMock.mock.calls.length).toBe(afterFirst);
  });

  it('survives a blip mid-import without replacing the bar with an error', async () => {
    // A progress bar someone is watching must not vanish because one poll
    // failed — the same bargain useRunProgress makes.
    let calls = 0;

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        calls += 1;

        if (calls === 1) {
          return new Response(JSON.stringify(ACTIVE), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }

        throw new Error('network down');
      }),
    );

    render(<Probe />);

    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('true'));
    // Inside `act` so the failing poll's state update lands before the
    // assertion rather than after the test has finished.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });

    // Still showing the last good snapshot.
    expect(screen.getByTestId('state')).toHaveTextContent('true');
  });
});

/**
 * The hidden-tab rule, and the bug that shaped it.
 *
 * Pausing REPEAT polls on a hidden tab is the point — this page is left open for
 * hours while a 40GB Takeout runs. Pausing the FIRST one is a bug, and it was a
 * real one: rendered in an offscreen browser pane, which reports
 * `visibilityState: 'hidden'` for its entire life, the progress region never
 * appeared at all and nothing would ever fire `visibilitychange` to rescue it.
 * Prerendered pages and tabs restored in the background have the same shape.
 */
describe('useActiveImports on a hidden tab', () => {
  function hide(state: DocumentVisibilityState) {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  }

  function Probe() {
    const { snapshot } = useActiveImports(20, 5_000);

    return <span data-testid="state">{snapshot == null ? 'none' : String(snapshot.active)}</span>;
  }

  const BODY = {
    generatedAt: '2026-08-19T01:24:00.000Z',
    active: true,
    batch: {
      total: 1,
      running: 1,
      queued: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
      percent: 55,
      records: 0,
      startedAt: null,
      elapsedMs: null,
    },
    queue: {
      concurrency: { unpack: 1, parse: 1, media: 2, push: 1 },
      slots: 5,
      running: 1,
      waiting: 0,
      blocked: 0,
      longestWaitMs: null,
    },
    runs: [],
    truncated: false,
  };

  it('still reads once, then stops repeating', async () => {
    hide('hidden');

    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL) =>
        new Response(JSON.stringify(BODY), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );

    vi.stubGlobal('fetch', fetchMock);
    render(<Probe />);

    // The region renders, hidden or not.
    await waitFor(() => expect(screen.getByTestId('state')).toHaveTextContent('true'));

    // …and then goes silent, rather than polling a bar nobody can see.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    hide('visible');
  });
});
