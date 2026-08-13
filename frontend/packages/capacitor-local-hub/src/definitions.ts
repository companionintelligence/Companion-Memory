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

/** Result of {@link LocalHubPlugin.secureGet}. */
export interface LocalHubSecureGetResult {
  /** `null` when nothing is stored under the requested key. */
  value: string | null;
}

/**
 * Capacitor plugin surface for the on-device "Local Hub" sidecar: a loopback-only HTTP
 * server embedded in the native app. This interface covers only the *lifecycle* --
 * everything the sidecar actually does is reached over HTTP at the returned `baseUrl`
 * with the returned bearer token, not through more plugin methods:
 *
 * - `GET /api/health` -- liveness + API version.
 * - `/api/outbox…` -- the durable capture queue (enqueue, list, fetch one, delete, record
 *   a flush attempt, retry). Backed by real on-disk SQLite in app-private storage, encrypted
 *   at rest with SQLCipher under a key held in the OS keystore; writes are committed before
 *   the response returns.
 * - Phase 3 (not built): local inference (llama.cpp) plus mirrors of the read endpoints
 *   CI-Server's memory domain exposes today (e.g. `GET /api/memory/search`), served from
 *   this same process so the web client can read/generate fully offline.
 *
 * The `secure*` methods below are the exception to "everything happens over HTTP": they are
 * a keystore-backed credential store, not part of the sidecar's HTTP surface at all, and they
 * work whether or not the server is running.
 *
 * See `README.md` in this package for the full route contract, the capacity/attempt
 * policy, and phase boundaries. Reached at runtime via
 * `window.Capacitor.Plugins.LocalHub`.
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

  /**
   * Reads one value from the OS keystore-backed credential store (Android: an AES-256-GCM
   * key in AndroidKeyStore; iOS: a Keychain item with
   * `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`).
   *
   * Resolves `{ value: null }` when nothing is stored. **Rejects** when the keystore is
   * unusable or a stored blob no longer decrypts — those are not the same thing as "no
   * value", and the native side refuses to blur them. Callers that want to treat any
   * failure as "signed out" (which `secureStorageGet` in `@ci/common` does) opt into that
   * themselves.
   */
  secureGet(options: { key: string }): Promise<LocalHubSecureGetResult>;

  /**
   * Encrypts and stores one value, rejecting rather than storing anything the keystore did
   * not protect. There is deliberately no plaintext fallback: silently degrading to
   * reversible storage while reporting success is the defect this store exists to fix.
   */
  secureSet(options: { key: string; value: string }): Promise<void>;

  /** Removes one value. Resolves successfully when it was already absent. */
  secureRemove(options: { key: string }): Promise<void>;
}
