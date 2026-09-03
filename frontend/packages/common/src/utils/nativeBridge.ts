/**
 * Thin access layer over the native Capacitor plugins, used by the web app when it
 * runs inside the native shell. Plugins are reached through the runtime
 * `window.Capacitor.Plugins` bridge that Capacitor injects — deliberately NOT via
 * `@capacitor/*` imports — so the web bundle never pulls in native dependencies.
 * The native shells (`frontend/apps/ios` and `frontend/apps/android`) declare the
 * actual plugin packages so they are present at runtime.
 *
 * Every function degrades gracefully on web (no `window.Capacitor`): secure storage
 * falls back to `localStorage`, and external links fall back to a normal navigation.
 */

import { isIosPlatform, isNativePlatform, isTauriPlatform } from './apiBase';
import { streamingFetch } from './fetchJson';
import type { BackgroundGeolocationLocation } from './deviceSources/location';

/**
 * `capacitor-secure-storage-plugin`. **Legacy — read-only, for migration.** It used to hold
 * the appliance API key and has two defects that made it unfit for that:
 *
 * - iOS writes with `kSecAttrAccessibleAfterFirstUnlock` (not `…ThisDeviceOnly`), so the
 *   credential is included in encrypted iTunes/Finder backups and restores onto new
 *   hardware — the long-lived appliance key silently migrates with a backup.
 * - Android falls back from AndroidKeyStore RSA wrapping to plain Base64 in the same
 *   `MODE_PRIVATE` SharedPreferences file if Keystore init throws for any reason, logging
 *   one line and reporting success.
 *
 * New writes go to {@link LocalHubPlugin}'s keystore-backed store instead; this interface
 * survives only so an existing install's value can be read once and moved across.
 */
interface SecureStoragePlugin {
  get(options: { key: string }): Promise<{ value: string }>;
  set(options: { key: string; value: string }): Promise<{ value: boolean }>;
  remove(options: { key: string }): Promise<{ value: boolean }>;
}

/**
 * Local Hub sidecar (see `frontend/packages/capacitor-local-hub`). Declared locally rather
 * than imported from that package for the same reason as every other plugin interface here:
 * it keeps the web bundle free of `@capacitor/*` deps.
 *
 * Only the secure-storage surface is declared — the sidecar's HTTP lifecycle is reached
 * through `apiBase`, not from this module.
 */
interface LocalHubPlugin {
  secureGet(options: { key: string }): Promise<{ value: string | null }>;
  secureSet(options: { key: string; value: string }): Promise<void>;
  secureRemove(options: { key: string }): Promise<void>;
  openUrl(options: { url: string }): Promise<void>;
  /**
   * iOS only. One high-accuracy fix for placing a pin — does not write the
   * tracking outbox. Rejects when permission is denied or a fix times out.
   */
  getCurrentLocation?(): Promise<NativeCurrentLocation>;
  openAppSettings?(): Promise<void>;
}

export interface BackgroundGeolocationError {
  code: string;
  message: string;
}

/**
 * `@capacitor-community/background-geolocation`. Declared locally, not imported from the
 * plugin package, for the same reason every other plugin interface here is: it keeps the
 * web bundle free of `@capacitor/*` native deps. One writer only — a second `addWatcher`
 * call replaces rather than adds a session on both platforms, so callers must
 * `removeWatcher` their previous id before starting a new one.
 */
interface BackgroundGeolocationPlugin {
  addWatcher(
    options: {
      /** Set to keep sampling once the app leaves the foreground; omit for foreground-only. */
      backgroundMessage?: string;
      backgroundTitle?: string;
      requestPermissions?: boolean;
      stale?: boolean;
      distanceFilter?: number;
    },
    callback: (
      location: BackgroundGeolocationLocation | undefined,
      error?: BackgroundGeolocationError,
    ) => void,
  ): Promise<string>;
  removeWatcher(options: { id: string }): Promise<void>;
  openSettings(): Promise<void>;
}

/** One-shot fix from {@link getCurrentDeviceLocation} — placing a pin, not tracking. */
export interface NativeCurrentLocation {
  latitude: number;
  longitude: number;
  accuracy?: number;
}

export type DeviceLocationErrorCode = 'denied' | 'unavailable' | 'timeout';

/** One-shot GPS failure from {@link getCurrentDeviceLocation}. */
export class DeviceLocationError extends Error {
  readonly code: DeviceLocationErrorCode;

  constructor(message: string, code: DeviceLocationErrorCode) {
    super(message);
    this.name = 'DeviceLocationError';
    this.code = code;
  }
}

export function isDeviceLocationError(error: unknown): error is DeviceLocationError {
  return error instanceof Error && error.name === 'DeviceLocationError' && 'code' in error;
}

interface BrowserPlugin {
  open(options: { url: string }): Promise<void>;
  close(): Promise<void>;
}

interface PluginListenerHandle {
  remove(): Promise<void> | void;
}

interface AppPlugin {
  addListener(
    eventName: 'backButton',
    listener: (event: { canGoBack?: boolean }) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'appStateChange',
    listener: (event: { isActive: boolean }) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'appUrlOpen',
    listener: (event: { url?: string }) => void,
  ): Promise<PluginListenerHandle>;
  getLaunchUrl(): Promise<{ url?: string } | undefined>;
  exitApp(): Promise<void>;
}

