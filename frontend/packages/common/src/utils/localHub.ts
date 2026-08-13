/**
 * Shared access to the on-device Local Hub sidecar (`frontend/packages/capacitor-local-hub`):
 * a loopback-only HTTP server embedded in the native app, reachable at a per-launch
 * `baseUrl` and gated by a per-launch bearer `token`.
 *
 * Every consumer needs the same two things — "is there a sidecar, and what are its
 * baseUrl/token?" — so that lookup lives here rather than being re-derived per module
 * (`connectionMode.ts` probes its health, `outbox.ts` talks to its queue routes).
 *
 * The plugin interface is declared locally rather than imported from
 * `@ci/capacitor-local-hub` — same reason every plugin interface in `nativeBridge.ts` is:
 * it keeps the web bundle free of `@capacitor/*` deps. That package's `src/definitions.ts`
 * remains the source of truth; this is a structural mirror of it.
 */

import { isNativePlatform } from './apiBase';

/** A live sidecar's address plus the bearer token every one of its routes requires. */
export interface LocalHubSession {
  /** `http://127.0.0.1:<port>` — loopback only, never reachable off-device. */
  baseUrl: string;
  /** Per-launch bearer token. Send as `Authorization: Bearer <token>`. */
  token: string;
}

interface LocalHubPlugin {
  start(): Promise<LocalHubSession>;
  stop(): Promise<void>;
  getStatus(): Promise<{ running: boolean; baseUrl?: string }>;
}

/** The `LocalHub` plugin off the runtime Capacitor bridge, or undefined when absent. */
export function localHubPlugin(): LocalHubPlugin | undefined {
  if (typeof window === 'undefined') {
    return undefined;
  }

  return (window as unknown as { Capacitor?: { Plugins?: { LocalHub?: LocalHubPlugin } } }).Capacitor?.Plugins
    ?.LocalHub;
}

/**
 * Resolve a usable {@link LocalHubSession}, or `null` when there is no sidecar to talk to
 * — on web, when the plugin isn't installed/synced into the native shell, or when the
 * server fails to start.
 *
 * `start()` is idempotent by contract: an already-running server returns its existing
 * baseUrl/token without restarting or rotating the token, so calling this per request both
 * ensures the sidecar is up and yields a currently-valid token. Deliberately uncached —
 * a cached token would go stale the moment the server is restarted (app resumed from a
 * process kill), and re-asking is a cheap in-process bridge call.
 */
export async function localHubSession(): Promise<LocalHubSession | null> {
  if (!isNativePlatform()) {
    return null;
  }

  const hub = localHubPlugin();

  if (!hub) {
    return null;
  }

  try {
    const { baseUrl, token } = await hub.start();

    return baseUrl && token ? { baseUrl, token } : null;
  } catch {
    return null;
  }
}

/**
 * Headers for a sidecar request. Only ever `Authorization` — the sidecar's CORS policy
 * allowlists a fixed, small set of request headers, and the WebView preflights every
 * request (`Authorization` makes them all "non-simple"), so an extra header here silently
 * fails the preflight and the request never leaves the browser.
 */
export function localHubHeaders(session: LocalHubSession): Record<string, string> {
  return { Authorization: `Bearer ${session.token}` };
}
