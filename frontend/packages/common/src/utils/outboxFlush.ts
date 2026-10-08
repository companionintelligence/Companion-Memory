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
 *    sidecar removes rows, and only on a reported success, an explicit user discard, or a
 *    sign-out the person agreed to (see {@link countUnsentBeforeSignOut} and
 *    {@link clearOutboxAfterSignOut}).
 * 4. **Nothing changes hands.** A row goes out only under the session it was queued for
 *    (`owner`, see `outboxOwnerStamp`). One stamped for another account or server is left
 *    where it is, untouched, rather than sent with the key that happens to be active.
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
import { addAppStateListener } from './nativeBridge';
import {
  clearOutbox,
  getOutboxItem,
  listOutbox,
  outboxOwnerStamp,
  recordOutboxAttempt,
  type OutboxCapacity,
  type OutboxItem,
} from './outbox';

/**
 * The `kind` device-native location fixes are queued under. Routes to `/v1/positions`,
 * **not** the older `/api/position` below — see {@link DEFAULT_OUTBOX_ROUTES}.
 */
export const POSITION_OUTBOX_KIND = 'positions';

/**
 * The `kind` user-authored notes are queued under. Routes to `/v1/notes`.
 *
 * Registered **statically** in {@link DEFAULT_OUTBOX_ROUTES} rather than through
 * {@link registerOutboxKind} at the capture site's module scope, and that is
 * load-bearing rather than stylistic: a drain can run before anything that
 * creates notes has been imported — the foreground-resume trigger fires from
 * the queue provider, which mounts at app root, while `NotePage` is a lazily
 * routed page the user may never open in a given session. A kind registered
 * only as a side effect of importing its capture module would be unroutable in
 * exactly that window, and an unroutable kind is a PERMANENT failure: the note
 * would be parked in `needs_attention` on the first drain after a restart.
 */
export const NOTE_OUTBOX_KIND = 'note';

/** Where a `kind` is replayed, and what it owes `POST /v1/ingest/finish` afterwards. */
interface OutboxRoute {
  path: string;
  /**
   * Enrichment legs this kind's rows need once materialized. Omitted for `/v1` kinds means
   * {@link DEFAULT_V1_FINISH_STAGES}; omitted for non-`/v1` kinds means nothing is owed.
   */
  finishStages?: readonly string[];
}

/**
 * Positions need the GPS reverse leg (`reverse_position` — pipeline
 * PositionReverseStage writing address onto `ci.position`) and
 * `estimate_locations` so other timeline entities inherit a place from the
 * surrounding fixes. Event `reverse_geocode` does not name GPS rows.
 * Search indexing of named, downsampled positions is the server coalesce
 * `search_index` leg, not this client finish list.
 */
const POSITION_FINISH_STAGES = ['reverse_position', 'estimate_locations'] as const;

/** Every other `/v1` kind materializes searchable rows with no per-row indexing fan-out. */
const DEFAULT_V1_FINISH_STAGES = ['search_index'] as const;

/**
 * Where each `kind` is replayed on the appliance. The sidecar treats `kind` as opaque, so
 * routing is a client concern and lives here.
 *
 * Seeded with the ingest routes CI-Server exposes today. A `kind` with no entry is a
 * **permanent** failure — the item lands in `needs_attention` where the user can see it,
 * rather than being retried forever or silently dropped.
 *
 * `position` (singular, `/api/position`) is the pre-`/v1` route and is kept only so
 * anything already queued under that kind still drains. **New captures use
 * {@link POSITION_OUTBOX_KIND}**: `/api/position` gets the 100kb default body limit
 * (`BodyParserMiddleware` widens to 10mb only under `/v1`, and it runs before routing so
 * there is no per-route escape), and it bypasses the capture log, which is the only place
 * positions are deduped on their provenance triple.
 */