interface SplashScreenPlugin {
  hide(): Promise<void>;
}

interface StatusBarPlugin {
  setStyle(options: { style: 'DARK' | 'LIGHT' | 'DEFAULT' }): Promise<void>;
  setBackgroundColor(options: { color: string }): Promise<void>;
  show(): Promise<void>;
  hide(): Promise<void>;
}

interface LocalNotificationsPlugin {
  checkPermissions(): Promise<{ display: string }>;
  requestPermissions(): Promise<{ display: string }>;
  schedule(options: { notifications: LocalNotification[] }): Promise<unknown>;
}

/**
 * On-device LLM plugin (Android only; see `frontend/packages/capacitor-local-llm`).
 * Declared locally rather than imported from that package — same reason every other
 * plugin interface here is: it keeps the web bundle free of `@capacitor/*` deps.
 */
interface LocalLlmPlugin {
  isAvailable(): Promise<{ available: boolean; reason?: string }>;
  generate(options: { prompt: string }): Promise<{ text: string }>;
  generateStream(options: { prompt: string }): Promise<void>;
  addListener(
    eventName: 'llmToken',
    listener: (event: { partial: string; done: boolean }) => void,
  ): Promise<PluginListenerHandle>;
}

/**
 * `@capacitor/camera`. Stills only — video goes through the system camera via a
 * file input `capture` attribute. `getPhoto` with `source: CAMERA` uses the OS
 * camera UI and does not need PhotoKit / `NSPhotoLibraryUsageDescription`.
 * Do not call `pickImages` / photos permission from here (picker-first library
 * ingest stays on `<input type="file">` / PHPicker).
 */
interface CameraPlugin {
  getPhoto(options: {
    quality?: number;
    allowEditing?: boolean;
    resultType: 'uri' | 'base64' | 'dataUrl';
    source?: 'PROMPT' | 'CAMERA' | 'PHOTOS';
    saveToGallery?: boolean;
  }): Promise<{
    dataUrl?: string;
    webPath?: string;
    format?: string;
  }>;
  requestPermissions?(options?: { permissions?: Array<'camera' | 'photos'> }): Promise<unknown>;
}

type BarcodeScannerPermissionState = 'prompt' | 'prompt-with-rationale' | 'granted' | 'denied' | 'limited';

/**
 * `@capacitor-mlkit/barcode-scanning`. Declared locally, not imported from the plugin
 * package, for the same reason every other plugin interface here is: it keeps the web
 * bundle free of `@capacitor/*`-family native deps.
 *
 * Only the ready-to-use `scan()` surface is used — a full-screen native scanner UI, not
 * the WebView-overlaid `startScan()`/`stopScan()` pair (which needs its own camera-preview
 * layout work this app doesn't have). On Android, `scan()` launches Google Play Services'
 * own scanner activity and resolves the on-demand ML Kit barcode model itself; it does not
 * consult `checkPermissions`/`requestPermissions` the way iOS does.
 */
interface BarcodeScannerPlugin {
  checkPermissions(): Promise<{ camera: BarcodeScannerPermissionState }>;
  requestPermissions(): Promise<{ camera: BarcodeScannerPermissionState }>;
  scan(options?: { formats?: string[] }): Promise<{ barcodes: Array<{ rawValue: string }> }>;
}

interface CapacitorPlugins {
  SecureStoragePlugin?: SecureStoragePlugin;
  LocalHub?: LocalHubPlugin;
  BackgroundGeolocation?: BackgroundGeolocationPlugin;
  Browser?: BrowserPlugin;
  App?: AppPlugin;
  SplashScreen?: SplashScreenPlugin;
  StatusBar?: StatusBarPlugin;
  LocalNotifications?: LocalNotificationsPlugin;
  LocalLLM?: LocalLlmPlugin;
  Camera?: CameraPlugin;
  BarcodeScanner?: BarcodeScannerPlugin;
}

export interface LocalNotification {
  id: number;
  title: string;
  body: string;
  /** Optional fire time; omit to deliver immediately. */
  schedule?: { at: Date };
}

const noop = () => {};

function plugins(): CapacitorPlugins | undefined {
  if (typeof window === 'undefined') {
    return undefined;
  }

  return (window as unknown as { Capacitor?: { Plugins?: CapacitorPlugins } }).Capacitor?.Plugins;
}

/**
 * Reads through to the legacy `capacitor-secure-storage-plugin` and moves whatever it finds
 * into the Local Hub's keystore-backed store, so an existing install is never asked to log in
 * again just because the credential moved house.
 *
 * **Order of operations is the safety property.** The old copy is removed only after the new
 * write has resolved. If the new write fails, the old copy stays exactly where it was and the
 * next launch tries again; the failure mode is "the value briefly exists in two places", never
 * "the value exists in none". Losing it would force a full re-login against an appliance whose
 * URL the user may no longer remember, so a duplicate is by far the cheaper mistake.
 *
 * Returns the migrated value, or null when there was nothing to migrate.
 */
