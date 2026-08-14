/**
 * The note capture path: `NotePage` → `captureNote` → outbox → `POST /v1/notes`.
 *
 * Covers the three decisions that are easy to regress into something that still *looks*
 * like it works: notes must be routable from a cold flusher, a re-typed note must queue a
 * new snapshot rather than collapse onto the first one, and a drained note must owe no
 * enrichment (it is indexed live by the endpoint, and no backfill sweep can reach it).
 */

import { setApiKey } from '@ci/common/src/utils/apiAuth';
import { setApiBaseUrl } from '@ci/common/src/utils/apiBase';
import {
  buildNoteRecord,
  captureNote,
  forgetQueuedNote,
  isQueuedNote,
  newNoteId,
  rememberQueuedNote,
} from '@ci/common/src/utils/deviceSources/note';
import { type OutboxItem } from '@ci/common/src/utils/outbox';
import {
  NOTE_OUTBOX_KIND,
  finishStagesFor,
  flushOutbox,
  outboxEndpointFor,
} from '@ci/common/src/utils/outboxFlush';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type GlobalWithWindow = { window?: unknown };

const HUB_BASE = 'http://127.0.0.1:4100';
const HUB_TOKEN = 'tok-abc';

function urlOf(input: RequestInfo): string {
  return typeof input === 'string' ? input : (input as Request).url;
}

/** Minimal localStorage, so the remembered-note registry is exercised for real. */
function fakeStorage() {
  const map = new Map<string, string>();

  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => void map.set(key, value),
    removeItem: (key: string) => void map.delete(key),
  };
}

/** Native shell with the LocalHub plugin present. */
function setNativeWindow() {
  (globalThis as GlobalWithWindow).window = {
    Capacitor: {
      isNativePlatform: () => true,
      Plugins: {
        LocalHub: { start: vi.fn(async () => ({ baseUrl: HUB_BASE, token: HUB_TOKEN })) },
      },
    },
    localStorage: fakeStorage(),
  };
}

/** Browser: no Capacitor at all, so no sidecar and no durable queue. */
function setWebWindow() {
  (globalThis as GlobalWithWindow).window = { localStorage: fakeStorage() };
}

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
  body: Record<string, unknown> | undefined;
}

type Handler = (call: RecordedCall) => Response;

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
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      };

      calls.push(call);

      return handler(call);
    }),
  );

  return calls;
}

