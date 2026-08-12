/** Result of {@link LocalHubPlugin.start}. */
export interface LocalHubStartResult {
  /** `http://127.0.0.1:<port>` for the just-(re)confirmed-running embedded server. */
  baseUrl: string;
  /**
   * Cryptographically random per-launch bearer token. Regenerated every time `start()`
   * actually starts a fresh server; never persisted to disk. Callers must send it as
   * `Authorization: Bearer <token>` on every request to the embedded server.
   */
  token: string;
}

/** Result of {@link LocalHubPlugin.getStatus}. */
export interface LocalHubStatusResult {
  running: boolean;
  /** Present only when `running` is true. */
  baseUrl?: string;
}

/**
 * Capacitor plugin surface for the on-device "Local Hub" sidecar: a loopback-only HTTP
 * server embedded in the native app. Phase 1 (this package, as shipped today) is a bare
 * skeleton -- lifecycle management plus a single authenticated health check. It exists so
 * later phases have somewhere to land without another native scaffolding pass:
 *
 * - Phase 2: a durable outbox (SQLite + SQLCipher) so the web client can queue writes
 *   while offline and let the Local Hub flush them to CI-Server when connectivity returns.
 * - Phase 3: local inference (llama.cpp) plus mirrors of the read endpoints CI-Server's
 *   memory domain exposes today (e.g. `GET /api/memory/search`), served from this same
 *   process so the web client can read/generate fully offline.
 *
 * See `README.md` in this package for the full design and phase boundaries. Reached at
 * runtime via `window.Capacitor.Plugins.LocalHub`.
 */
export interface LocalHubPlugin {
  /**
   * Starts the embedded HTTP server if it isn't already running, bound to
   * `127.0.0.1` on an OS-assigned ephemeral port, and generates a fresh bearer token.
   * If the server is already running, returns the existing `baseUrl`/`token` unchanged
   * (does not restart the server or rotate the token).
   */
  start(): Promise<LocalHubStartResult>;

  /** Stops the embedded server if running. No-op if it isn't. */
  stop(): Promise<void>;

  /** Current run state, with `baseUrl` when running. */
  getStatus(): Promise<LocalHubStatusResult>;
}