async function migrateLegacySecureValue(hub: LocalHubPlugin, key: string): Promise<string | null> {
  const legacy = plugins()?.SecureStoragePlugin;

  if (!legacy) {
    return null;
  }

  let legacyValue: string | null = null;

  try {
    const { value } = await legacy.get({ key });

    legacyValue = value ?? null;
  } catch {
    // The legacy plugin throws when the key does not exist — the overwhelmingly common case
    // on a fresh install. Nothing to migrate.
    return null;
  }

  if (legacyValue === null) {
    return null;
  }

  await hub.secureSet({ key, value: legacyValue });

  try {
    await legacy.remove({ key });
  } catch {
    // The new copy is already durable, so a failed cleanup is cosmetic: every later read
    // finds the keystore copy first and never consults the legacy plugin again.
  }

  return legacyValue;
}

/**
 * Read a value from the OS keystore (iOS Keychain / Android Keystore) on native, or
 * `localStorage` on web. Returns null when absent.
 *
 * On native this is the Local Hub plugin's `CompanionSecureStore`, which fails closed rather
 * than degrading to unencrypted storage. Any native failure is collapsed to null here — the
 * app then behaves as if signed out, which is recoverable (sign in again) and never results
 * in a credential being written somewhere weaker.
 */
export async function secureStorageGet(key: string): Promise<string | null> {
  const hub = plugins()?.LocalHub;

  if (isNativePlatform() && hub) {
    try {
      const { value } = await hub.secureGet({ key });

      if (value !== null && value !== undefined) {
        return value;
      }

      return await migrateLegacySecureValue(hub, key);
    } catch {
      // Keystore unusable, or a stored blob that no longer decrypts. Treat as "no value":
      // the recovery is re-authentication, and nothing here writes a weaker copy.
      return null;
    }
  }

  const secure = plugins()?.SecureStoragePlugin;

  if (isNativePlatform() && secure) {
    // Native shell without the Local Hub plugin (older build). Fall back rather than lose
    // access to a credential that install already has.
    try {
      const { value } = await secure.get({ key });

      return value ?? null;
    } catch {
      // The plugin throws when the key does not exist — treat as "no value".
      return null;
    }
  }

  try {
    return typeof window !== 'undefined' ? window.localStorage.getItem(key) : null;
  } catch {
    return null;
  }
}

/**
 * Persist a value to the OS keystore on native, or `localStorage` on web.
 *
 * Failures propagate on purpose: a caller that just stored an API key needs to know if it did
 * not stick, and the native side rejects rather than falling back to unprotected storage.
 */
export async function secureStorageSet(key: string, value: string): Promise<void> {
  const hub = plugins()?.LocalHub;

  if (isNativePlatform() && hub) {
    await hub.secureSet({ key, value });

    // Nothing should be left in the legacy store once the keystore copy is authoritative;
    // otherwise a stale credential lingers in the weaker store indefinitely.
    const legacy = plugins()?.SecureStoragePlugin;

    if (legacy) {
      try {
        await legacy.remove({ key });
      } catch {
        // Already absent, which is the normal case after the first migration.
      }
    }

    return;
  }

  const secure = plugins()?.SecureStoragePlugin;

  if (isNativePlatform() && secure) {
    await secure.set({ key, value });

    return;
  }

  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Storage unavailable — best-effort only.
  }
}

/** Remove a value from the OS keystore on native, or `localStorage` on web. */
export async function secureStorageRemove(key: string): Promise<void> {
  const hub = plugins()?.LocalHub;
  const secure = plugins()?.SecureStoragePlugin;

  if (isNativePlatform() && (hub || secure)) {
    // Both stores are cleared: a sign-out that left a copy behind in the legacy store would
    // be worse than one that throws.
    if (hub) {
      try {
        await hub.secureRemove({ key });
      } catch {
        // Already gone — nothing to do.
      }
    }

    if (secure) {
      try {
        await secure.remove({ key });
      } catch {
        // Already gone — nothing to do.
      }
    }

    return;
  }

  try {
    window.localStorage.removeItem(key);
  } catch {
    // ignore
  }
}

/**
 * Call a command registered on the Tauri desktop shell's Rust side
 * (`frontend/apps/desktop/src-tauri/src/main.rs`). Goes through the raw
 * `window.__TAURI_INTERNALS__` bridge rather than an `@tauri-apps/api` import, for the
 * same reason every Capacitor call in this file avoids `@capacitor/*` imports: it keeps
 * this package's — and therefore the web bundle's — dependency graph free of a
 * native-shell-only package that only ever does anything inside that shell. Callers
 * must gate on `isTauriPlatform()` first; outside Tauri this bridge doesn't exist.
 */
async function tauriInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const internals = (
    window as unknown as { __TAURI_INTERNALS__?: { invoke: (cmd: string, args?: unknown) => Promise<T> } }
  ).__TAURI_INTERNALS__;

  if (!internals) {
    throw new Error(`tauriInvoke('${command}') called outside the Tauri shell`);
  }

  return internals.invoke(command, args);
}

