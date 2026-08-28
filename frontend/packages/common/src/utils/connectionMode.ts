/**
 * Connection-mode resolver: determines which data source the app is currently
 * backed by, so the UI can tell the user whether they're talking to the
 * configured CI-Server appliance, an on-device LocalHub fallback, a stale
 * local cache, or nothing at all yet. Mirrors the design doc's degradation
 * ladder (2g / A3 stories):
 *
 *   1. "connected" — the configured remote CI-Server origin (the existing
 *      `buildApiUrl()` target) answers its health endpoint.
 *   2. "local"     — the remote is unreachable, but the on-device LocalHub
 *      sidecar (native only — see `frontend/packages/capacitor-local-hub`)
 *      is running and answers its own health endpoint.
 *   3. "cached"    — neither is reachable, but there is local data to show.
 *   4. "fresh"     — nothing is available yet.
 *
 * Both probes run in parallel. Remote health wins whenever it succeeds — the
 * sidecar is a fallback, not a faster path to "local" while the appliance is
 * up. On iOS the sidecar answers in milliseconds, so first-wins painted
 * "On this phone" against a Memory Server the rest of the app was using.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { buildApiUrl, isNativePlatform } from './apiBase';
import { createHookContext } from './createHookContext';
import { fetchJson } from './fetchJson';
import { localHubHeaders, localHubSession } from './localHub';

export type ConnectionMode = 'connected' | 'local' | 'cached' | 'fresh';

// Each probe gets a timeout so the indicator settles instead of hanging on a
// dead connection. The sidecar is on the device itself, so the design doc's
// 300-800ms window applies to it: anything slower than that is not a healthy
// local server.
export const LOCAL_PROBE_TIMEOUT_MS = 500;

// The remote appliance is not on-device, and the same 500ms budget made the
// indicator wrong for every deployment reached over a WAN: an appliance served
// through a Cloudflare tunnel answers /api/health in ~600-700ms, so the probe
// was aborted while healthy and the chip read "Not synced yet" against a server
// the rest of the app was talking to perfectly well. This bounds an unreachable
// server without calling a reachable-but-distant one dead.
export const REMOTE_PROBE_TIMEOUT_MS = 3_000;

// A mode resolved once at mount goes stale the moment anything changes, and the
// `online`/`offline` events do not fire for the failure that matters most here
// (the appliance going away while the network stays up). Re-probe on a timer so
// the chip — and the outbox drain it gates — recover on their own.
export const CONNECTION_REPROBE_INTERVAL_MS = 30_000;

/**
 * Runs a health request under a bound that covers the whole exchange, and
 * reports only whether it succeeded.
 *
 * The probes own their `AbortController` rather than passing `fetchJson`'s
 * `timeout`, because that option clears its timer the moment response headers
 * arrive (see `fetchJson`) and so never covers reading the body. A server that
 * answers and then stalls mid-body would outlive its budget — and since the
 * re-probe timer fires regardless, every tick would leave another hung request
 * open against the same origin until the browser's per-host connection pool is
 * full and the app's own requests queue behind them. Aborting cancels the body
 * read too, so each probe releases its connection when its budget expires.
 *
 * `fetchJson` only installs its own timer when the caller passes no signal, so
 * handing it one is the supported way to take over.
 */
async function probeHealth(
  timeoutMs: number,
  request: (signal: AbortSignal) => Promise<unknown>,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    await request(controller.signal);

    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Probes the configured remote CI-Server origin's `/api/health` endpoint. */
function probeRemote(): Promise<boolean> {
  return probeHealth(REMOTE_PROBE_TIMEOUT_MS, (signal) => fetchJson(buildApiUrl('/api/health'), { signal }));
}

/**
 * Probes the on-device LocalHub sidecar (native only). `localHubSession()`
 * calls the plugin's idempotent `start()` — if the sidecar is already running
 * it returns the existing baseUrl/token without restarting or regenerating the
 * token — so calling it here both ensures the sidecar is up and gets the bearer
 * token its endpoints require, with no risk of disrupting a running server.
 *
 * `skipApiKey`: the appliance's `x-api-key` has no business going to the
 * sidecar, and it is not in the sidecar's CORS allowlist — sending it would
 * fail the WebView's preflight and the probe would never leave the browser.
 */
async function probeLocal(): Promise<boolean> {
  const session = await localHubSession();

  if (!session) {
    return false;
  }

  return probeHealth(LOCAL_PROBE_TIMEOUT_MS, (signal) =>
    fetchJson(`${session.baseUrl}/api/health`, {
      signal,
      skipApiKey: true,
      headers: localHubHeaders(session),
    }),
  );
}

/**
 * Runs the health check and resolves the current {@link ConnectionMode}.
 * Called on network-change events and on-demand via `refresh()` from
 * {@link useConnectionMode}.
 */
export async function resolveConnectionMode(): Promise<ConnectionMode> {
  const remote = probeRemote();
  const local = isNativePlatform() ? probeLocal() : Promise.resolve(false);

  if (await remote) {
    return 'connected';
  }

  if (await local) {
    return 'local';
  }

  // TODO(cached-detection): once a durable local cache/outbox exists (LocalHub
  // Phase 2+ SQLite outbox, or the PowerSync local DB), check here whether it
  // holds any data and resolve "cached" instead of "fresh". There is no such
  // signal yet, so — per this pass's scope — we do not invent one and always
  // fall through to "fresh".
  return 'fresh';
}

// Nothing bounds a resolve as a whole. `fetchJson` clears its abort timer the
// moment response headers arrive, so a server that answers and then stalls its
// body leaves the probe pending indefinitely; on native, the sidecar's `start()`
// bridge call has no timeout of its own either. Left unbounded, one such hang
// pins `inFlightRef` below for the life of the page, and every later refresh —
// including the re-probe timer that exists to recover from exactly this — would
// short-circuit and never run again. Twice the slowest probe budget: long enough
// that a healthy-but-distant appliance is never cut off, short enough that a
// wedged one is not permanent.
export const CONNECTION_RESOLVE_TIMEOUT_MS = 2 * REMOTE_PROBE_TIMEOUT_MS;

/**
 * {@link resolveConnectionMode} under a hard bound, and never rejecting. A probe
 * that hangs or throws resolves "fresh" — the same verdict an unreachable server
 * gets — so the caller's bookkeeping always runs.
 */
function resolveConnectionModeBounded(): Promise<ConnectionMode> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve('fresh'), CONNECTION_RESOLVE_TIMEOUT_MS);

    void resolveConnectionMode()
      .then(resolve, () => resolve('fresh'))
      .finally(() => clearTimeout(timer));
  });
}

