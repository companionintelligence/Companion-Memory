import { setApiKey } from '@ci/common/src/utils/apiAuth';
import { setApiBaseUrl } from '@ci/common/src/utils/apiBase';
import { FetchJsonError } from '@ci/common/src/utils/fetchJson';
import {
  enqueueOutboxItem,
  getOutboxItem,
  listOutbox,
  recordOutboxAttempt,
  removeOutboxItem,
  retryOutboxItem,
  type OutboxItem,
} from '@ci/common/src/utils/outbox';
import { flushOutbox, isPermanentFlushFailure, registerOutboxKind } from '@ci/common/src/utils/outboxFlush';
import { afterEach, describe, expect, it, vi } from 'vitest';

type GlobalWithWindow = { window?: unknown };

const HUB_BASE = 'http://127.0.0.1:4100';
const HUB_TOKEN = 'tok-abc';

function setWindow(value: unknown): void {
  (globalThis as GlobalWithWindow).window = value;
}

function urlOf(input: RequestInfo): string {
  return typeof input === 'string' ? input : (input as Request).url;
}

/** Native shell with the LocalHub plugin present. Returns the `start` spy. */
function setNativeWindow() {
  const start = vi.fn(async () => ({ baseUrl: HUB_BASE, token: HUB_TOKEN }));

  setWindow({
    Capacitor: {
      isNativePlatform: () => true,
      Plugins: { LocalHub: { start, stop: vi.fn(), getStatus: vi.fn() } },
    },
  });

  return start;
}

/** A fetch response good enough for fetchJson's `res.ok` / `res.text()` reads. */
function jsonResponse(status: number, body?: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: `status ${status}`,
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  } as unknown as Response;
}

interface RecordedCall {
  url: string;
  path: string;
  method: string;
  headers: Record<string, string>;
  body: Record<string, unknown> | undefined;
}

type Handler = (call: RecordedCall) => Response;

/** Installs a routing `fetch` stub and returns the log of calls it saw. */
function installFetch(handler: Handler): RecordedCall[] {
  const calls: RecordedCall[] = [];

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo, init?: RequestInit) => {
      const url = urlOf(input);
      const call: RecordedCall = {
        url,
        path: url.startsWith(HUB_BASE) ? url.slice(HUB_BASE.length) : url,
        method: (init?.method ?? 'GET').toUpperCase(),
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      };

      calls.push(call);

      return handler(call);
    }),
  );

  return calls;
}

function item(overrides: Partial<OutboxItem> & Pick<OutboxItem, 'id' | 'seq'>): OutboxItem {
  return {
    kind: 'position',
    capturedAt: '2026-08-13T10:00:00.000Z',
    status: 'pending',
    attempts: 0,
    lastError: null,
    payload: { note: overrides.id },
    ...overrides,
  };
}

/**
 * In-memory stand-in for the sidecar's SQLite queue, faithful enough to assert the
 * behaviors the contract cares about: FIFO by `seq`, idempotent enqueue, MAX_ATTEMPTS
 * escalation to `needs_attention`, and rows only ever leaving on an explicit delete.
 */
