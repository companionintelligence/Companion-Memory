/**
 * The seam between "a capture is durably queued" and "the queue actually empties".
 *
 * `outbox.test.ts` covers the store and the drain in isolation — given a queue and a call to
 * `flushOutbox`, the right things happen. What is asserted here is the part a user actually
 * experiences: nobody calls `flushOutbox` by hand, so the queue only empties if some signal
 * in the running app starts a drain. These tests drive the real providers with the real
 * events (`offline`/`online`, Capacitor `appStateChange`) and assert the queue is empty
 * afterwards.
 *
 * Both cases below failed before the wiring they cover existed, in the way that matters
 * least visibly: no error, no rejected promise — the capture simply sat in SQLite forever
 * while the UI reported itself connected.
 */

import { setApiKey } from '@ci/common/src/utils/apiAuth';
import { setApiBaseUrl } from '@ci/common/src/utils/apiBase';
import { ConnectionModeProvider } from '@ci/common/src/utils/connectionMode';
import { enqueueOutboxItem, type OutboxItem } from '@ci/common/src/utils/outbox';
import {
  OutboxQueueProvider,
  resetIngestFinishState,
  useOutboxQueue,
} from '@ci/common/src/utils/outboxFlush';
import { act, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const HUB_BASE = 'http://127.0.0.1:4100';
const HUB_TOKEN = 'tok-abc';

type AppStateListener = (event: { isActive: boolean }) => void;

function urlOf(input: RequestInfo): string {
  return typeof input === 'string' ? input : (input as Request).url;
}

function jsonResponse(status: number, body?: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: `status ${status}`,
    text: async () => (body === undefined ? '' : JSON.stringify(body)),
  } as unknown as Response;
}

/**
 * Puts a Capacitor shell on the *real* jsdom window rather than replacing it (as the
 * non-React outbox tests do) — React needs the genuine window to render into. Returns a
 * handle for firing `appStateChange` the way `@capacitor/app` would.
 */
function installNativeShell() {
  const listeners: AppStateListener[] = [];

  const App = {
    addListener: vi.fn(async (eventName: string, listener: AppStateListener) => {
      if (eventName === 'appStateChange') {
        listeners.push(listener);
      }

      return { remove: vi.fn() };
    }),
  };

  (window as unknown as { Capacitor?: unknown }).Capacitor = {
    isNativePlatform: () => true,
    Plugins: {
      App,
      LocalHub: {
        start: vi.fn(async () => ({ baseUrl: HUB_BASE, token: HUB_TOKEN })),
        stop: vi.fn(),
        getStatus: vi.fn(),
      },
    },
  };

  return {
    /** True once `addAppStateListener`'s async subscription has landed. */
    subscribed: () => listeners.length > 0,
    foreground: async () => {
      await act(async () => {
        listeners.forEach((listener) => listener({ isActive: true }));
      });
    },
  };
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
 * Minimal sidecar: enough of `/api/outbox` to enqueue, list, read and delete. Deliberately
 * a separate, smaller fake than `outbox.test.ts`'s — that one exists to assert the store's
 * own contract (attempt budgets, the 507 wall), none of which is under test here.
 */
function fakeSidecar() {
  const store = new Map<string, OutboxItem>();
  let nextSeq = 1;

  const handler = (call: { path: string; method: string; body?: Record<string, unknown> }) => {
    const [rawPath, query] = call.path.split('?');
    const segments = rawPath.split('/').filter(Boolean); // ['api','outbox', id?, verb?]

    if (segments[1] === 'health') {
      return jsonResponse(200, { status: 'ok' });
    }

    const id = segments[2];
    const verb = segments[3];

    if (call.method === 'GET' && !id) {
      const status = new URLSearchParams(query ?? '').get('status');
      const all = [...store.values()].sort((a, b) => a.seq - b.seq);

      return jsonResponse(200, {
        items: all
          .filter((entry) => status == null || status === 'all' || entry.status === status)
          .map((entry) => {
            const summary = { ...entry };

            delete summary.payload;

            return summary;
          }),
        counts: {
          pending: all.filter((entry) => entry.status === 'pending').length,
          needsAttention: all.filter((entry) => entry.status === 'needs_attention').length,
          total: all.length,
        },
        capacity: { max: 5000, used: all.length, warnAt: 4000 },
      });
    }

    if (call.method === 'POST' && !id) {
      const body = call.body as { kind: string; payload: Record<string, unknown>; capturedAt: string };
      const created = item({
        id: `row-${nextSeq}`,
        seq: nextSeq,
        kind: body.kind,
        capturedAt: body.capturedAt,
        payload: body.payload,
      });

      nextSeq += 1;
      store.set(created.id, created);

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

    if (call.method === 'POST' && verb === 'attempt') {
      const outcome = call.body as { ok: boolean };

      if (outcome.ok) {
        store.delete(id);

        return jsonResponse(204);
      }

      target.attempts += 1;

      return jsonResponse(200, target);
    }

    return jsonResponse(404, { error: 'not_found' });
  };

  return { store, handler };
}

/**
 * Routes sidecar traffic to the fake queue and everything else to the appliance, whose
 * reachability is controlled by the returned `remote` switch — flipping it is this suite's
 * stand-in for airplane mode.
 */
function installFetch(sidecar: ReturnType<typeof fakeSidecar>['handler']) {
  const remote = { up: true };

  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo, init?: RequestInit) => {
      const url = urlOf(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;

      if (url.startsWith(HUB_BASE)) {
        return sidecar({ path: url.slice(HUB_BASE.length), method, body });
      }

      if (!remote.up) {
        throw new TypeError('Network request failed');
      }

      return jsonResponse(url.includes('/api/health') ? 200 : 201, { status: 'ok' });
    }),
  );

  return remote;
}