/**
 * Open a URL outside the app's webview: the system browser on native (so OAuth/OIDC
 * runs in Safari / Chrome, not the in-app webview), or a normal navigation on web.
 *
 * iOS prefers LocalHub.openUrl (`UIApplication.shared.open`) over Capacitor Browser.
 * Browser presents SFSafariViewController from the Capacitor bridge VC, which never
 * appears under our UIScene SceneDelegate — Sign in then spins with no Safari window.
 *
 * Desktop (Tauri) is a third, distinct native shell — see isTauriPlatform's doc
 * comment for why it isn't folded into the isNativePlatform() checks above. Same
 * reasoning as iOS applies here too: OAuth must run in a browser the user already
 * trusts and may already be signed into, never this app's own embedded webview.
 */
export async function openExternalUrl(url: string): Promise<void> {
  const hub = plugins()?.LocalHub;
  const browser = plugins()?.Browser;

  if (isNativePlatform() && hub?.openUrl) {
    await hub.openUrl({ url });

    return;
  }

  if (isNativePlatform() && browser) {
    await browser.open({ url });

    return;
  }

  if (isTauriPlatform()) {
    await tauriInvoke('open_external_url_command', { url });

    return;
  }

  if (typeof window !== 'undefined') {
    window.location.assign(url);
  }
}

/**
 * Starts a `@capacitor-community/background-geolocation` watcher — the one writer for
 * both iOS and Android native location. No-op (`null`) on web, which keeps using
 * `navigator.geolocation` instead.
 *
 * `options.background`, when true, keeps sampling after the app leaves the foreground
 * (Android shows a persistent notification while this is active; iOS shows the blue
 * status-bar indicator). When false, updates are only guaranteed in the foreground on
 * both platforms. Returns the watcher id `removeBackgroundLocationWatcher` needs, or
 * `null` if no watcher was started.
 */
export async function addBackgroundLocationWatcher(
  options: { background: boolean; distanceFilter?: number },
  onLocation: (location: BackgroundGeolocationLocation) => void,
  onError: (error: BackgroundGeolocationError) => void,
): Promise<string | null> {
  const plugin = plugins()?.BackgroundGeolocation;

  if (!isNativePlatform() || !plugin) {
    return null;
  }

  return plugin.addWatcher(
    {
      requestPermissions: true,
      distanceFilter: options.distanceFilter,
      ...(options.background
        ? {
            backgroundTitle: 'Recording location',
            backgroundMessage: 'Companion is recording your location so it can place memories on the map.',
          }
        : {}),
    },
    (location, error) => {
      if (error) {
        onError(error);

        return;
      }

      if (location) {
        onLocation(location);
      }
    },
  );
}

/** Stops a watcher started by {@link addBackgroundLocationWatcher}. No-op on web. */
export async function removeBackgroundLocationWatcher(id: string): Promise<void> {
  const plugin = plugins()?.BackgroundGeolocation;

  if (!isNativePlatform() || !plugin) {
    return;
  }

  try {
    await plugin.removeWatcher({ id });
  } catch {
    // Already removed, or the plugin is mid-teardown — nothing further to recover.
  }
}

/**
 * Opens the OS location settings screen for the continuous background-tracking
 * permission (Settings → Location, via the background-geolocation plugin). No-op on web.
 * For the one-shot "use my location" denied case, see {@link openNativeAppSettings} instead.
 */
export async function openNativeLocationSettings(): Promise<void> {
  const plugin = plugins()?.BackgroundGeolocation;

  if (!isNativePlatform() || !plugin) {
    return;
  }

  try {
    await plugin.openSettings();
  } catch {
    // Best-effort — nothing to recover into if the OS refuses.
  }
}

/**
 * iOS-only one-shot high-accuracy fix — e.g. "use my current location" when placing a
 * pin. Does not enqueue a tracking outbox record. `null` on other platforms/web, where
 * {@link getCurrentDeviceLocation} falls back to the browser Geolocation API instead.
 */
export async function getNativeCurrentLocation(): Promise<NativeCurrentLocation | null> {
  const hub = plugins()?.LocalHub;

  if (!isIosPlatform() || !hub?.getCurrentLocation) {
    return null;
  }

  return hub.getCurrentLocation();
}

/**
 * Best available device fix: iOS Core Location when the native plugin is
 * present, otherwise the browser Geolocation API (Android / web).
 */
export async function getCurrentDeviceLocation(): Promise<NativeCurrentLocation> {
  if (isIosPlatform()) {
    try {
      const native = await getNativeCurrentLocation();

      if (native) {
        return native;
      }
    } catch (error) {
      throw toDeviceLocationError(error);
    }
  }

  return webCurrentLocation();
}

function toDeviceLocationError(error: unknown): DeviceLocationError {
  const message = error instanceof Error ? error.message : String(error);

  if (/denied|restricted/i.test(message)) {
    return new DeviceLocationError(message, 'denied');
  }

  if (/timed? ?out/i.test(message)) {
    return new DeviceLocationError(message, 'timeout');
  }

  return new DeviceLocationError(message || 'Location is unavailable', 'unavailable');
}

