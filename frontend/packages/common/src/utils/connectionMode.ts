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
 * Detection races two probes — remote health and (on native) the LocalHub
 * sidecar health — each bounded by a short timeout, and resolves to whichever
 * succeeds first. Neither succeeding falls through toward "fresh".
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { buildApiUrl, isNativePlatform } from './apiBase';
import { createHookContext } from './createHookContext';
import { fetchJson } from './fetchJson';
import { localHubHeaders, localHubSession } from './localHub';

export type ConnectionMode = 'connected' | 'local' | 'cached' | 'fresh';

// Per the design doc: each probe gets a short timeout so the indicator
// settles quickly instead of hanging on a dead connection. 500ms sits in the
// middle of the spec'd 300-800ms window.
export const CONNECTION_PROBE_TIMEOUT_MS = 500;

/** Probes the configured remote CI-Server origin's `/api/health` endpoint. */
async function probeRemote(): Promise<boolean> {
  try {
    await fetchJson(buildApiUrl('/api/health'), { timeout: CONNECTION_PROBE_TIMEOUT_MS });

    return true;
  } catch {
    return false;
  }
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

  try {
    await fetchJson(`${session.baseUrl}/api/health`, {
      timeout: CONNECTION_PROBE_TIMEOUT_MS,
      skipApiKey: true,
      headers: localHubHeaders(session),
    });

    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves to the first probe that yields a non-null value (whichever
 * responds first genuinely wins the race — "connected" has no fixed
 * priority over "local"), or `null` once every probe has settled to null.
 * The probes above already swallow their own errors and resolve
 * `false`/`null` on failure or timeout, so there is nothing to reject here.
 */
function firstSuccess<T>(probes: Array<Promise<T | null>>): Promise<T | null> {
  if (probes.length === 0) {
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    let remaining = probes.length;

    for (const probe of probes) {
      void probe.then((value) => {
        if (value != null) {
          resolve(value);

          return;
        }

        remaining -= 1;

        if (remaining === 0) {
          resolve(null);
        }
      });
    }
  });
}

/**
 * Runs the raced health check and resolves the current {@link ConnectionMode}.
 * Called on network-change events and on-demand via `refresh()` from
 * {@link useConnectionMode}.
 */
export async function resolveConnectionMode(): Promise<ConnectionMode> {
  const probes: Array<Promise<ConnectionMode | null>> = [
    probeRemote().then((ok) => (ok ? 'connected' : null)),
  ];

  if (isNativePlatform()) {
    probes.push(probeLocal().then((ok) => (ok ? 'local' : null)));
  }

  const resolved = await firstSuccess(probes);

  if (resolved) {
    return resolved;
  }

  // TODO(cached-detection): once a durable local cache/outbox exists (LocalHub
  // Phase 2+ SQLite outbox, or the PowerSync local DB), check here whether it
  // holds any data and resolve "cached" instead of "fresh". There is no such
  // signal yet, so — per this pass's scope — we do not invent one and always
  // fall through to "fresh".
  return 'fresh';
}

interface ConnectionModeState {
  mode: ConnectionMode;
  refresh: () => void;
}

function useConnectionModeState(): ConnectionModeState {
  const [mode, setMode] = useState<ConnectionMode>('fresh');

  // Coalesces overlapping refreshes (e.g. an `online` event firing while a
  // previous check is still in flight) into a single run.
  const inFlightRef = useRef<Promise<void> | null>(null);

  const refresh = useCallback(() => {
    if (inFlightRef.current) {
      return;
    }

    const run = resolveConnectionMode()
      .then(setMode)
      .finally(() => {
        inFlightRef.current = null;
      });

    inFlightRef.current = run;
  }, []);

  useEffect(() => {
    refresh();

    if (typeof window === 'undefined') {
      return;
    }

    // Re-probe on network-change events per the design doc. `offline` needs no
    // listener of its own: there is nothing to probe successfully while
    // offline, and the next `online` event (or an explicit `refresh()`)
    // re-checks.
    window.addEventListener('online', refresh);

    return () => window.removeEventListener('online', refresh);
  }, [refresh]);

  return { mode, refresh };
}

const { Provider, useHookContext } = createHookContext(useConnectionModeState, 'useConnectionMode');

export { Provider as ConnectionModeProvider, useHookContext as useConnectionMode };
