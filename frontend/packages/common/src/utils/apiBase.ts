/**
 * Runtime-configurable API origin shared by the web and native (Capacitor) clients.
 *
 * Web: the base stays `''`, so every `/api/...` request is same-origin and keeps
 * flowing through the dev proxy (Vite) / Caddy exactly as before — zero behavior
 * change. Native: there is no same-origin server, so the Capacitor shell resolves
 * the user's CI-Server address at startup (from Capacitor Preferences, falling back
 * to the `VITE_API_BASE_URL` build default) and calls `setApiBaseUrl()` before the
 * app makes any request.
 *
 * This module intentionally does NOT import `@capacitor/*` — keeping it Capacitor-free
 * means the web bundle never pulls in native deps. The native bootstrap reads
 * Preferences and pushes the value in via `setApiBaseUrl()`.
 */

function readBuildDefault(): string {
  try {
    // Vite inlines `import.meta.env` at build time. Guard for non-Vite contexts
    // (e.g. Jest/Vitest node env, SSR) where `import.meta.env` is undefined.
    const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;

    return env?.VITE_API_BASE_URL ?? '';
  } catch {
    return '';
  }
}

let apiBaseUrl = normalize(readBuildDefault());

type ApiBaseListener = () => void;
const apiBaseListeners = new Set<ApiBaseListener>();

function normalize(url: string | null | undefined): string {
  // Drop trailing slashes so `buildApiUrl('/api/x')` never produces a `//`.
  return (url ?? '').replace(/\/+$/, '');
}

/**
 * Subscribe to Memory origin changes. Native GraphQL/feature fetches must not
 * start until this is an absolute http(s) origin — CapacitorHttp rejects
 * relative `/api/...` paths.
 */
export function subscribeApiBaseUrl(listener: ApiBaseListener): () => void {
  apiBaseListeners.add(listener);

  return () => {
    apiBaseListeners.delete(listener);
  };
}

function notifyApiBaseListeners(): void {
  apiBaseListeners.forEach((listener) => listener());
}

/**
 * Override the API origin at runtime. Called by the native bootstrap once the
 * stored server URL is known, and by the in-app server-settings screen when the
 * user changes it. Passing an empty value resets to same-origin (web behavior).
 */
export function setApiBaseUrl(url: string | null | undefined): void {
  const next = normalize(url);

  if (next === apiBaseUrl) {
    return;
  }

  apiBaseUrl = next;
  notifyApiBaseListeners();
}

/** The current API origin: `''` on web (same-origin), a full origin on native. */
export function getApiBaseUrl(): string {
  return apiBaseUrl;
}

/**
 * Resolve a relative API path (`/api/...`) against the configured origin.
 * Absolute URLs are returned untouched, so callers can pass either.
 */
export function buildApiUrl(path: string): string {
  if (/^[a-z]+:\/\//i.test(path)) {
    return path;
  }

  return `${apiBaseUrl}${path}`;
}

/**
 * Parse a Hub/user-supplied Memory address into a clean `http:`/`https:` origin.
 * Hostnames without a scheme get `https://` so a Portal row like
 * `ci-memory-core7.example.com` does not become a relative URL against the
 * Capacitor live-reload origin (which iOS URLSession reports as "unsupported URL").
 */
export function resolveHttpOrigin(value: string): string {
  const trimmed = value.trim();

  if (!trimmed) {
    throw new Error('This Memory Server has no address.');
  }

  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let parsed: URL;

  try {
    parsed = new URL(withScheme);
  } catch {
    throw new Error(`Not a valid Memory Server URL (${trimmed}).`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Memory Server URL must be http or https (${trimmed}).`);
  }

  if (!parsed.hostname) {
    throw new Error(`Memory Server URL is missing a host (${trimmed}).`);
  }

  return parsed.origin;
}

const STORAGE_KEY = 'ci.apiBaseUrl';

/**
 * Whether the app is running inside the native Capacitor shell. Detected via the
 * `window.Capacitor` bridge that Capacitor injects at runtime, so no `@capacitor/*`
 * import is pulled into the web bundle. Returns false in a plain browser/SSR/test.
 */
export function isNativePlatform(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  const cap = (window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor;

  return Boolean(cap?.isNativePlatform?.());
}

/**
 * True only inside the iOS Capacitor shell. Web, Android, and tests without a
 * `getPlatform` stub stay false so browser auth is unchanged.
 */
export function isIosPlatform(): boolean {
  if (!isNativePlatform()) {
    return false;
  }

  const cap = (window as unknown as { Capacitor?: { getPlatform?: () => string } }).Capacitor;

  return cap?.getPlatform?.() === 'ios';
}

/**
 * Whether the app is running inside the desktop Tauri shell (`frontend/apps/desktop`).
 * A DIFFERENT native shell from Capacitor's — Tauri injects `window.__TAURI_INTERNALS__`,
 * never `window.Capacitor` — so `isNativePlatform()` is always false here and callers
 * that need to treat desktop like a native platform (system-browser OAuth today) must
 * check both explicitly rather than folding this into isNativePlatform(): most of what
 * that flag gates (device-connect on launch, camera/location bridges, …) is genuinely
 * mobile-only and wrong for a desktop window.
 */
export function isTauriPlatform(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  return '__TAURI_INTERNALS__' in window;
}

/**
 * Loopback / .localhost / .local appliance URLs. iOS must not treat these as a
 * finished pairing — the phone always goes through Portal cloud-connect.
 */
export function isLocalApplianceOrigin(url: string): boolean {
  if (!url) {
    return true;
  }

  try {
    const { hostname } = new URL(url);

    return (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '0.0.0.0' ||
      hostname === '::1' ||
      hostname.endsWith('.localhost') ||
      hostname.endsWith('.local')
    );
  } catch {
    return true;
  }
}

/**
 * Whether the native shell should send the user through `/device-connect`.
 *
 * iOS always uses that Portal cloud-connect flow. A leftover docker / LAN origin
 * does not skip it. Android still only pairs when no origin is set yet.
 */
export function needsNativeCloudConnect(): boolean {
  if (!isNativePlatform()) {
    return false;
  }

  const origin = getApiBaseUrl();

  if (!origin) {
    return true;
  }

  return isIosPlatform() && isLocalApplianceOrigin(origin);
}

/**
 * Initialize the API origin at startup. Call once from the app entrypoint before
 * rendering. On web this is a no-op (origin stays `''` → same-origin). On native it
 * loads the user-configured server origin from localStorage (which the Capacitor
 * webview persists), falling back to the `VITE_API_BASE_URL` build default.
 */
export function initApiBaseUrl(): void {
  if (!isNativePlatform()) {
    return;
  }

  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);

    setApiBaseUrl(stored || readBuildDefault());
  } catch {
    setApiBaseUrl(readBuildDefault());
  }
}

/**
 * Persist and apply a new server origin. Used by the native server-settings screen.
 * No-ops storage failures (the in-memory base is still updated for the session).
 */
export function persistApiBaseUrl(url: string): void {
  setApiBaseUrl(url);

  try {
    window.localStorage.setItem(STORAGE_KEY, getApiBaseUrl());
  } catch {
    // Storage unavailable — keep the in-memory override for this session only.
  }
}