const DEFAULT_OUTBOX_ROUTES: Record<string, OutboxRoute> = {
  position: { path: '/api/position' },
  [POSITION_OUTBOX_KIND]: { path: '/api/v1/positions', finishStages: POSITION_FINISH_STAGES },
  event: { path: '/api/v1/events' },
  content: { path: '/api/v1/contents' },
  // Explicitly nothing owed, overriding the `/v1` default of `search_index`.
  // `/v1/notes` emits a per-row NoteCreatedEvent (it replays interactive
  // captures, not an import), so a drained note is indexed live and the finish
  // legs have nothing left to do. Asking for `search_index` anyway would fire a
  // whole-user maintenance sweep that cannot even reach notes — `note` is in
  // INDEXABLE_ENTITIES but not in the appliance's BACKFILLABLE_ENTITIES.
  [NOTE_OUTBOX_KIND]: { path: '/api/v1/notes', finishStages: [] },
  communication: { path: '/api/v1/communications' },
  thing: { path: '/api/v1/things' },
  // The kind the retired inventory feature enqueued under. Kept because a
  // device's local outbox can still hold rows written by an older build; they
  // flush to the same endpoint the new kind does. Removable once no shipped
  // client can still be holding one.
  inventory: { path: '/api/v1/things' },
  'browser-activity': { path: '/api/v1/browser-activity' },
};

const outboxRoutes = new Map(Object.entries(DEFAULT_OUTBOX_ROUTES));

/**
 * Register (or override) the appliance endpoint a `kind` flushes to.
 *
 * `finishStages` names the enrichment legs the kind's rows need after a drain; leave it
 * unset to take the default for the path (see {@link DEFAULT_OUTBOX_ROUTES}).
 */
export function registerOutboxKind(
  kind: string,
  path: string,
  options: { finishStages?: readonly string[] } = {},
): void {
  outboxRoutes.set(kind, { path, ...(options.finishStages ? { finishStages: options.finishStages } : {}) });
}

/** The appliance endpoint for `kind`, or undefined when the kind is unroutable. */
export function outboxEndpointFor(kind: string): string | undefined {
  return outboxRoutes.get(kind)?.path;
}

/**
 * The enrichment legs `kind` owes `POST /v1/ingest/finish`, or an empty list when it owes
 * nothing (an unknown kind, or a legacy route that still emits per-row events itself).
 */
export function finishStagesFor(kind: string): readonly string[] {
  const route = outboxRoutes.get(kind);

  if (!route) {
    return [];
  }

  if (route.finishStages) {
    return route.finishStages;
  }

  return route.path.startsWith(`${INGEST_PREFIX}/`) ? DEFAULT_V1_FINISH_STAGES : [];
}

// A flush is background work competing with whatever the user is doing, so it gets a
// generous but finite bound; a hung upload must not wedge the drain.
const FLUSH_TIMEOUT_MS = 30_000;

// ---------------------------------------------------------------------------
// POST /v1/ingest/finish — closing the deferred-indexing loop
// ---------------------------------------------------------------------------

/** Path prefix of the appliance's machine-ingest plane. */
const INGEST_PREFIX = '/api/v1';

/**
 * Every `/v1` bulk endpoint materializes with `emitCreated: false` — no per-row
 * `*CreatedEvent`, therefore **no search indexing and no enrichment** — and hands that
 * responsibility to the client. Without this call the appliance holds the rows and shows
 * the user nothing: a location fix is written but never reverse-geocoded, and never feeds
 * the location estimates that place the rest of the timeline.
 */
export const INGEST_FINISH_PATH = `${INGEST_PREFIX}/ingest/finish`;

/**
 * `ORCHESTRATE_STAGES`, mirrored. The appliance runs a named subset in *this* canonical
 * order regardless of the order we send, so this exists purely to make the request
 * deterministic (and therefore assertable) rather than dependent on Set iteration order.
 */
const INGEST_FINISH_STAGE_ORDER = [
  'extract_people',
  'link_communications',
  'link_events',
  'materialize_edges',
  'normalize_relationships',
  'derive_relationships',
  'fold_notes',
  'extract_graph',
  'geocode',
  'reverse_geocode',
  'reverse_position',
  'reverse_object',
  'estimate_locations',
  'media_dimensions',
  'search_index',
] as const;

/**
 * Floor between finishes. Each leg is a backfill sweep, and the orchestrator serializes to
 * one run per user (a second is a 409), so firing per capture on the web path — where every
 * fix POSTs individually — would be pure waste.
 */
export const INGEST_FINISH_MIN_INTERVAL_MS = 60_000;