function fakeSidecar(seed: OutboxItem[] = [], options: { max?: number } = {}) {
  const max = options.max ?? 5000;
  const store = new Map(seed.map((entry) => [entry.id, { ...entry }]));
  const byKey = new Map<string, string>();
  let nextSeq = seed.reduce((highest, entry) => Math.max(highest, entry.seq), 0) + 1;

  const listOf = (status: string | null) =>
    [...store.values()]
      .filter((entry) => status == null || status === 'all' || entry.status === status)
      .sort((a, b) => a.seq - b.seq);

  const handler: Handler = (call) => {
    const [rawPath, query] = call.path.split('?');
    const segments = rawPath.split('/').filter(Boolean); // ['api','outbox', id?, verb?]
    const id = segments[2];
    const verb = segments[3];

    if (call.method === 'GET' && !id) {
      const status = new URLSearchParams(query ?? '').get('status');
      const all = listOf('all');

      return jsonResponse(200, {
        // List responses deliberately omit payloads, exactly as the sidecar does.
        items: listOf(status).map((entry) => {
          const summary = { ...entry };

          delete summary.payload;

          return summary;
        }),
        counts: {
          pending: all.filter((entry) => entry.status === 'pending').length,
          needsAttention: all.filter((entry) => entry.status === 'needs_attention').length,
          total: all.length,
        },
        capacity: { max, used: all.length, warnAt: Math.floor(max * 0.8) },
      });
    }

    if (call.method === 'POST' && !id) {
      const body = call.body as {
        kind: string;
        payload: Record<string, unknown>;
        capturedAt: string;
        idempotencyKey: string;
      };
      const existingId = byKey.get(body.idempotencyKey);

      if (existingId) {
        const existing = store.get(existingId);

        return jsonResponse(201, {
          id: existing?.id,
          status: 'pending',
          capturedAt: existing?.capturedAt,
          seq: existing?.seq,
        });
      }

      if (store.size >= max) {
        return jsonResponse(507, { error: 'queue_full' });
      }

      const created = item({
        id: `row-${nextSeq}`,
        seq: nextSeq,
        kind: body.kind,
        capturedAt: body.capturedAt,
        payload: body.payload,
      });

      nextSeq += 1;
      store.set(created.id, created);
      byKey.set(body.idempotencyKey, created.id);

      return jsonResponse(201, {
        id: created.id,
        status: 'pending',
        capturedAt: created.capturedAt,
        seq: created.seq,
      });
    }

    const target = id ? store.get(id) : undefined;

    if (!target) {
      return jsonResponse(404, { error: 'not_found' });
    }

    if (call.method === 'GET') {
      return jsonResponse(200, target);
    }

    if (call.method === 'DELETE') {
      store.delete(id);

      return jsonResponse(204);
    }

    if (call.method === 'POST' && verb === 'retry') {
      target.status = 'pending';
      target.attempts = 0;

      return jsonResponse(200, target);
    }

    if (call.method === 'POST' && verb === 'attempt') {
      const outcome = call.body as { ok: boolean; error?: string; permanent?: boolean };

      if (outcome.ok) {
        store.delete(id);

        return jsonResponse(204);
      }

      target.attempts += 1;
      target.lastError = outcome.error ?? null;
      target.status = outcome.permanent || target.attempts >= 5 ? 'needs_attention' : 'pending';

      return jsonResponse(200, target);
    }

    return jsonResponse(404, { error: 'not_found' });
  };

  return { store, handler };
}

/** Routes sidecar traffic to `sidecar` and everything else (the appliance) to `appliance`. */
function route(sidecar: Handler, appliance: Handler): Handler {
  return (call) => (call.url.startsWith(HUB_BASE) ? sidecar(call) : appliance(call));
}

const applianceAccepts: Handler = () => jsonResponse(201, { id: 'server-side-id' });

afterEach(() => {
  delete (globalThis as GlobalWithWindow).window;
  vi.unstubAllGlobals();
  vi.useRealTimers();
  setApiBaseUrl('');
  setApiKey(null);
});