function webCurrentLocation(): Promise<NativeCurrentLocation> {
  if (typeof navigator === 'undefined' || !navigator.geolocation) {
    return Promise.reject(new DeviceLocationError('Geolocation is unavailable', 'unavailable'));
  }

  return new Promise((resolve, reject) => {
    navigator.geolocation.getCurrentPosition(
      (position) => {
        resolve({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracy: position.coords.accuracy,
        });
      },
      (error) => {
        if (error.code === error.PERMISSION_DENIED) {
          reject(new DeviceLocationError(error.message || 'Location permission was denied', 'denied'));

          return;
        }

        if (error.code === error.TIMEOUT) {
          reject(new DeviceLocationError(error.message || 'Timed out waiting for a location fix', 'timeout'));

          return;
        }

        reject(new DeviceLocationError(error.message || 'Location is unavailable', 'unavailable'));
      },
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 5_000 },
    );
  });
}

/**
 * Opens the OS settings screen for the one-shot "use my current location" permission
 * (`CurrentLocationField`). iOS-only — Android/web show an inline message instead. For
 * the continuous background-tracking permission, see {@link openNativeLocationSettings}.
 */
export async function openNativeAppSettings(): Promise<void> {
  const hub = plugins()?.LocalHub;

  if (isIosPlatform() && hub?.openAppSettings) {
    await hub.openAppSettings();
  }
}

/** Dismiss the in-app browser after an OIDC redirect. No-op on web or if already closed. */
export async function closeBrowser(): Promise<void> {
  const browser = plugins()?.Browser;

  if (isNativePlatform() && browser?.close) {
    try {
      await browser.close();
    } catch {
      // Already dismissed — ignore.
    }
  }
}

/**
 * URL that launched the app (custom-scheme cold start). Used to finish Portal PKCE
 * after iOS killed the webview while Safari was on the Portal. Null on web.
 */
export async function getLaunchUrl(): Promise<string | null> {
  const app = plugins()?.App;

  if (!isNativePlatform() || !app?.getLaunchUrl) {
    return null;
  }

  try {
    const result = await app.getLaunchUrl();

    return result?.url ?? null;
  } catch {
    return null;
  }
}

/**
 * Subscribe to the Android hardware back button. `handler` receives whether the
 * webview can navigate back. Returns an unsubscribe function. No-op on web/iOS (the
 * event never fires), where it returns a no-op cleanup.
 */
export async function addBackButtonListener(handler: (canGoBack: boolean) => void): Promise<() => void> {
  const app = plugins()?.App;

  if (!isNativePlatform() || !app) {
    return noop;
  }

  const handle = await app.addListener('backButton', (event) => handler(Boolean(event?.canGoBack)));

  return () => {
    void handle.remove();
  };
}

/**
 * Subscribe to foreground/background transitions. Returns an unsubscribe function.
 * No-op on web.
 */
export async function addAppStateListener(handler: (isActive: boolean) => void): Promise<() => void> {
  const app = plugins()?.App;

  if (!isNativePlatform() || !app) {
    return noop;
  }

  const handle = await app.addListener('appStateChange', (event) => handler(Boolean(event?.isActive)));

  return () => {
    void handle.remove();
  };
}

/**
 * Subscribe to deep links opened into the app (custom URL scheme / universal links).
 * `handler` receives the full URL string. Used to complete native "Sign in with CI
 * Portal": the system browser redirects to `companion://oidc/callback?...` and that
 * URL surfaces here. Returns an unsubscribe function. No-op on web, where it returns
 * a no-op cleanup.
 *
 * Two shells, two delivery mechanisms:
 * - Capacitor (iOS/Android): `@capacitor/app`'s `appUrlOpen` event, live only — a
 *   COLD start's launch URL is a separate call the caller makes itself
 *   (`getLaunchUrl`, see useAuth.ts), not this function.
 * - Tauri (desktop): the Rust side (`main.rs`) already unifies cold-start AND
 *   warm-start delivery into one place, so there is no separate getLaunchUrl-shaped
 *   call needed here — this function alone covers both. It (a) drains
 *   `take_pending_deep_link_command` once, for a URL that arrived before this
 *   listener was up (true cold start, or a warm-start delivery that raced mounting),
 *   then (b) subscribes to the live `companion-deep-link` DOM event `main.rs`
 *   dispatches for anything after. A plain `window.addEventListener` — no
 *   `@tauri-apps/api` import needed, matching this file's Capacitor-free-import
 *   philosophy, because `main.rs` dispatches a standard DOM CustomEvent rather than a
 *   Tauri-specific one.
 */
export async function addAppUrlOpenListener(handler: (url: string) => void): Promise<() => void> {
  const app = plugins()?.App;

  if (isNativePlatform() && app) {
    const handle = await app.addListener('appUrlOpen', (event) => {
      if (event?.url) {
        handler(event.url);
      }
    });

    return () => {
      void handle.remove();
    };
  }

  if (isTauriPlatform()) {
    // `take_pending_deep_link_command` resolves with `null` (never rejects) for the
    // ordinary "nothing pending" case — its Rust impl returns Option<String>. A
    // REJECTION here is therefore always a real failure (an ACL/permission denial is
    // the one seen in practice: the capability granting this command IPC reachability
    // must list the origin the webview navigated to). Keep the same `null` fallback so
    // callers are unaffected, but log the failure instead of silently discarding it.
    const pending = await tauriInvoke<string | null>('take_pending_deep_link_command').catch(
      (err: unknown) => {
        console.error('take_pending_deep_link_command failed', err);

        return null;
      },
    );

    if (pending) {
      handler(pending);
    }

    const onDeepLink = (event: Event) => {
      const url = (event as CustomEvent<string>).detail;

      if (typeof url === 'string') {
        handler(url);
      }
    };

    window.addEventListener('companion-deep-link', onDeepLink);

    return () => {
      window.removeEventListener('companion-deep-link', onDeepLink);
    };
  }

  return noop;
}