/**
 * Stages owed because rows landed that nothing has enriched yet.
 *
 * Kept as debt rather than fired-and-forgotten: a finish that fails (offline, or a 409 from
 * a concurrent orchestration) leaves the stages owed, so the next drain retries them even
 * if that drain flushes nothing at all. Without that, a drain which succeeded and *then*
 * lost the connection would strand its rows unindexed with nothing left to trigger a retry.
 *
 * The debt is in-memory, so a process death between a successful flush and a successful
 * finish defers indexing until the next successful `/v1` flush. Bounded and acceptable;
 * persisting it would mean a sidecar schema change for a loss window measured in one drain.
 */
const owedFinishStages = new Set<string>();

let lastFinishAtMs = 0;

/** Note that `stages` are now owed. Idempotent; unknown stage names are ignored. */
export function oweIngestFinish(stages: readonly string[]): void {
  for (const stage of stages) {
    owedFinishStages.add(stage);
  }
}

/**
 * Run the owed enrichment legs, if any and if the debounce window has passed.
 *
 * Resolves `true` when nothing is owed or the finish succeeded; `false` when it was
 * debounced or failed — in both of those the debt stands and a later call retries it. A
 * failure here is never fatal: the records are already safely on the appliance, and the
 * drain that put them there has already reported its own success.
 */
export async function settleIngestFinish(options: { force?: boolean } = {}): Promise<boolean> {
  if (owedFinishStages.size === 0) {
    return true;
  }

  const now = Date.now();

  if (!options.force && now - lastFinishAtMs < INGEST_FINISH_MIN_INTERVAL_MS) {
    return false;
  }

  const known = INGEST_FINISH_STAGE_ORDER.filter((stage) => owedFinishStages.has(stage));
  // A runtime-registered kind may name a stage this mirror predates; send it too rather
  // than silently dropping it, since the appliance is the authority on the vocabulary.
  const extra = [...owedFinishStages].filter(
    (stage) => !(INGEST_FINISH_STAGE_ORDER as readonly string[]).includes(stage),
  );
  const stages = [...known, ...extra];

  try {
    await fetchJson(INGEST_FINISH_PATH, {
      method: 'POST',
      timeout: FLUSH_TIMEOUT_MS,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stages }),
    });
  } catch {
    return false;
  }

  lastFinishAtMs = now;
  owedFinishStages.clear();

  return true;
}

/**
 * Drop the owed stages and the debounce clock.
 *
 * Called on sign-out (`useAuth`'s logout, through {@link clearOutboxAfterSignOut} on the
 * phone apps) — enrichment debt belongs to the account that incurred it, and firing it
 * against the next session would run a maintenance sweep for the wrong user. Tests use it
 * to isolate, for the same reason.
 */
export function resetIngestFinishState(): void {
  owedFinishStages.clear();
  lastFinishAtMs = 0;
}

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
  /**
   * Report a failure that can pass on its own (offline, a timeout, a 5xx) to the sidecar,
   * which spends one of the row's five attempts on it. Default true. Sign-out's
   * last drain passes false: it runs whatever the connection, and a sign-out the person then
   * cancels must leave each row as it was, not one step nearer `needs_attention`. A permanent
   * failure is reported either way.
   */
  recordTransientFailures?: boolean;
}

export interface FlushOutboxSummary {
  /** Items the drain actually tried to POST onward. */
  attempted: number;
  /** Items left alone because they were queued for another account or server, or nobody is signed in. */
  skipped: number;
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
  skipped: 0,
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
  const { signal, recordTransientFailures = true } = options;
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

    // Checked on the list row first, so a row that is not ours never has its payload read.
    if (!sendableNow(entry.owner)) {
      summary.skipped += 1;
      continue;
    }

    const outcome = await flushOne(entry, recordTransientFailures);

    if (outcome === 'skipped') {
      summary.skipped += 1;
      continue;
    }

    summary.attempted += 1;

    if (outcome === 'sent') {
      summary.succeeded += 1;
    } else {
      summary.failed += 1;
    }
  }

  // Deliberately outside the `succeeded > 0` test: the debt may be left over from an
  // earlier drain whose finish failed, and a drain that flushes nothing is exactly the
  // moment that debt would otherwise never be retried. Failure is not propagated — the
  // records are already on the appliance and the per-item outcomes are already reported.
  await settleIngestFinish();

  return summary;
}