function Probe() {
  const { pending } = useOutboxQueue();

  return <span data-testid="pending">{pending}</span>;
}

function mount() {
  return render(
    <ConnectionModeProvider args={[]}>
      <OutboxQueueProvider args={[]}>
        <Probe />
      </OutboxQueueProvider>
    </ConnectionModeProvider>,
  );
}

/** Fire a real window connectivity event, as the OS does. */
async function fireWindowEvent(name: 'online' | 'offline') {
  await act(async () => {
    window.dispatchEvent(new Event(name));
  });
}

afterEach(() => {
  delete (window as unknown as { Capacitor?: unknown }).Capacitor;
  vi.unstubAllGlobals();
  vi.useRealTimers();
  resetIngestFinishState();
  setApiBaseUrl('');
  setApiKey(null);
});

describe('outbox drains on reconnect', () => {
  it('flushes a capture taken during an outage once connectivity returns', async () => {
    installNativeShell();
    const { store, handler } = fakeSidecar();
    const remote = installFetch(handler);

    mount();

    // Settled on "connected" with an empty queue.
    await waitFor(() => expect(remote.up).toBe(true));

    // --- airplane mode on -------------------------------------------------
    remote.up = false;
    await fireWindowEvent('offline');

    // The capture itself never depends on connectivity: it goes to the sidecar's SQLite,
    // which is reachable either way.
    const queued = await enqueueOutboxItem({ kind: 'position', payload: { lat: 1, lon: 2 } });

    expect(queued.ok).toBe(true);
    expect(store.size).toBe(1);

    // --- airplane mode off ------------------------------------------------
    remote.up = true;
    await fireWindowEvent('online');

    // The whole point. Without an `offline` listener the mode never left "connected", so
    // coming back was not a transition, no drain was scheduled, and this row stayed put.
    await waitFor(() => expect(store.size).toBe(0));
  });

  it('flushes on foreground even when the connection mode never changed', async () => {
    const shell = installNativeShell();
    const { store, handler } = fakeSidecar();
    installFetch(handler);

    mount();

    await waitFor(() => expect(shell.subscribed()).toBe(true));

    // A capture that landed while the app was backgrounded — a background location fix, or
    // one taken during an outage the app slept through. The mode is still "connected" and
    // never transitions, so the mode-driven drain has nothing to react to.
    const queued = await enqueueOutboxItem({ kind: 'position', payload: { lat: 3, lon: 4 } });

    expect(queued.ok).toBe(true);
    expect(store.size).toBe(1);

    await shell.foreground();

    await waitFor(() => expect(store.size).toBe(0));
  });
});