describe('outbox client — happy paths against a mocked sidecar', () => {
  it('enqueues through POST /api/outbox with the bearer token and a client capture time', async () => {
    setNativeWindow();
    const { handler, store } = fakeSidecar();
    const calls = installFetch(handler);

    const result = await enqueueOutboxItem({
      kind: 'position',
      payload: { lat: 1, lng: 2 },
      capturedAt: '2026-08-13T09:59:00.000Z',
      idempotencyKey: 'key-1',
    });

    expect(result).toEqual({
      ok: true,
      value: { id: 'row-1', status: 'pending', capturedAt: '2026-08-13T09:59:00.000Z', seq: 1 },
    });
    expect(store.size).toBe(1);

    const [enqueue] = calls;
    expect(enqueue.url).toBe(`${HUB_BASE}/api/outbox`);
    expect(enqueue.method).toBe('POST');
    expect(enqueue.headers.Authorization).toBe(`Bearer ${HUB_TOKEN}`);
    expect(enqueue.body).toEqual({
      kind: 'position',
      payload: { lat: 1, lng: 2 },
      capturedAt: '2026-08-13T09:59:00.000Z',
      idempotencyKey: 'key-1',
    });
  });

  it('never sends the appliance API key to the sidecar (it would fail the WebView CORS preflight)', async () => {
    setNativeWindow();
    setApiKey('appliance-secret');
    const { handler } = fakeSidecar();
    const calls = installFetch(handler);

    await enqueueOutboxItem({ kind: 'position', payload: {} });

    expect(calls[0].headers['x-api-key']).toBeUndefined();
  });

  it('defaults capturedAt and idempotencyKey, and re-POSTing the same key does not duplicate', async () => {
    setNativeWindow();
    const { handler, store } = fakeSidecar();
    installFetch(handler);

    const first = await enqueueOutboxItem({ kind: 'position', payload: { a: 1 }, idempotencyKey: 'stable' });
    const second = await enqueueOutboxItem({ kind: 'position', payload: { a: 1 }, idempotencyKey: 'stable' });

    expect(first.ok && second.ok).toBe(true);
    expect(first.ok && first.value.id).toBe(second.ok && second.value.id);
    expect(store.size).toBe(1);
  });

  it('lists oldest-first with counts and capacity, omitting payloads', async () => {
    setNativeWindow();
    const { handler } = fakeSidecar([
      item({ id: 'b', seq: 2 }),
      item({ id: 'a', seq: 1 }),
      item({ id: 'c', seq: 3, status: 'needs_attention', attempts: 5, lastError: 'boom' }),
    ]);
    installFetch(handler);

    const result = await listOutbox();

    expect(result.ok).toBe(true);

    if (!result.ok) {
      return;
    }

    expect(result.value.items.map((entry) => entry.id)).toEqual(['a', 'b', 'c']);
    expect(result.value.items.every((entry) => entry.payload === undefined)).toBe(true);
    expect(result.value.counts).toEqual({ pending: 2, needsAttention: 1, total: 3 });
    expect(result.value.capacity).toEqual({ max: 5000, used: 3, warnAt: 4000 });
  });

  it('fetches a single item with its payload', async () => {
    setNativeWindow();
    const { handler } = fakeSidecar([item({ id: 'a', seq: 1, payload: { big: 'blob' } })]);
    installFetch(handler);

    const result = await getOutboxItem('a');

    expect(result.ok && result.value.payload).toEqual({ big: 'blob' });
  });

  it('records a failed attempt: increments attempts, keeps the item, and reports lastError', async () => {
    setNativeWindow();
    const { handler, store } = fakeSidecar([item({ id: 'a', seq: 1 })]);
    installFetch(handler);

    const result = await recordOutboxAttempt('a', { ok: false, error: 'network down', permanent: false });

    expect(result.ok && result.value?.attempts).toBe(1);
    expect(result.ok && result.value?.status).toBe('pending');
    expect(result.ok && result.value?.lastError).toBe('network down');
    expect(store.has('a')).toBe(true);
  });

  it('records a permanent failure as needs_attention', async () => {
    setNativeWindow();
    const { handler } = fakeSidecar([item({ id: 'a', seq: 1 })]);
    installFetch(handler);

    const result = await recordOutboxAttempt('a', { ok: false, error: 'rejected', permanent: true });

    expect(result.ok && result.value?.status).toBe('needs_attention');
  });

  it('records a successful attempt as a 204 that removes the item', async () => {
    setNativeWindow();
    const { handler, store } = fakeSidecar([item({ id: 'a', seq: 1 })]);
    installFetch(handler);

    const result = await recordOutboxAttempt('a', { ok: true });

    expect(result).toEqual({ ok: true, value: null });
    expect(store.has('a')).toBe(false);
  });

  it('retries a needs_attention item back to pending with attempts reset', async () => {
    setNativeWindow();
    const { handler } = fakeSidecar([
      item({ id: 'a', seq: 1, status: 'needs_attention', attempts: 5, lastError: 'boom' }),
    ]);
    installFetch(handler);

    const result = await retryOutboxItem('a');

    expect(result.ok && result.value.status).toBe('pending');
    expect(result.ok && result.value.attempts).toBe(0);
  });

  it('removes an item explicitly (user discard)', async () => {
    setNativeWindow();
    const { handler, store } = fakeSidecar([item({ id: 'a', seq: 1 })]);
    installFetch(handler);

    await expect(removeOutboxItem('a')).resolves.toEqual({ ok: true, value: undefined });
    expect(store.has('a')).toBe(false);
  });

  it('maps an unknown id to reason "not_found"', async () => {
    setNativeWindow();
    const { handler } = fakeSidecar();
    installFetch(handler);

    const result = await getOutboxItem('nope');

    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe('not_found');
  });

  it('maps a full queue to reason "full" — user data is refused, never evicted', async () => {
    setNativeWindow();
    const { handler, store } = fakeSidecar([item({ id: 'a', seq: 1 })], { max: 1 });
    installFetch(handler);

    const result = await enqueueOutboxItem({ kind: 'position', payload: { x: 1 } });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe('full');
    // The pre-existing capture is still there: nothing was dropped to make room.
    expect(store.has('a')).toBe(true);
  });
});