/** Quit the native app (Android). No-op on web/iOS (iOS has no programmatic exit). */
export async function exitApp(): Promise<void> {
  const app = plugins()?.App;

  if (isNativePlatform() && app) {
    await app.exitApp();
  }
}

/** Dismiss the native splash screen once the web app has mounted. No-op on web. */
export async function hideSplashScreen(): Promise<void> {
  const splash = plugins()?.SplashScreen;

  if (isNativePlatform() && splash) {
    try {
      await splash.hide();
    } catch {
      // Splash may already be hidden — ignore.
    }
  }
}

/**
 * Apply the native status-bar appearance. Capacitor's names are backwards from English:
 * `'DARK'` is *light* glyphs for a dark background, `'LIGHT'` is *dark* glyphs for a
 * light background. `backgroundColor` is Android-only.
 */
export async function setStatusBarStyle(style: 'DARK' | 'LIGHT', backgroundColor?: string): Promise<void> {
  const statusBar = plugins()?.StatusBar;

  if (!isNativePlatform() || !statusBar) {
    return;
  }

  try {
    await statusBar.setStyle({ style });

    if (backgroundColor) {
      // Android-only; iOS ignores it (the bar is translucent over the webview).
      await statusBar.setBackgroundColor({ color: backgroundColor });
    }
  } catch {
    // Plugin unavailable or unsupported on this platform — ignore.
  }
}

/**
 * Whether OS notification permission is already granted. Returns false on web and
 * when the plugin is unavailable, so callers can gate a permission prompt.
 */
export async function hasNotificationPermission(): Promise<boolean> {
  const notifications = plugins()?.LocalNotifications;

  if (!isNativePlatform() || !notifications) {
    return false;
  }

  try {
    const { display } = await notifications.checkPermissions();

    return display === 'granted';
  } catch {
    return false;
  }
}

/**
 * Prompt for OS notification permission (no-op if already decided). Returns whether
 * permission is granted afterward. No-op → false on web.
 */
export async function requestNotificationPermission(): Promise<boolean> {
  const notifications = plugins()?.LocalNotifications;

  if (!isNativePlatform() || !notifications) {
    return false;
  }

  try {
    const current = await notifications.checkPermissions();
    const { display } = current.display === 'prompt' ? await notifications.requestPermissions() : current;

    return display === 'granted';
  } catch {
    return false;
  }
}

/**
 * Deliver a local notification (immediately, or at `at`). Requests permission first if
 * needed. Returns whether it was scheduled. No-op → false on web. For server-pushed
 * notifications the backend needs APNs/FCM wiring + a device-token endpoint (deferred).
 */
export async function scheduleLocalNotification(
  title: string,
  body: string,
  options: { id?: number; at?: Date } = {},
): Promise<boolean> {
  const notifications = plugins()?.LocalNotifications;

  if (!isNativePlatform() || !notifications) {
    return false;
  }

  if (!(await requestNotificationPermission())) {
    return false;
  }

  try {
    // A stable-ish default id derived from the title so repeat calls coalesce rather
    // than stack; callers that need distinct notifications should pass an explicit id.
    const id = options.id ?? (Math.abs(hashString(title)) % 2_000_000_000) + 1;

    await notifications.schedule({
      notifications: [{ id, title, body, ...(options.at ? { schedule: { at: options.at } } : {}) }],
    });

    return true;
  } catch {
    return false;
  }
}

/**
 * Open the system camera for a still. Returns a `File` ready to POST to
 * `/api/files/upload`, or `null` when the plugin is missing or the user cancels.
 * Web callers should fall through to a capture file input.
 */
export async function takeNativePhoto(): Promise<File | null> {
  const camera = plugins()?.Camera;

  if (!isNativePlatform() || !camera?.getPhoto) {
    return null;
  }

  try {
    await camera.requestPermissions?.({ permissions: ['camera'] });
  } catch {
    // Permission prompt is best-effort; getPhoto will fail clearly if denied.
  }

  try {
    const photo = await camera.getPhoto({
      quality: 90,
      allowEditing: false,
      resultType: 'uri',
      source: 'CAMERA',
      saveToGallery: false,
    });

    return nativePhotoToFile(photo);
  } catch {
    return null;
  }
}