/**
 * Whether a row stamped `owner` may go out under the session that is signed in right now.
 *
 * Nothing goes out with nobody signed in. A row with no stamp was queued by a build that
 * predates stamping; it drains under the current session, as every row did before.
 */
function sendableNow(owner: string | null | undefined): boolean {
  return sendableUnder(owner, outboxOwnerStamp());
}

/** {@link sendableNow} against a stamp the caller already has. */
function sendableUnder(owner: string | null | undefined, current: string | null): boolean {
  if (!current) {
    return false;
  }

  return owner == null || owner === current;
}

/**
 * Flush a single item. `sent` only on a reported success; `skipped` when the row turned out
 * not to belong to the current session, in which case nothing was sent or recorded.
 * `recordTransientFailures` is {@link FlushOutboxOptions.recordTransientFailures}.
 */
async function flushOne(
  entry: OutboxItem,
  recordTransientFailures: boolean,
): Promise<'sent' | 'failed' | 'skipped'> {
  // List responses omit payloads (they can be large), so fetch the full row now.
  const full = await getOutboxItem(entry.id);

  if (!full.ok) {
    // Nothing was sent onward, so there is no attempt to report: burning one of the item's
    // five attempts on a read we never got to use would push it toward `needs_attention`
    // for a reason that has nothing to do with the appliance. `not_found` in particular is
    // benign — the row was flushed or discarded between the list and here.
    return 'failed';
  }

  const path = outboxEndpointFor(full.value.kind);

  // Again here, with nothing awaited between this check and the request: the session can
  // change while the row is read (sign-out, a re-pair), and fetchJson takes the key and the
  // origin at the moment it is called.
  if (!sendableNow(full.value.owner)) {
    return 'skipped';
  }

  if (!path) {
    await recordOutboxAttempt(entry.id, {
      ok: false,
      error: `No appliance endpoint registered for kind "${full.value.kind}".`,
      permanent: true,
    });

    return 'failed';
  }

  const sentUnder = outboxOwnerStamp();

  try {
    await fetchJson(path, {
      method: 'POST',
      timeout: FLUSH_TIMEOUT_MS,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(full.value.payload ?? {}),
    });
  } catch (err) {
    const permanent = isPermanentFlushFailure(err);

    if (permanent || recordTransientFailures) {
      await recordOutboxAttempt(entry.id, {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        permanent,
      });
    }

    return 'failed';
  }

  // The rows exist on the appliance now, un-enriched and un-indexed. Record the debt
  // before reporting success, so it survives even if the `/attempt` report below fails.
  // Only while the session that sent them is still the one signed in: sign-out can land
  // while this request is in flight, and debt recorded after its reset would be settled
  // under the next account's key.
  if (outboxOwnerStamp() === sentUnder) {
    oweIngestFinish(finishStagesFor(full.value.kind));
  }

  // Only now, with the appliance having accepted it, is the row allowed to disappear.
  const acked = await recordOutboxAttempt(entry.id, { ok: true });

  return acked.ok ? 'sent' : 'failed';
}

/** How long sign-out waits on its last drain before it signs out anyway. */
export const SIGN_OUT_DRAIN_TIMEOUT_MS = 5_000;

/**
 * Sign-out, step one, while the outgoing account's key is still the active one: one last
 * bounded drain of what that account queued, then the enrichment it owes.
 *
 * Bounded because sign-out must not hang on an unreachable appliance. Whatever has not gone
 * by the deadline is counted by {@link countUnsentBeforeSignOut}, so the person can choose
 * to stay signed in, and deleted by {@link clearOutboxAfterSignOut} only if they sign out.
 * The drain itself is aborted between items, and any item still in flight was already sent
 * with this account's key, to this account's server.
 *
 * It runs whether or not the appliance is reachable, so a failure that can pass on its own
 * is not reported (see {@link FlushOutboxOptions.recordTransientFailures}): someone who
 * tries to sign out offline and then cancels keeps every row with the attempts it had.
 */
