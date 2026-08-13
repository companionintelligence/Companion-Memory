/**
 * Client for the Local Hub sidecar's **durable capture outbox**.
 *
 * The sidecar (`frontend/packages/capacitor-local-hub`) owns a real on-disk SQLite queue in
 * app-private internal storage: a capture written through here is committed to disk before
 * the call resolves, and survives force-quit and reboot. This module is the TypeScript half
 * of that HTTP contract — it does not itself persist anything.
 *
 * Wire contract (all routes bearer-authenticated with the sidecar's per-launch token):
 *
 * | Route                          | Meaning                                                |
 * | ------------------------------ | ------------------------------------------------------ |
 * | `POST   /api/outbox`           | enqueue one item; 201 with `{id,status,capturedAt,seq}` |
 * | `GET    /api/outbox`           | list oldest-first, plus `counts` and `capacity`         |
 * | `GET    /api/outbox/{id}`      | one item, including its `payload`                       |
 * | `DELETE /api/outbox/{id}`      | drop one item (flushed, or user-discarded); 204         |
 * | `POST   /api/outbox/{id}/attempt` | record a flush outcome                              |
 * | `POST   /api/outbox/{id}/retry`   | move `needs_attention` back to `pending`            |
 *
 * ## Degradation on web (no sidecar) — the load-bearing design decision
 *
 * There is no sidecar in a browser, and there is no honest local substitute for "this write
 * is durable". So every function here returns an explicit {@link OutboxResult} rather than
 * throwing or resolving to something success-shaped: on web (and on native when the plugin
 * is missing or the server won't start) they resolve
 * `{ ok: false, reason: 'unavailable' }`.
 *
 * A caller must never conclude a capture was durably queued when it was not — silently
 * pretending success is precisely the failure this whole feature exists to prevent. Callers
 * are expected to branch on `ok` and, when it is false, either write through to the network
 * directly or tell the user the capture was not saved.
 *
 * ## Nothing is ever discarded silently
 *
 * Every terminal state is visible: either an explicit `DELETE` (a successful flush, or a
 * deliberate user discard) or a `needs_attention` row the user can see and retry. At the
 * hard cap the sidecar answers `507` and {@link enqueueOutboxItem} surfaces
 * `reason: 'full'` — user data is never evicted to make room. Callers watching the
 * `capacity` block on {@link listOutbox} can warn before hitting that wall.
 */

import { FetchJsonError, fetchJson } from './fetchJson';
import { localHubHeaders, localHubSession } from './localHub';

/**
 * Hard cap on queued items. Mirrors the sidecar's own constant; the sidecar is the
 * authority (it is what returns 507), and the live numbers always come back in the
 * `capacity` block of {@link listOutbox}. Exported so UI can reason about pressure
 * before a list round-trip.
 */
export const OUTBOX_MAX_ITEMS = 5000;

/** Queue depth at which callers should start warning the user — 80% of the cap. */
export const OUTBOX_WARN_AT = Math.floor(OUTBOX_MAX_ITEMS * 0.8);

/** Failed attempts before an item is parked in `needs_attention`. Mirrors the sidecar. */
export const OUTBOX_MAX_ATTEMPTS = 5;

const OUTBOX_PATH = '/api/outbox';

// The sidecar is a loopback server doing a local SQLite write, so a slow response means
// something is wrong rather than "the network is far away". Bounded well under the
// perceptible-hang threshold so a wedged sidecar can't freeze a capture.
const OUTBOX_TIMEOUT_MS = 5_000;

/** `pending` — awaiting flush. `needs_attention` — flushing gave up; needs the user. */
export type OutboxStatus = 'pending' | 'needs_attention';

/** Filter accepted by {@link listOutbox}. */
export type OutboxStatusFilter = OutboxStatus | 'all';

export interface OutboxItem {
  id: string;
  /** Opaque to the sidecar; the flusher maps it to an appliance endpoint. */
  kind: string;
  /** ISO-8601 **client** time at capture — never server time. */
  capturedAt: string;
  /** Monotonic autoincrement. FIFO order, immune to the wall clock moving backwards. */
  seq: number;
  status: OutboxStatus;
  attempts: number;
  lastError: string | null;
  /**
   * Present only on {@link getOutboxItem} — list responses deliberately omit payloads,
   * which can be large.
   */
  payload?: Record<string, unknown>;
}