describe('outbox client — web (no sidecar) degradation', () => {
  it('reports "unavailable" rather than pretending an enqueue succeeded, and issues no request', async () => {
    setWindow({});
    const calls = installFetch(() => jsonResponse(200, {}));

    const result = await enqueueOutboxItem({ kind: 'position', payload: { x: 1 } });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toBe('unavailable');
    expect(calls).toHaveLength(0);
  });

  it('degrades every read/write the same way', async () => {
    setWindow({});
    installFetch(() => jsonResponse(200, {}));

    const results = await Promise.all([
      listOutbox(),
      getOutboxItem('a'),
      removeOutboxItem('a'),
      recordOutboxAttempt('a', { ok: true }),
      retryOutboxItem('a'),
    ]);

    for (const result of results) {
      expect(result.ok).toBe(false);
      expect(!result.ok && result.reason).toBe('unavailable');
    }
  });

  it('is "unavailable" natively too when the plugin is not installed/synced', async () => {
    setWindow({ Capacitor: { isNativePlatform: () => true, Plugins: {} } });
    installFetch(() => jsonResponse(200, {}));

    const result = await listOutbox();

    expect(!result.ok && result.reason).toBe('unavailable');
  });

  it('is "unavailable" when the sidecar refuses to start', async () => {
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
    installFetch(() => jsonResponse(200, {}));

    const result = await enqueueOutboxItem({ kind: 'position', payload: {} });

    expect(!result.ok && result.reason).toBe('unavailable');
  });
});