interface ConnectionModeState {
  mode: ConnectionMode;
  /**
   * False until the first probe settles. `mode` starts at "fresh" because it
   * has to start somewhere, but that initial value is an absence of an answer,
   * not an answer — surfacing it as one makes every load flash "Not synced yet"
   * before the health check has had a chance to reply. UI that reports the mode
   * to the user should render nothing until this is true; consumers that act on
   * it (the outbox drain) need no change, since they only act on "connected".
   */
  isResolved: boolean;
  refresh: () => void;
}

function useConnectionModeState(): ConnectionModeState {
  const [mode, setMode] = useState<ConnectionMode>('fresh');
  const [isResolved, setIsResolved] = useState(false);

  // Coalesces overlapping refreshes (e.g. an `online` event firing while a
  // previous check is still in flight) into a single run.
  const inFlightRef = useRef<Promise<void> | null>(null);
  // Set when a refresh is requested while one is already running. The in-flight
  // probe started before whatever prompted that request, so its answer may
  // already be stale — without a trailing re-run, an `offline`/`online` pair
  // that straddles a single probe leaves the mode pinned to the offline answer
  // until the next event, and the outbox drain never sees the reconnect.
  const requeuedRef = useRef(false);
  // A probe outlives the tree that started it: the answer must not land on an
  // unmounted hook, and the trailing re-run must not start a fresh probe (up to
  // the bound above) against a server the app has already navigated away from.
  const mountedRef = useRef(true);

  const refresh = useCallback(() => {
    if (inFlightRef.current) {
      requeuedRef.current = true;

      return;
    }

    const run = resolveConnectionModeBounded()
      .then((resolved) => {
        if (!mountedRef.current) {
          return;
        }

        setMode(resolved);
        setIsResolved(true);
      })
      .finally(() => {
        inFlightRef.current = null;

        if (requeuedRef.current) {
          requeuedRef.current = false;

          if (mountedRef.current) {
            refresh();
          }
        }
      });

    inFlightRef.current = run;
  }, []);

  useEffect(() => {
    mountedRef.current = true;

    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    refresh();

    if (typeof window === 'undefined') {
      return;
    }

    // Re-probe on both network-change events. `offline` matters even though no
    // probe can reach the appliance while it is down: the mode is what drives
    // the outbox drain, and a drop that leaves `mode` sitting on "connected"
    // makes the subsequent recovery a non-transition — `online` re-probes,
    // resolves "connected" again, React bails out on the identical state, and
    // nothing ever drains the queue the outage filled. Re-probing here moves
    // the mode to "local" (native, sidecar still up) or "fresh", so coming back
    // is a real transition. It is a probe, not an assumption, because reaching
    // the sidecar is exactly what distinguishes those two.
    window.addEventListener('online', refresh);
    window.addEventListener('offline', refresh);

    // Neither event covers the appliance itself going away (or coming back)
    // while the network stays up, and a single mount-time probe that lost a
    // race — a slow first paint, a tunnel still warming up — would otherwise
    // pin the mode to that one answer for the life of the page. Poll, and skip
    // the tick while the document is hidden: a backgrounded tab has nothing to
    // show, and `visibilitychange` re-probes the moment it comes back.
    //
    // `document` is read through a local binding because this module also runs
    // where it is not declared at all (SSR, node tests) — a bare reference
    // there is a ReferenceError, not `undefined`.
    const doc = typeof document === 'undefined' ? undefined : document;

    // One rule, one closure: re-probe unless the document is hidden. As the
    // interval's tick it skips backgrounded tabs; as the `visibilitychange`
    // handler it fires on the way back to the foreground and does nothing on
    // the way out.
    const refreshIfVisible = () => {
      if (doc?.visibilityState !== 'hidden') {
        refresh();
      }
    };

    const timer = setInterval(refreshIfVisible, CONNECTION_REPROBE_INTERVAL_MS);

    doc?.addEventListener('visibilitychange', refreshIfVisible);

    return () => {
      clearInterval(timer);
      doc?.removeEventListener('visibilitychange', refreshIfVisible);
      window.removeEventListener('online', refresh);
      window.removeEventListener('offline', refresh);
    };
  }, [refresh]);

  return { mode, isResolved, refresh };
}

const { Provider, useHookContext } = createHookContext(useConnectionModeState, 'useConnectionMode');

export { Provider as ConnectionModeProvider, useHookContext as useConnectionMode };