/** Counts across the whole queue, regardless of the `status` filter used. */
export interface OutboxCounts {
  pending: number;
  needsAttention: number;
  total: number;
}

/** Live capacity, so callers can surface pressure before an enqueue is refused. */
export interface OutboxCapacity {
  max: number;
  used: number;
  warnAt: number;
}

export interface OutboxListing {
  /** Oldest-first (ascending `seq`). */
  items: OutboxItem[];
  counts: OutboxCounts;
  capacity: OutboxCapacity;
}

/** 201 body of a successful enqueue. */
export interface OutboxEnqueueAck {
  id: string;
  status: 'pending';
  capturedAt: string;
  seq: number;
}

export interface OutboxEnqueueInput {
  /** e.g. `'note'`, `'position'`. Opaque to the sidecar; see `outboxFlush.ts` for routing. */
  kind: string;
  /** Opaque JSON the flusher will POST onward, verbatim. */
  payload: Record<string, unknown>;
  /** ISO-8601 client capture time. Defaults to now — pass it explicitly when the capture
   *  happened earlier than the enqueue (e.g. a queued photo finishing encode). */
  capturedAt?: string;
  /**
   * Client-generated de-duplication key. Re-POSTing the same key returns the existing row
   * instead of creating a second one. Defaults to a fresh UUID; pass a **stable** key when
   * the caller may retry the enqueue itself, or the retry will queue a duplicate capture.
   */
  idempotencyKey?: string;
}

/** Outcome reported back to the sidecar after a flush attempt. */
export type OutboxAttemptOutcome =
  | { ok: true }
  | {
      ok: false;
      error: string;
      /** True for a rejection that will never succeed on retry (a 4xx-class refusal). */
      permanent: boolean;
    };

/**
 * Why an outbox call did not succeed.
 *
 * - `unavailable` — there is no sidecar to talk to: web, plugin not installed, or the
 *   server would not start. **Nothing was queued.**
 * - `full` — the queue is at its hard cap (507). Nothing was queued and nothing was
 *   evicted; the user must flush or discard first.
 * - `not_found` — no such item (404). Usually benign: it was already flushed or discarded.
 * - `error` — anything else (sidecar 5xx, malformed body, timeout).
 */
export type OutboxFailureReason = 'unavailable' | 'full' | 'not_found' | 'error';

export type OutboxResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: OutboxFailureReason; message: string };

const UNAVAILABLE = {
  ok: false,
  reason: 'unavailable',
  message: 'No Local Hub sidecar on this platform — nothing was queued.',
} as const;

function failure<T>(reason: OutboxFailureReason, message: string): OutboxResult<T> {
  return { ok: false, reason, message };
}

/** Maps a thrown error onto a {@link OutboxFailureReason}. */
function classify(err: unknown): { reason: OutboxFailureReason; message: string } {
  const message = err instanceof Error ? err.message : String(err);

  if (err instanceof FetchJsonError) {
    if (err.status === 507) {
      return { reason: 'full', message };
    }

    if (err.status === 404) {
      return { reason: 'not_found', message };
    }
  }

  return { reason: 'error', message };
}

/**
 * One authenticated round-trip to the sidecar. Resolves the session per call (see
 * `localHub.ts` on why that isn't cached) and never throws — every failure comes back as a
 * typed {@link OutboxResult}.
 *
 * `skipApiKey` matters: `fetchJson` otherwise attaches the appliance's `x-api-key`, which
 * both leaks that credential to a different server and adds a header the sidecar's CORS
 * policy does not allowlist — the WebView would fail the preflight and the request would
 * never be sent.
 */