export async function drainOutboxBeforeSignOut(timeoutMs = SIGN_OUT_DRAIN_TIMEOUT_MS): Promise<void> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;

  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve();
    }, timeoutMs);
  });

  const work = (async () => {
    const summary = await flushOutbox({ signal: controller.signal, recordTransientFailures: false });

    if (!summary.unavailable && !controller.signal.aborted) {
      await settleIngestFinish({ force: true });
    }
  })().catch(() => {
    // Best effort: sign-out goes ahead either way.
  });

  try {
    await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Sign-out, step two, after the last drain and while the key is still active: how many
 * captures signing out now would delete before they ever reached this account. That is
 * every row this session is the one to send, waiting or needing attention: stamped for it,
 * or unstamped from a build that predates stamping. Rows queued for another account or
 * server are left out, since nothing this session does can send them.
 *
 * Zero when nobody is signed in, and when there is no queue to read (web, or a sidecar
 * that does not answer): sign-out then goes ahead as it would with an empty queue.
 */
export async function countUnsentBeforeSignOut(): Promise<number> {
  const listing = await listOutbox('all');

  if (!listing.ok) {
    return 0;
  }

  const current = outboxOwnerStamp();

  return listing.value.items.filter((entry) => sendableUnder(entry.owner, current)).length;
}

/**
 * Called when rows leave the queue other than through a drain, so a mounted
 * {@link OutboxQueueProvider} re-reads its counts instead of showing the old ones.
 */
const queueClearedListeners = new Set<() => void>();

/**
 * Sign-out, step three, after the key is dropped: delete every queued row and forget the
 * enrichment debt. Rows still here belong to the account that just left (the person has
 * agreed to lose this account's unsent ones), and the next person to sign in on this
 * phone must not inherit them.
 *
 * The queue provider sits above the auth provider and refreshes only on a mode change, a
 * drain or a resume. Without the notice below, the next account's screen kept showing the
 * departed account's pending count until one of those happened.
 */
export async function clearOutboxAfterSignOut(): Promise<void> {
  resetIngestFinishState();
  await clearOutbox();

  for (const listener of queueClearedListeners) {
    listener();
  }
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
 * Tracks queue depth and drives the flush loop off two signals — no timer of its own.
 *
 * 1. **Entering `"connected"`.** Leaving it aborts the drain in progress, so a mode that
 *    flickers does not leave a doomed flush running against an unreachable server.
 * 2. **Returning to the foreground.** A mode transition alone is not enough: the app is not
 *    probing while backgrounded, so it can leave and return on the same mode with a queue
 *    that grew in between (a background location fix, or a capture taken during an outage
 *    the app slept through). Resume therefore re-probes *and* drains on its own.
 */
function useOutboxQueueState(): OutboxQueueState {
  const { mode, refresh: refreshConnectionMode } = useConnectionMode();
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
    queueClearedListeners.add(refresh);

    return () => {
      queueClearedListeners.delete(refresh);
    };
  }, [refresh]);

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

  // Read through a ref so resuming does not need to re-subscribe on every mode change —
  // the listener is registered once and always sees the current mode.
  const modeRef = useRef(mode);
  modeRef.current = mode;

  useEffect(() => {
    let disposed = false;
    let unsubscribe: () => void = () => {};

    void addAppStateListener((isActive) => {
      if (!isActive || disposed) {
        return;
      }

      // The OS does not deliver `online`/`offline` to a suspended WebView, so the mode may
      // describe the network as it was before the app went away. Re-probe first; if that
      // lands on a different mode the effect above drains, and this drain is a no-op
      // because `flushOutbox` joins the one already running.
      refreshConnectionMode();

      if (modeRef.current !== 'connected') {
        return;
      }

      // Deliberately unaborted, unlike the mode-driven drain: a resume carries no "the
      // connection just went away" signal to honor, and tearing down here would cancel a
      // healthy drain every time the app came forward.
      void flushOutbox().then(() => {
        if (!disposed) {
          refresh();
        }
      });
    }).then((off) => {
      if (disposed) {
        off();

        return;
      }

      unsubscribe = off;
    });

    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [refresh, refreshConnectionMode]);

  return { ...snapshot, refresh };
}

const { Provider, useHookContext } = createHookContext(useOutboxQueueState, 'useOutboxQueue');

export { Provider as OutboxQueueProvider, useHookContext as useOutboxQueue };