async function nativePhotoToFile(photo: {
  dataUrl?: string;
  webPath?: string;
  format?: string;
}): Promise<File | null> {
  const format = (photo.format || 'jpeg').replace(/^jpg$/i, 'jpeg');
  const ext = format === 'jpeg' ? 'jpg' : format;
  const name = `IMG_${Date.now()}.${ext}`;

  if (photo.webPath) {
    try {
      const response = await fetch(photo.webPath);
      const blob = await response.blob();
      const type = blob.type || `image/${format}`;

      return new File([blob], name, { type });
    } catch {
      // Fall through to dataUrl if the capacitor file URL could not be read.
    }
  }

  if (photo.dataUrl) {
    return fileFromDataUrl(photo.dataUrl, name, `image/${format}`);
  }

  return null;
}

function fileFromDataUrl(dataUrl: string, name: string, fallbackType: string): File | null {
  const comma = dataUrl.indexOf(',');

  if (comma < 0) {
    return null;
  }

  const header = dataUrl.slice(0, comma);
  const payload = dataUrl.slice(comma + 1);
  const mime = /data:([^;]+)/.exec(header)?.[1] ?? fallbackType;

  try {
    const binary = atob(payload);
    const bytes = new Uint8Array(binary.length);

    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }

    return new File([bytes], name, { type: mime });
  } catch {
    return null;
  }
}

export type BarcodeScanErrorCode = 'denied' | 'unavailable';

/**
 * Camera-permission refusal or scanner failure from {@link scanQrCode}. The user simply
 * closing the scanner is not an error — that resolves to `null` instead, matching how
 * {@link takeNativePhoto} treats a cancelled camera.
 */
export class BarcodeScanError extends Error {
  readonly code: BarcodeScanErrorCode;

  constructor(message: string, code: BarcodeScanErrorCode) {
    super(message);
    this.name = 'BarcodeScanError';
    this.code = code;
  }
}

export function isBarcodeScanError(error: unknown): error is BarcodeScanError {
  return error instanceof Error && error.name === 'BarcodeScanError' && 'code' in error;
}

/**
 * Opens the native QR scanner (`@capacitor-mlkit/barcode-scanning`'s ready-to-use `scan()`
 * — a full-screen native camera UI, not a WebView overlay) and returns the raw decoded
 * string of the first barcode found. Restricted to the QR format: this is used to read a
 * Memory Server URL, not a general-purpose barcode reader.
 *
 * Returns `null` on web, when the plugin is missing, or when the user backs out of the
 * scanner without scanning anything — none of those are errors the caller should surface.
 * Throws {@link BarcodeScanError} with code `'denied'` when camera permission is refused,
 * and `'unavailable'` for any other scan failure (e.g. no Google Play Services on
 * Android), so the caller can show a message distinct from a plain cancel.
 */
export async function scanQrCode(): Promise<string | null> {
  const scanner = plugins()?.BarcodeScanner;

  if (!isNativePlatform() || !scanner) {
    return null;
  }

  // iOS gates scan() on the OS camera permission; Android's scan() opens Google Play
  // Services' own scanner activity and manages permission itself, so a 'denied' result
  // here is only ever meaningful on iOS. Best-effort: if checkPermissions/requestPermissions
  // itself throws (e.g. an older plugin build), fall through and let scan() fail clearly.
  try {
    const current = await scanner.checkPermissions();
    const needsPrompt = current.camera === 'prompt' || current.camera === 'prompt-with-rationale';
    const status = needsPrompt ? (await scanner.requestPermissions()).camera : current.camera;

    if (status === 'denied') {
      throw new BarcodeScanError('Camera access is needed to scan a QR code.', 'denied');
    }
  } catch (error) {
    if (isBarcodeScanError(error)) {
      throw error;
    }
  }

  try {
    const { barcodes } = await scanner.scan({ formats: ['QR_CODE'] });

    return barcodes[0]?.rawValue ?? null;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (/denied|permission/i.test(message)) {
      throw new BarcodeScanError('Camera access is needed to scan a QR code.', 'denied');
    }

    if (/cancel/i.test(message)) {
      // The user backed out of the scanner — not an error.
      return null;
    }

    throw new BarcodeScanError('Could not open the scanner.', 'unavailable');
  }
}

/** Small deterministic string hash (djb2) for deriving stable notification ids. */
function hashString(value: string): number {
  let hash = 5381;

  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 33) ^ value.charCodeAt(i);
  }

  return hash | 0;
}

// Keep in sync with apiBase.ts `STORAGE_KEY`. Native App Intents read the base URL
// from the OS keystore (they can't read the webview's localStorage), so we mirror it.
const API_BASE_URL_KEY = 'ci.apiBaseUrl';

/**
 * Mirror the configured API base URL from localStorage into the OS keystore, so native
 * App Intents (Siri/Shortcuts/Spotlight) — which run outside the webview — can reach
 * the same server. The API key is already persisted to the keystore by the auth flow,
 * so together they give an App Intent everything it needs. No-op on web.
 */
export async function syncNativeIntentConfig(): Promise<void> {
  if (!isNativePlatform() || typeof window === 'undefined') {
    return;
  }

  try {
    const baseUrl = window.localStorage.getItem(API_BASE_URL_KEY);

    if (baseUrl) {
      await secureStorageSet(API_BASE_URL_KEY, baseUrl);
    } else {
      // Keep the keystore consistent with localStorage: if the base URL was cleared,
      // drop the mirrored copy so App Intents don't keep using a stale server.
      await secureStorageRemove(API_BASE_URL_KEY);
    }
  } catch {
    // Best-effort — App Intents simply won't be configured until this succeeds.
  }
}