/** In-memory stand-in for the sidecar's queue — enough for enqueue + drain. */
function fakeSidecar() {
  const store = new Map<string, OutboxItem>();
  const byKey = new Map<string, string>();
  let nextSeq = 1;

  const handler: Handler = (call) => {
    const segments = call.path.split('?')[0].split('/').filter(Boolean);
    const id = segments[2];
    const verb = segments[3];

    if (call.method === 'POST' && !id) {
      const body = call.body as {
        kind: string;
        payload: Record<string, unknown>;
        capturedAt: string;
        idempotencyKey: string;
      };
      const known = byKey.get(body.idempotencyKey);

      if (known) {
        const existing = store.get(known)!;

        return jsonResponse(201, {
          id: existing.id,
          status: 'pending',
          capturedAt: existing.capturedAt,
          seq: existing.seq,
        });
      }

      const created: OutboxItem = {
        id: `row-${nextSeq}`,
        seq: nextSeq,
        kind: body.kind,
        capturedAt: body.capturedAt,
        status: 'pending',
        attempts: 0,
        lastError: null,
        payload: body.payload,
      };

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

    if (call.method === 'GET' && !id) {
      const all = [...store.values()].sort((a, b) => a.seq - b.seq);

      return jsonResponse(200, {
        // List responses deliberately omit payloads, exactly as the sidecar does.
        items: all.map((entry) => {
          const summary = { ...entry };

          delete summary.payload;

          return summary;
        }),
        counts: { pending: all.length, needsAttention: 0, total: all.length },
        capacity: { max: 5000, used: all.length, warnAt: 4000 },
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

function route(sidecar: Handler, appliance: Handler): Handler {
  return (call) => (call.url.startsWith(HUB_BASE) ? sidecar(call) : appliance(call));
}

beforeEach(() => {
  setApiBaseUrl('');
  setApiKey(null);
});

afterEach(() => {
  delete (globalThis as GlobalWithWindow).window;
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('newNoteId', () => {
  it('mints a well-formed v7 uuid carrying the capture time, so ids sort in creation order', () => {
    const at = Date.UTC(2026, 7, 13, 12, 0, 0);
    const id = newNoteId(at);

    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);

    // The leading 48 bits are the millisecond timestamp, big-endian.
    const timestampHex = id.slice(0, 8) + id.slice(9, 13);
    expect(parseInt(timestampHex, 16)).toBe(at);

    // Lexical order therefore matches chronological order — the reason for v7 over v4.
    expect(newNoteId(at) < newNoteId(at + 1000)).toBe(true);
  });

  it('stays correct past 2038, where a 32-bit shift would silently truncate', () => {
    const at = Date.UTC(2050, 0, 1);
    const id = newNoteId(at);

    expect(parseInt(id.slice(0, 8) + id.slice(9, 13), 16)).toBe(at);
  });

  it('does not repeat', () => {
    const ids = new Set(Array.from({ length: 500 }, () => newNoteId()));

    expect(ids.size).toBe(500);
  });
});

describe('note outbox routing', () => {
  it('routes the note kind WITHOUT the capture module having registered anything', async () => {
    // The load-bearing property: a drain can run at app start, before NotePage (a lazily
    // routed page) has ever been imported. If `note` were registered as an import side
    // effect of the capture module, a queued note would be unroutable in that window —
    // and an unroutable kind is a PERMANENT failure straight to `needs_attention`.
    vi.resetModules();

    const cold = await import('@ci/common/src/utils/outboxFlush');

    expect(cold.outboxEndpointFor('note')).toBe('/api/v1/notes');
  });

  it('owes no enrichment stages, overriding the /v1 default of search_index', () => {
    // `/v1/notes` emits a per-row NoteCreatedEvent, so a drained note is indexed live.
    // Asking for search_index would fire a whole-user sweep that cannot reach notes at
    // all — `note` is indexable but is not in the appliance's BACKFILLABLE_ENTITIES.
    expect(finishStagesFor(NOTE_OUTBOX_KIND)).toEqual([]);
    expect(outboxEndpointFor(NOTE_OUTBOX_KIND)).toBe('/api/v1/notes');
  });
});

describe('captureNote', () => {
  it('queues the note under the note kind, as the endpoint envelope, with a client capture time', async () => {
    setNativeWindow();

    const sidecar = fakeSidecar();
    const calls = installFetch(sidecar.handler);

    const record = buildNoteRecord(
      { id: 'note-1', title: 'Groceries', content: '<p>Groceries</p>' },
      Date.UTC(2026, 7, 13, 9, 30),
    );
    const outcome = await captureNote(record);

    expect(outcome.status).toBe('queued');

    const enqueue = calls.find((call) => call.method === 'POST' && call.path === '/api/outbox');

    expect(enqueue?.body).toMatchObject({
      kind: 'note',
      capturedAt: '2026-08-13T09:30:00.000Z',
      // Posted onward verbatim, so the payload IS what /v1/notes receives.
      payload: {
        records: [
          {
            id: 'note-1',
            title: 'Groceries',
            content: '<p>Groceries</p>',
            captured_at: '2026-08-13T09:30:00.000Z',
          },
        ],
      },
    });
  });

  it('queues a SECOND row for a later snapshot of the same note, but collapses an identical retry', async () => {
    // The note keeps being typed after the first autosave. The sidecar cannot rewrite a
    // queued payload, so each snapshot is its own row and the endpoint converges them.
    // A stable per-note idempotency key would freeze the first version and silently drop
    // everything typed afterwards — this test is what catches that.
    setNativeWindow();

    const sidecar = fakeSidecar();

    installFetch(sidecar.handler);

    const first = buildNoteRecord({ id: 'note-1', title: 'G', content: '<p>G</p>' }, 1_000);
    const later = buildNoteRecord({ id: 'note-1', title: 'Gro', content: '<p>Gro</p>' }, 2_000);

    await captureNote(first);
    await captureNote(first); // a retried enqueue of the SAME snapshot
    await captureNote(later);

    const queued = [...sidecar.store.values()].sort((a, b) => a.seq - b.seq);

    expect(queued).toHaveLength(2);
    expect(
      queued.map((entry) => (entry.payload as { records: { content: string }[] }).records[0].content),
    ).toEqual(['<p>G</p>', '<p>Gro</p>']);
  });

  it('remembers the note id so later edits can be recognised as ours', async () => {
    setNativeWindow();

    installFetch(fakeSidecar().handler);

    expect(isQueuedNote('note-1')).toBe(false);

    await captureNote(buildNoteRecord({ id: 'note-1', content: '<p>a</p>' }));

    expect(isQueuedNote('note-1')).toBe(true);

    forgetQueuedNote('note-1');

    expect(isQueuedNote('note-1')).toBe(false);
  });

  it('reports "unavailable" on web instead of pretending, and writes nothing to the network', async () => {
    // There is no honest local substitute for durability in a browser, and the caller has
    // already tried the appliance (that is why it is here) — so a write-through would be a
    // second attempt at the same unreachable server. The UI must say "not saved".
    setWebWindow();

    const calls = installFetch(() => jsonResponse(201, {}));

    const outcome = await captureNote(buildNoteRecord({ id: 'note-1', content: '<p>a</p>' }));

    expect(outcome.status).toBe('unavailable');
    expect(calls).toHaveLength(0);
    expect(isQueuedNote('note-1')).toBe(false);
  });

  it('reports "failed" when the sidecar exists and refuses — never a silent success', async () => {
    setNativeWindow();

    installFetch(
      route(
        () => jsonResponse(507, { error: 'queue_full' }),
        () => jsonResponse(201, {}),
      ),
    );

    const outcome = await captureNote(buildNoteRecord({ id: 'note-1', content: '<p>a</p>' }));

    expect(outcome.status).toBe('failed');
    expect(isQueuedNote('note-1')).toBe(false);
  });
});

describe('draining a queued note', () => {
  it('POSTs the stored envelope to /api/v1/notes and removes the row on success', async () => {
    setNativeWindow();

    const sidecar = fakeSidecar();
    const calls = installFetch(
      route(sidecar.handler, () => jsonResponse(200, { ingested: 1, duplicate: 0 })),
    );

    await captureNote(
      buildNoteRecord({ id: 'note-1', title: 'G', content: '<p>G</p>' }, Date.UTC(2026, 7, 13, 9, 30)),
    );

    const summary = await flushOutbox();

    expect(summary).toMatchObject({ attempted: 1, succeeded: 1, failed: 0 });

    const delivered = calls.find((call) => call.path === '/api/v1/notes');

    expect(delivered?.method).toBe('POST');
    expect(delivered?.body).toEqual({
      records: [
        {
          id: 'note-1',
          title: 'G',
          content: '<p>G</p>',
          captured_at: '2026-08-13T09:30:00.000Z',
        },
      ],
    });

    // Reported success, so the sidecar dropped the row — the note is on the appliance.
    expect(sidecar.store.size).toBe(0);

    // And nothing was owed to the enrichment orchestrator.
    expect(calls.some((call) => call.path.includes('/ingest/finish'))).toBe(false);
  });

  it('keeps the note queued when the appliance refuses it', async () => {
    setNativeWindow();

    const sidecar = fakeSidecar();

    installFetch(route(sidecar.handler, () => jsonResponse(503, { error: 'unavailable' })));

    await captureNote(buildNoteRecord({ id: 'note-1', content: '<p>a</p>' }));

    const summary = await flushOutbox();

    expect(summary).toMatchObject({ attempted: 1, succeeded: 0, failed: 1 });
    // Nothing is lost on a failed flush: only the sidecar removes rows, and only on a
    // reported success.
    expect(sidecar.store.size).toBe(1);
  });
});

describe('remembered-note registry', () => {
  it('bounds itself, dropping the oldest ids first', () => {
    setNativeWindow();

    for (let index = 0; index < 205; index += 1) {
      rememberQueuedNote(`note-${index}`);
    }

    expect(isQueuedNote('note-0')).toBe(false);
    expect(isQueuedNote('note-4')).toBe(false);
    expect(isQueuedNote('note-5')).toBe(true);
    expect(isQueuedNote('note-204')).toBe(true);
  });

  it('survives an unusable localStorage without throwing inside a save path', async () => {
    (globalThis as GlobalWithWindow).window = {
      Capacitor: {
        isNativePlatform: () => true,
        Plugins: {
          LocalHub: { start: vi.fn(async () => ({ baseUrl: HUB_BASE, token: HUB_TOKEN })) },
        },
      },
      localStorage: {
        getItem: () => {
          throw new Error('private mode');
        },
        setItem: () => {
          throw new Error('private mode');
        },
      },
    };

    installFetch(fakeSidecar().handler);

    // The note is still durably queued; only the ability to queue LATER edits is lost.
    await expect(captureNote(buildNoteRecord({ id: 'note-1', content: '<p>a</p>' }))).resolves.toMatchObject({
      status: 'queued',
    });
    expect(isQueuedNote('note-1')).toBe(false);
  });
});