async function callOutbox<T>(
  path: string,
  init: { method: string; body?: unknown },
): Promise<OutboxResult<T | undefined>> {
  const session = await localHubSession();

  if (!session) {
    return UNAVAILABLE;
  }

  const hasBody = init.body !== undefined;

  try {
    const value = await fetchJson<T>(`${session.baseUrl}${path}`, {
      method: init.method,
      timeout: OUTBOX_TIMEOUT_MS,
      skipApiKey: true,
      headers: {
        ...localHubHeaders(session),
        ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(hasBody ? { body: JSON.stringify(init.body) } : {}),
    });

    return { ok: true, value };
  } catch (err) {
    const { reason, message } = classify(err);

    return failure(reason, message);
  }
}

/** Narrows a `T | undefined` body to `T`, turning an empty body into an `error` result. */
function requireBody<T>(result: OutboxResult<T | undefined>, what: string): OutboxResult<T> {
  if (!result.ok) {
    return result;
  }

  if (result.value == null) {
    return failure('error', `Local Hub returned an empty body for ${what}.`);
  }

  return { ok: true, value: result.value };
}

/** UUID for the default idempotency key, with a fallback for runtimes without WebCrypto. */
function newIdempotencyKey(): string {
  const webCrypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;

  if (typeof webCrypto?.randomUUID === 'function') {
    return webCrypto.randomUUID();
  }

  // Not a real UUID and not required to be one — the sidecar treats the key as an opaque
  // unique string. Only reached on platforms without `crypto.randomUUID`.
  return `ci-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * Durably queue one capture. Resolves only after the sidecar has committed the row to
 * disk, so `ok: true` genuinely means "this survives a reboot".
 *
 * Re-calling with the same `idempotencyKey` returns the existing row rather than queueing
 * a duplicate.
 */
export async function enqueueOutboxItem(input: OutboxEnqueueInput): Promise<OutboxResult<OutboxEnqueueAck>> {
  const body = {
    kind: input.kind,
    payload: input.payload,
    capturedAt: input.capturedAt ?? new Date().toISOString(),
    idempotencyKey: input.idempotencyKey ?? newIdempotencyKey(),
  };

  return requireBody(await callOutbox<OutboxEnqueueAck>(OUTBOX_PATH, { method: 'POST', body }), 'enqueue');
}

/** List queued items oldest-first, with queue-wide `counts` and `capacity`. */
export async function listOutbox(status: OutboxStatusFilter = 'all'): Promise<OutboxResult<OutboxListing>> {
  const query = status === 'all' ? '' : `?status=${encodeURIComponent(status)}`;

  return requireBody(await callOutbox<OutboxListing>(`${OUTBOX_PATH}${query}`, { method: 'GET' }), 'list');
}

/** One item **including its payload** — the only route that returns it. */
export async function getOutboxItem(id: string): Promise<OutboxResult<OutboxItem>> {
  return requireBody(
    await callOutbox<OutboxItem>(`${OUTBOX_PATH}/${encodeURIComponent(id)}`, { method: 'GET' }),
    'item',
  );
}

/**
 * Remove one item. Used after a successful flush and for a deliberate user discard — the
 * two legitimate ways data leaves the queue. `not_found` means it was already gone.
 */
export async function removeOutboxItem(id: string): Promise<OutboxResult<void>> {
  const result = await callOutbox<never>(`${OUTBOX_PATH}/${encodeURIComponent(id)}`, { method: 'DELETE' });

  return result.ok ? { ok: true, value: undefined } : result;
}

/**
 * Report the outcome of a flush attempt.
 *
 * `{ ok: true }` deletes the item (204, so the result carries `null`). `{ ok: false }`
 * increments `attempts` and stores `lastError`; the item lands in `needs_attention` when
 * the failure is `permanent` or `attempts` reaches {@link OUTBOX_MAX_ATTEMPTS}, and
 * otherwise stays `pending` for the next drain. Either way it is **never** deleted — a
 * failed flush must not lose the capture.
 */
export async function recordOutboxAttempt(
  id: string,
  outcome: OutboxAttemptOutcome,
): Promise<OutboxResult<OutboxItem | null>> {
  const result = await callOutbox<OutboxItem>(`${OUTBOX_PATH}/${encodeURIComponent(id)}/attempt`, {
    method: 'POST',
    body: outcome,
  });

  if (!result.ok) {
    return result;
  }

  // Success reports answer 204 (the row is gone); failure reports answer 200 with the row.
  return { ok: true, value: result.value ?? null };
}

/** Move a `needs_attention` item back to `pending` and reset its attempt counter. */
export async function retryOutboxItem(id: string): Promise<OutboxResult<OutboxItem>> {
  return requireBody(
    await callOutbox<OutboxItem>(`${OUTBOX_PATH}/${encodeURIComponent(id)}/retry`, { method: 'POST' }),
    'retry',
  );
}
