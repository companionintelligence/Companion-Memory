/**
 * Flush loop for the durable capture outbox (`outbox.ts`).
 *
 * When the app is genuinely reachable to the configured appliance — connection mode
 * `"connected"` — this drains the sidecar's queue oldest-first, POSTing each stored payload
 * onward and reporting every outcome back through `POST /api/outbox/{id}/attempt`. The
 * sidecar, not this module, decides what an outcome means for the row: success deletes it,
 * a transient failure leaves it `pending`, and a permanent (or fifth) failure parks it in
 * `needs_attention`.
 *
 * Scope of this pass: opportunistic, foreground-only. There is no background flush — that
 * needs an Android foreground service, and resumable large-media upload needs its own
 * slice. Both are deliberate follow-ups (see the plugin package README).
 *
 * Three properties this file exists to guarantee:
 *
 * 1. **FIFO.** Items drain in ascending `seq`, the sidecar's monotonic counter — never by
 *    `capturedAt`, which is client wall-clock time and can move backwards.
 * 2. **Serialized.** Exactly one drain runs at a time, process-wide. Two concurrent drains
 *    would flush the same rows twice.
 * 3. **Nothing is lost.** A failed flush reports the failure and stops there; only the
 *    sidecar removes rows, and only on a reported success or an explicit user discard.
 *
 * Delivery is therefore **at-least-once**, deliberately. If the appliance accepts a payload
 * but the follow-up `/attempt` report never lands (the sidecar died in that window), the row
 * survives and is replayed on the next drain. Losing a capture is unacceptable; delivering
 * one twice is recoverable, and the stored `idempotencyKey` gives the appliance the handle
 * it needs to collapse the duplicate.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { useConnectionMode } from './connectionMode';
import { createHookContext } from './createHookContext';
import { FetchJsonError, fetchJson } from './fetchJson';
import {
  getOutboxItem,
  listOutbox,
  recordOutboxAttempt,
  type OutboxCapacity,
  type OutboxItem,
} from './outbox';

/**
 * Where each `kind` is replayed on the appliance. The sidecar treats `kind` as opaque, so
 * routing is a client concern and lives here.
 *
 * Seeded with the ingest routes CI-Server exposes today. A `kind` with no entry is a
 * **permanent** failure — the item lands in `needs_attention` where the user can see it,
 * rather than being retried forever or silently dropped.
 */
const DEFAULT_OUTBOX_ENDPOINTS: Record<string, string> = {
  position: '/api/position',
  event: '/api/v1/events',
  content: '/api/v1/contents',
  communication: '/api/v1/communications',
  inventory: '/api/v1/inventory',
  'browser-activity': '/api/v1/browser-activity',
};

const outboxEndpoints = new Map(Object.entries(DEFAULT_OUTBOX_ENDPOINTS));

/** Register (or override) the appliance endpoint a `kind` flushes to. */
export function registerOutboxKind(kind: string, path: string): void {
  outboxEndpoints.set(kind, path);
}

/** The appliance endpoint for `kind`, or undefined when the kind is unroutable. */
export function outboxEndpointFor(kind: string): string | undefined {
  return outboxEndpoints.get(kind);
}

// A flush is background work competing with whatever the user is doing, so it gets a
// generous but finite bound; a hung upload must not wedge the drain.
const FLUSH_TIMEOUT_MS = 30_000;

/**
 * 4xx statuses that are still worth retrying, so they must NOT be classified permanent:
 * 401/403 clear once the session or API key is repaired, 408/425 are timing, 429 is rate
 * limiting that passes on its own. Everything else in 4xx is the server saying "this
 * request is wrong" — replaying it unchanged will fail identically forever.
 */
const RETRYABLE_CLIENT_STATUSES = new Set([401, 403, 408, 425, 429]);

/**
 * Whether a flush failure will never succeed on retry.
 *
 * Network errors, timeouts and 5xx are transient (`false`) — the appliance may simply be
 * unreachable or briefly unwell. A 4xx outside {@link RETRYABLE_CLIENT_STATUSES} is
 * permanent (`true`): a malformed or rejected payload does not become valid by waiting.
 */
export function isPermanentFlushFailure(err: unknown): boolean {
  if (!(err instanceof FetchJsonError)) {
    return false;
  }

  if (RETRYABLE_CLIENT_STATUSES.has(err.status)) {
    return false;
  }

  return err.status >= 400 && err.status < 500;
}

export interface FlushOutboxOptions {
  /** Aborts the drain between items — e.g. when the connection mode drops. */
  signal?: AbortSignal;
}

export interface FlushOutboxSummary {
  /** Items the drain actually tried to POST onward. */
  attempted: number;
  /** Flushed and removed from the queue. */
  succeeded: number;
  /** Reported as failed (still queued, possibly now `needs_attention`). */
  failed: number;
  /** True when there was no sidecar to drain — nothing was attempted. */
  unavailable: boolean;
  /** True when the drain stopped early because `signal` aborted. */
  aborted: boolean;
}

const EMPTY_SUMMARY: FlushOutboxSummary = {
  attempted: 0,
  succeeded: 0,
  failed: 0,
  unavailable: false,
  aborted: false,
};

let inFlightFlush: Promise<FlushOutboxSummary> | null = null;