describe('flushOutbox — draining', () => {
  it('drains pending items in FIFO seq order, not the order the queue returned them', async () => {
    setNativeWindow();
    const { handler, store } = fakeSidecar([
      item({ id: 'third', seq: 30, payload: { n: 3 } }),
      item({ id: 'first', seq: 10, payload: { n: 1 } }),
      item({ id: 'second', seq: 20, payload: { n: 2 } }),
    ]);
    const calls = installFetch(route(handler, applianceAccepts));

    const summary = await flushOutbox();

    expect(summary).toEqual({ attempted: 3, succeeded: 3, failed: 0, unavailable: false, aborted: false });

    const flushed = calls.filter((call) => call.url === '/api/position').map((call) => call.body);
    expect(flushed).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);

    // Every row was reported as flushed and is gone from the queue.
    expect(store.size).toBe(0);
  });

  it('does NOT delete an item whose flush failed — it reports the failure and leaves it queued', async () => {
    setNativeWindow();
    const { handler, store } = fakeSidecar([item({ id: 'a', seq: 1 })]);
    const calls = installFetch(route(handler, () => jsonResponse(503, { message: 'appliance restarting' })));

    const summary = await flushOutbox();

    expect(summary).toMatchObject({ attempted: 1, succeeded: 0, failed: 1 });
    expect(store.get('a')).toMatchObject({ attempts: 1, status: 'pending' });
    expect(store.get('a')?.lastError).toContain('appliance restarting');

    // The only two ways a row may leave the queue are DELETE and a successful attempt
    // report; neither happened here.
    expect(calls.some((call) => call.method === 'DELETE')).toBe(false);
    const attempts = calls.filter((call) => call.path.endsWith('/attempt'));
    expect(attempts).toHaveLength(1);
    expect(attempts[0].body).toMatchObject({ ok: false, permanent: false });
  });

  it('classifies a 4xx rejection as permanent, parking the item in needs_attention', async () => {
    setNativeWindow();
    const { handler, store } = fakeSidecar([item({ id: 'a', seq: 1 })]);
    const calls = installFetch(route(handler, () => jsonResponse(422, { message: 'unprocessable' })));

    await flushOutbox();

    expect(calls.find((call) => call.path.endsWith('/attempt'))?.body).toMatchObject({
      ok: false,
      permanent: true,
    });
    expect(store.get('a')).toMatchObject({ status: 'needs_attention', attempts: 1 });
  });

  it('classifies a network failure as transient, leaving the item pending for the next drain', async () => {
    setNativeWindow();
    const { handler, store } = fakeSidecar([item({ id: 'a', seq: 1 })]);
    const calls = installFetch(
      route(handler, () => {
        throw new TypeError('Failed to fetch');
      }),
    );

    await flushOutbox();

    expect(calls.find((call) => call.path.endsWith('/attempt'))?.body).toMatchObject({ permanent: false });
    expect(store.get('a')).toMatchObject({ status: 'pending' });
  });

  it('treats an unroutable kind as permanent rather than retrying it forever or dropping it', async () => {
    setNativeWindow();
    const { handler, store } = fakeSidecar([item({ id: 'a', seq: 1, kind: 'no-such-kind' })]);
    const calls = installFetch(route(handler, applianceAccepts));

    await flushOutbox();

    // Nothing was POSTed onward — there was nowhere to POST it.
    expect(calls.some((call) => !call.url.startsWith(HUB_BASE))).toBe(false);
    expect(store.get('a')).toMatchObject({ status: 'needs_attention' });
  });

  it('flushes a kind registered at runtime', async () => {
    setNativeWindow();
    registerOutboxKind('test-note', '/api/test-notes');
    const { handler, store } = fakeSidecar([
      item({ id: 'a', seq: 1, kind: 'test-note', payload: { text: 'hi' } }),
    ]);
    const calls = installFetch(route(handler, applianceAccepts));

    await flushOutbox();

    expect(calls.find((call) => call.url === '/api/test-notes')?.body).toEqual({ text: 'hi' });
    expect(store.size).toBe(0);
  });

  it('serializes: a second call joins the drain in flight instead of double-flushing', async () => {
    setNativeWindow();
    const { handler } = fakeSidecar([item({ id: 'a', seq: 1 }), item({ id: 'b', seq: 2 })]);
    const calls = installFetch(route(handler, applianceAccepts));

    const [first, second] = await Promise.all([flushOutbox(), flushOutbox()]);

    expect(first).toBe(second);
    expect(first.attempted).toBe(2);

    // One drain means exactly one list request and one onward POST per item.
    expect(calls.filter((call) => call.path === '/api/outbox?status=pending')).toHaveLength(1);
    expect(calls.filter((call) => call.url === '/api/position')).toHaveLength(2);
  });

  it('stops cleanly when the signal aborts (connection mode dropped mid-drain)', async () => {
    setNativeWindow();
    const controller = new AbortController();
    const { handler, store } = fakeSidecar([item({ id: 'a', seq: 1 }), item({ id: 'b', seq: 2 })]);
    const calls = installFetch(
      route(handler, (call) => {
        // Abort after the first onward POST, mid-drain.
        if (call.url === '/api/position') {
          controller.abort();
        }

        return applianceAccepts(call);
      }),
    );

    const summary = await flushOutbox({ signal: controller.signal });

    expect(summary).toMatchObject({ attempted: 1, succeeded: 1, aborted: true });
    expect(calls.filter((call) => call.url === '/api/position')).toHaveLength(1);
    // The undrained item is untouched, not lost.
    expect(store.get('b')).toMatchObject({ status: 'pending', attempts: 0 });
  });

  it('reports unavailable on web without attempting anything', async () => {
    setWindow({});
    const calls = installFetch(() => jsonResponse(200, {}));

    await expect(flushOutbox()).resolves.toEqual({
      attempted: 0,
      succeeded: 0,
      failed: 0,
      unavailable: true,
      aborted: false,
    });
    expect(calls).toHaveLength(0);
  });
});

describe('isPermanentFlushFailure', () => {
  it('treats a plain 4xx as permanent', () => {
    expect(isPermanentFlushFailure(new FetchJsonError(400, 'Bad Request'))).toBe(true);
    expect(isPermanentFlushFailure(new FetchJsonError(422, 'Unprocessable'))).toBe(true);
  });

  it('treats repairable/timing 4xx as transient', () => {
    for (const status of [401, 403, 408, 425, 429]) {
      expect(isPermanentFlushFailure(new FetchJsonError(status, 'nope'))).toBe(false);
    }
  });

  it('treats 5xx and non-HTTP errors as transient', () => {
    expect(isPermanentFlushFailure(new FetchJsonError(500, 'Server Error'))).toBe(false);
    expect(isPermanentFlushFailure(new TypeError('Failed to fetch'))).toBe(false);
    expect(isPermanentFlushFailure('not even an error')).toBe(false);
  });
});