export interface GenerateOfflineOptions {
  /** Forwarded to the remote endpoint; the on-device engine always uses its loaded model. */
  model?: string;
  threadId?: string | null;
  enableTools?: boolean;
  enableThinking?: boolean;
  fileIds?: string[];
  /** Bearer token for the remote fallback (web session auth). Native auth uses `apiKeyHeaders()` instead. */
  authToken?: string;
  signal?: AbortSignal;
  /** Called with each incremental chunk of text, from either the local model or the remote stream. */
  onToken?: (token: string) => void;
}

export interface GenerateOfflineResult {
  text: string;
  /** Which path answered: the on-device model, or the CI-Server `/api/llm/generate` endpoint. */
  source: 'local' | 'remote';
}

/**
 * Answer `prompt` using the on-device LLM when it's present, loaded, and reports itself
 * available (native only) — falling through to the CI-Server `/api/llm/generate` endpoint
 * (same request/response shape as `useChatRequester`) on web, when the plugin is absent,
 * when `isAvailable()` says no, or on any error from the local path. Callers that already
 * called `loadModel()` (e.g. after the user opted into downloading the on-device model)
 * get a local answer; everyone else transparently gets the remote one.
 */
export async function generateOffline(
  prompt: string,
  options: GenerateOfflineOptions = {},
): Promise<GenerateOfflineResult> {
  const llm = plugins()?.LocalLLM;

  if (isNativePlatform() && llm) {
    try {
      const { available } = await llm.isAvailable();

      if (available) {
        const text = options.onToken
          ? await generateLocalStreaming(llm, prompt, options.onToken)
          : (await llm.generate({ prompt })).text;

        return { text, source: 'local' };
      }
    } catch {
      // Local engine errored (not loaded, OOM, cancelled, ...) — fall through to remote.
    }
  }

  const text = await generateRemote(prompt, options);

  return { text, source: 'remote' };
}

/** Drives `generateStream` + the `llmToken` event into a single buffered result, forwarding partials. */
async function generateLocalStreaming(
  llm: LocalLlmPlugin,
  prompt: string,
  onToken: (token: string) => void,
): Promise<string> {
  let full = '';

  const handle = await llm.addListener('llmToken', (event) => {
    if (event.partial) {
      full += event.partial;
      onToken(event.partial);
    }
  });

  try {
    await llm.generateStream({ prompt });

    return full;
  } finally {
    void handle.remove();
  }
}

/**
 * POSTs to `/api/llm/generate` with the same request shape `useChatRequester` uses, and
 * decodes the streamed response — a sequence of length-prefixed binary frames
 * (`[channel<<6|flags][UInt32 BE length][payload]`; see
 * `frontend/apps/web/src/components/Chat/utils/FrameDecoder.ts` and its Swift port,
 * `CompanionAPI.swift`) — keeping only channel 0 (TEXT). Kept self-contained here rather
 * than importing the web app's decoder: `@ci/common` must not depend on `@ci/fe-web`.
 */
async function generateRemote(prompt: string, options: GenerateOfflineOptions): Promise<string> {
  const res = await streamingFetch('/api/llm/generate', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(options.authToken ? { Authorization: `Bearer ${options.authToken}` } : {}),
    },
    body: JSON.stringify({
      prompt,
      model: options.model,
      threadId: options.threadId ?? null,
      enableTools: options.enableTools ?? false,
      enableThinking: options.enableThinking ?? false,
      fileIds: options.fileIds,
    }),
    signal: options.signal,
  });

  if (!res.ok || !res.body) {
    throw new Error(`LLM request failed (${res.status})`);
  }

  return decodeTextFrames(res.body, options.onToken);
}

const TEXT_CHANNEL = 0;
const FRAME_HEADER_BYTES = 5;

/** Reads a frame-encoded response body, returning the concatenated TEXT-channel payload. */
async function decodeTextFrames(
  body: ReadableStream<Uint8Array>,
  onToken?: (token: string) => void,
): Promise<string> {
  const reader = body.getReader();
  const textDecoder = new TextDecoder();
  let buffer = new Uint8Array(0);
  let full = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();

      if (value && value.length > 0) {
        const merged = new Uint8Array(buffer.length + value.length);

        merged.set(buffer, 0);
        merged.set(value, buffer.length);
        buffer = merged;

        while (buffer.length >= FRAME_HEADER_BYTES) {
          const header = buffer[0];
          const channel = (header >> 6) & 0b11;
          const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
          const payloadLength = view.getUint32(1, false);
          const frameSize = FRAME_HEADER_BYTES + payloadLength;

          if (buffer.length < frameSize) {
            break; // Wait for more bytes — the frame isn't fully buffered yet.
          }

          if (channel === TEXT_CHANNEL) {
            const chunk = textDecoder.decode(buffer.slice(FRAME_HEADER_BYTES, frameSize), { stream: true });

            full += chunk;
            onToken?.(chunk);
          }

          buffer = buffer.slice(frameSize);
        }
      }

      if (done) {
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }

  return full;
}