/**
 * Drain every `pending` item, oldest-first, one at a time.
 *
 * Calls that arrive while a drain is running join that drain rather than starting a second
 * one (property 2 above) — so the caller-supplied `signal` of a joining call is not honored
 * by the already-running drain, which is the intended trade: one queue, one drainer.
 */
export function flushOutbox(options: FlushOutboxOptions = {}): Promise<FlushOutboxSummary> {
  if (inFlightFlush) {
    return inFlightFlush;
  }

  const run = drain(options).finally(() => {
    inFlightFlush = null;
  });

  inFlightFlush = run;

  return run;
}

async function drain(options: FlushOutboxOptions): Promise<FlushOutboxSummary> {
  const { signal } = options;
  const listing = await listOutbox('pending');

  if (!listing.ok) {
    return { ...EMPTY_SUMMARY, unavailable: listing.reason === 'unavailable' };
  }

  // The sidecar already orders by `seq`; sorting again makes the FIFO guarantee local to
  // this file rather than an assumption about a response we don't control.
  const queue = [...listing.value.items].sort((a, b) => a.seq - b.seq);
  const summary: FlushOutboxSummary = { ...EMPTY_SUMMARY };

  for (const entry of queue) {
    if (signal?.aborted) {
      summary.aborted = true;
      break;
    }

    summary.attempted += 1;

    if (await flushOne(entry)) {
      summary.succeeded += 1;
    } else {
      summary.failed += 1;
    }
  }

  return summary;
}

/** Flush a single item and report the outcome. Resolves true only on a reported success. */
async function flushOne(entry: OutboxItem): Promise<boolean> {
  // List responses omit payloads (they can be large), so fetch the full row now.
  const full = await getOutboxItem(entry.id);

  if (!full.ok) {
    // Nothing was sent onward, so there is no attempt to report: burning one of the item's
    // five attempts on a read we never got to use would push it toward `needs_attention`
    // for a reason that has nothing to do with the appliance. `not_found` in particular is
    // benign — the row was flushed or discarded between the list and here.
    return false;
  }

  const path = outboxEndpointFor(full.value.kind);

  if (!path) {
    await recordOutboxAttempt(entry.id, {
      ok: false,
      error: `No appliance endpoint registered for kind "${full.value.kind}".`,
      permanent: true,
    });

    return false;
  }

  try {
    await fetchJson(path, {
      method: 'POST',
      timeout: FLUSH_TIMEOUT_MS,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(full.value.payload ?? {}),
    });
  } catch (err) {
    await recordOutboxAttempt(entry.id, {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      permanent: isPermanentFlushFailure(err),
    });

    return false;
  }

  // Only now, with the appliance having accepted it, is the row allowed to disappear.
  const acked = await recordOutboxAttempt(entry.id, { ok: true });

  return acked.ok;
}

/** Queue depth as the UI sees it. All zeros with `available: false` when there is no sidecar. */
export interface OutboxQueueState {
  /** False on web / without a sidecar: there is no queue to show at all. */
  available: boolean;
  pending: number;
  needsAttention: number;
  total: number;
  capacity: OutboxCapacity | null;
  /** Re-read the counts (does not trigger a flush). */
  refresh: () => void;
}

const EMPTY_QUEUE = {
  available: false,
  pending: 0,
  needsAttention: 0,
  total: 0,
  capacity: null,
} satisfies Omit<OutboxQueueState, 'refresh'>;

/**
 * Tracks queue depth and drives the flush loop off the connection mode — no timer of its
 * own. Entering `"connected"` starts a drain; leaving it aborts the drain in progress, so
 * a mode that flickers does not leave a doomed flush running against an unreachable server.
 */
function useOutboxQueueState(): OutboxQueueState {
  const { mode } = useConnectionMode();
  const [snapshot, setSnapshot] = useState<Omit<OutboxQueueState, 'refresh'>>(EMPTY_QUEUE);

  // Monotonic request id: overlapping refreshes (a mode change landing while a post-flush
  // refresh is in flight) must not apply out of order.
  const requestIdRef = useRef(0);

  const refresh = useCallback(() => {
    const id = requestIdRef.current + 1;
    requestIdRef.current = id;

    void listOutbox('all').then((result) => {
      if (id !== requestIdRef.current) {
        return;
      }

      if (result.ok) {
        const { counts, capacity } = result.value;

        setSnapshot({
          available: true,
          pending: counts.pending,
          needsAttention: counts.needsAttention,
          total: counts.total,
          capacity,
        });

        return;
      }

      if (result.reason === 'unavailable') {
        setSnapshot(EMPTY_QUEUE);
      }

      // Any other failure (sidecar 5xx, timeout) keeps the last known snapshot: a
      // transient read error is not evidence the queue emptied.
    });
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh, mode]);

  useEffect(() => {
    if (mode !== 'connected') {
      return;
    }

    const controller = new AbortController();

    void flushOutbox({ signal: controller.signal }).then(() => {
      if (!controller.signal.aborted) {
        refresh();
      }
    });

    return () => controller.abort();
  }, [mode, refresh]);

  return { ...snapshot, refresh };
}

const { Provider, useHookContext } = createHookContext(useOutboxQueueState, 'useOutboxQueue');

export { Provider as OutboxQueueProvider, useHookContext as useOutboxQueue };
