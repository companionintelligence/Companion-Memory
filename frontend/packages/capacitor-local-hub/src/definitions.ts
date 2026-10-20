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

  /**
   * Opens `url` outside the app WebView.
   * Android presents Chrome Auth Tab and replays `companion://` into `appUrlOpen`.
   * Portal sign-in on Android lands here. iOS opens Safari; Portal sign-in there
   * uses {@link startAuthSession} instead.
   *
   * `external: true` is for links that are not a sign-in. Android then hands the URL to
   * whichever app handles it (the browser, or the provider's own app) instead of the Auth
   * Tab, which would report any `companion://` the page navigates to as a sign-in result.
   * iOS ignores it: Safari is already outside the app.
   */
  openUrl(options: { url: string; external?: boolean }): Promise<void>;

  /**
   * iOS only. Presents an in-app Safari authentication sheet and resolves when it
   * finishes. The sheet does not keep Portal cookies, so the next sign-in asks
   * for the account again. The `companion://` callback is forwarded into the app;
   * it does not open Safari. Rejects with code `CANCELLED` when the user dismisses the sheet.
   * Android rejects as unavailable. Android sign-in goes through `openUrl`.
   */
  startAuthSession(options: { url: string; callbackScheme?: string }): Promise<void>;

  /**
   * iOS only. One high-accuracy fix for placing a pin — does not write the
   * tracking outbox. Rejects when permission is denied or a fix times out.
   */
  getCurrentLocation(): Promise<NativeCurrentLocation>;

  openAppSettings(): Promise<void>;

  /**
   * iOS only. Core Location authorization for the Always two-step
   * (When In Use, then Always Allow). Android resolves `{ status: "unsupported" }`.
   */
  getLocationAuthorization(): Promise<{ status: NativeLocationAuthorization }>;

  requestLocationAuthorization(options: {
    always: boolean;
  }): Promise<{ status: NativeLocationAuthorization }>;

  /**
   * Background samples for Always tracking, on both platforms, delivered as
   * `significantLocation` events (`significantLocationError` with `code: 'NOT_AUTHORIZED'`
   * when the OS refuses).
   *
   * iOS: significant-change monitoring plus one resume geofence around the last queued fix
   * -- a callback when the phone moves a meaningful distance, including after the app leaves
   * the foreground, without the solid blue background indicator. Armed state is persisted
   * natively and the app delegate restarts the monitor on every launch, including the
   * background relaunches iOS performs for a location or region event and after a reboot,
   * so recording continues with the app swiped away. Every fix that clears the
   * distance/interval gate is queued into the encrypted outbox from native code, and also
   * emitted as an event when a WebView is alive. `options` is required, as on Android. If
   * the Always grant lapses, a relaunch posts a notification asking for an app open, where
   * the web side's re-arm runs the two-step prompt again.
   *
   * Android: a location foreground service of this plugin's own, started from the screen
   * and kept running until `stopSignificantLocationUpdates` -- across the app being swiped
   * out of recents, which ended the previous plugin's bound service. Every fix that clears
   * the distance/interval gate is queued straight into the encrypted outbox from native
   * code, so nothing depends on the WebView being alive; it is also emitted as an event, and
   * the web side's own enqueue of it collapses on the shared `source_id`. `options` is
   * required there -- see {@link SignificantLocationOptions}. A reboot, an app update or a
   * process death ends the service, and without the background-location grant nothing but
   * an app open may start it again: the plugin posts a notification asking for that open,
   * and the open itself restarts sampling.
   */
  startSignificantLocationUpdates(options?: SignificantLocationOptions): Promise<void>;

  stopSignificantLocationUpdates(): Promise<void>;
}

/**
 * What Android needs to build, from a process that may have no JavaScript, exactly the
 * record the web side's `buildPositionRecord` would have built for the same fix. Every
 * value is one the web side owns (its storage, its constants, its copy); nothing is
 * invented natively.
 */
export interface SignificantLocationOptions {
  /** Stable per-install id that prefixes `source_id` (`deviceSourceKey()`). Required on Android. */
  deviceKey: string;
  /** Free-text producer stored on the row; defaults to `companion-mobile`. */
  provider?: string;
  /** The outbox owner stamp (`outboxOwnerStamp()`), or null when nobody is signed in. */
  owner?: string | null;
  /** Persist gate: record on moving this far OR waiting this long. */
  minDistanceMeters?: number;
  minIntervalMs?: number;
  /** Fixes looser than this are dropped, not queued. */
  maxAccuracyMeters?: number;
  /** The foreground-service notification shown while recording (Android requires one). */
  notificationTitle?: string;
  notificationText?: string;
}

export type NativeLocationAuthorization =
  'notDetermined' | 'denied' | 'restricted' | 'whenInUse' | 'always' | 'unsupported';

export interface NativeCurrentLocation {
  latitude: number;
  longitude: number;
  /** Horizontal accuracy in meters, when Core Location reports one. */
  accuracy?: number;
}
