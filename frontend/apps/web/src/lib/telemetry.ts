/**
 * Browser error reporting.
 *
 * Opt-out — on wherever a DSN is configured. Without `VITE_SENTRY_DSN` at build time
 * nothing initialises and the bundle makes no request to Sentry. `initTelemetry`
 * is safe to call more than once and safe to call when reporting is disabled.
 *
 * Nothing user-identifying is sent — `sendDefaultPii` is off, and `beforeSend`
 * strips the URL query string and any hash, both of which routinely carry the
 * user's own search terms over their memories.
 */

import { buildApiUrl, getApiBaseUrl, isNativePlatform } from '@ci/common';
import * as Sentry from '@sentry/react';

let initialized = false;

/**
 * Which client the event came from. The native shell ships the very same bundle
 * as the browser app, so without this every crash on a phone would be
 * indistinguishable from one on a desktop.
 */
function componentTag(): string {
  return isNativePlatform() ? 'ci-server-mobile' : 'ci-server-web';
}

/** Noise that says nothing about a defect: a stale chunk after a redeploy. */
const CHUNK_LOAD_PATTERNS = [
  /Loading chunk \S+ failed/i,
  /Failed to fetch dynamically imported module/i,
  /Importing a module script failed/i,
  /error loading dynamically imported module/i,
];

/** Extension/browser noise the app can neither cause nor fix. */
const IGNORED_PATTERNS = [
  /ResizeObserver loop/i,
  /^Non-Error promise rejection captured/i,
  ...CHUNK_LOAD_PATTERNS,
];

function messagesOf(event: Sentry.ErrorEvent): string[] {
  return [event.message, ...(event.exception?.values ?? []).map((value) => value.value)].filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
}

export function shouldDropEvent(event: Sentry.ErrorEvent): boolean {
  return messagesOf(event).some((text) => IGNORED_PATTERNS.some((pattern) => pattern.test(text)));
}

/**
 * Strip query and hash — on this app they carry the user's search terms.
 * Deliberately a plain split rather than `new URL()`: it leaves the origin and
 * path exactly as written (no percent-encoding, no base-URL guessing for
 * relative paths) and cannot throw.
 */
export function scrubUrl(url: string): string {
  return url.split(/[?#]/)[0] ?? url;
}

// Kept in lockstep with the backend scrubber at
// backend/apps/api/src/common/telemetry/scrubEvent.ts and the Python twins in
// backend/apps/{hbpe,summary}. Duplicated rather than shared because the three
// live in separate build graphs; change all of them together.
const SECRET_PATTERNS = [
  /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
  /(?:api[-_ ]?key|token|password|secret|jwt|auth)[\s=:"']+[^\s"',}\]]+/gi,
  /tskey-[A-Za-z0-9-]+/gi,
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:[^\s@/]+@/gi,
];

// Windows first — see the note on the backend copy: the macOS pattern otherwise
// matches inside `C:/Users/<name>` and leaves a stranded `C:~/…`.
const HOME_PATH_PATTERNS = [
  /[A-Za-z]:\\Users\\[^\\/\s]+/g, // Windows (backslash)
  /[A-Za-z]:\/Users\/[^/\s]+/g, // Windows (forward-slash)
  /\/Users\/[^/\s]+/g, // macOS
  /\/home\/[^/\s]+/g, // Linux
];

const SENSITIVE_KEY_PATTERN =
  /password|secret|token|authorization|cookie|jwt|api[-_ ]?key|dsn|pepper|private[-_]?key|signature/i;

// Keys that name a PERSON rather than carrying a credential. No value pattern
// can ever match these — a username is just a word — so the key is the only
// signal, the same reason we drop `server_name`. This matters behind CI-Hub's
// Traefik forward-auth: the SDK captures headers that ARRIVED, so a
// proxy-injected `x-ci-hub-user` reaches the event with no reference in our
// code at all.
//
// Anchored on purpose: `user-agent`, `user_id` and `owner_id` are diagnostic
// signal worth keeping, and a naive /user|owner/ would eat all three.
const IDENTITY_KEY_PATTERN = /(?:^|[-_])user$|(?:^|[-_])owner$|username|email|forwarded|^remote-/i;

/** Single predicate so credential and identity coverage cannot diverge. */
function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key) || IDENTITY_KEY_PATTERN.test(key);
}

const MAX_STRING_LENGTH = 8000;

/**
 * Replace the user's own appliance origin with a placeholder.
 *
 * Only native has one to replace — on web the API is same-origin and the base
 * stays `''`. On a phone it is whatever the user typed on the server-settings
 * screen, routinely a tailnet hostname or a LAN IP, and both identify their
 * machine and their network. Turning reporting on for native without this would
 * ship that address to Sentry inside every fetch breadcrumb and every "Failed to
 * fetch" message; `sendDefaultPii: false` does nothing to prevent it, because
 * the SDK has no idea the string is sensitive.
 *
 * Split/join rather than a regex: the origin is user input, so a regex would
 * need escaping to be safe.
 */
export function scrubServerOrigin(value: string, serverOrigin: string): string {
  if (!serverOrigin) {
    return value;
  }

  return value.split(serverOrigin).join('[server]');
}

export function scrubString(value: string, serverOrigin = ''): string {
  let scrubbed = scrubServerOrigin(value, serverOrigin);

  for (const pattern of HOME_PATH_PATTERNS) {
    scrubbed = scrubbed.replace(pattern, '~');
  }

  for (const pattern of SECRET_PATTERNS) {
    scrubbed = scrubbed.replace(pattern, '[Filtered]');
  }

  if (scrubbed.length > MAX_STRING_LENGTH) {
    return `${scrubbed.slice(0, MAX_STRING_LENGTH)}… [truncated]`;
  }

  return scrubbed;
}

export function scrubValue(value: unknown, depth = 0, serverOrigin = ''): unknown {
  if (depth > 8) {
    return '[Truncated]';
  }

  if (typeof value === 'string') {
    return scrubString(value, serverOrigin);
  }

  if (Array.isArray(value)) {
    return value.map((entry) => scrubValue(entry, depth + 1, serverOrigin));
  }

  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};

    for (const [key, nested] of Object.entries(value)) {
      result[key] = isSensitiveKey(key) ? '[Filtered]' : scrubValue(nested, depth + 1, serverOrigin);
    }

    return result;
  }

  return value;
}

/** Breadcrumb `data` keys whose value is a URL (fetch/xhr/navigation crumbs). */
const URL_VALUED_KEYS = new Set(['url', 'from', 'to']);

/** Request headers whose value is a URL the user navigated from. */
const URL_VALUED_HEADERS = ['referer', 'referrer', 'location'];

/**
 * Scrub one breadcrumb in place.
 *
 * The default `breadcrumbsIntegration` records fetch, xhr, console and dom
 * crumbs. fetch/xhr carry `data.url` with the full query string — and on this
 * app the query string IS the user's memory search — while console crumbs carry
 * the joined `message` plus the raw `data.arguments`. Handling only navigation
 * `from`/`to` left all of that untouched.
 */
function scrubBreadcrumb(breadcrumb: Sentry.Breadcrumb, serverOrigin = ''): void {
  if (typeof breadcrumb.message === 'string') {
    breadcrumb.message = scrubString(breadcrumb.message, serverOrigin);
  }

  if (!breadcrumb.data) {
    return;
  }

  // Pass the whole object, not each value: `scrubValue` only applies the
  // sensitive-KEY check while walking an object's own entries, so calling it
  // per-value let a bare `data.token` through — the value alone matches no
  // secret pattern. Same shape as the request-headers handling below.
  const data = scrubValue(breadcrumb.data, 0, serverOrigin) as Record<string, unknown>;

  for (const [key, value] of Object.entries(data)) {
    if (typeof value === 'string' && URL_VALUED_KEYS.has(key)) {
      data[key] = scrubUrl(value);
    }
  }

  breadcrumb.data = data;
}

export function scrubBrowserEvent(event: Sentry.ErrorEvent, serverOrigin = ''): Sentry.ErrorEvent | null {
  if (shouldDropEvent(event)) {
    return null;
  }

  if (event.message) {
    event.message = scrubString(event.message, serverOrigin);
  }

  for (const exception of event.exception?.values ?? []) {
    if (exception.value) {
      exception.value = scrubString(exception.value, serverOrigin);
    }
  }

  if (event.extra) {
    event.extra = scrubValue(event.extra, 0, serverOrigin) as Record<string, unknown>;
  }

  if (event.request?.url) {
    event.request.url = scrubUrl(event.request.url);
  }

  delete event.request?.cookies;
  delete event.request?.query_string;

  // httpContextIntegration puts `document.referrer` here, and the browser's
  // default referrer policy keeps the full same-origin URL — query string and
  // all — which is exactly what scrubUrl exists to remove.
  if (event.request?.headers) {
    const headers = scrubValue(event.request.headers, 0, serverOrigin) as Record<string, string>;

    for (const [key, value] of Object.entries(headers)) {
      if (URL_VALUED_HEADERS.includes(key.toLowerCase()) && typeof value === 'string') {
        headers[key] = scrubUrl(value);
      }
    }

    event.request.headers = headers;
  }

  for (const breadcrumb of event.breadcrumbs ?? []) {
    scrubBreadcrumb(breadcrumb, serverOrigin);
  }

  return event;
}

export function isTelemetryEnabled(): boolean {
  return initialized;
}

// Read at module scope with no optional chaining, so the `if (!DSN) return`
// below folds to statically dead code and the SDK is tree-shaken out of a
// DSN-less build entirely. `import.meta.env.X?.trim()` does NOT fold under
// rolldown (it does under Rollup) — a shape difference that silently put the
// whole SDK back into CI-Import-Tools' bundle. Keep this shape.
const DSN = import.meta.env.VITE_SENTRY_DSN;

/**
 * Ask the appliance whether reporting is permitted right now.
 *
 * A DSN baked into the bundle at build time cannot be revoked afterwards, so
 * without this the `CI_TELEMETRY` / `CI_LOCAL_ONLY` kill switches — including
 * the marketplace "Share crash reports" toggle — would not apply to the browser.
 *
 * Fails CLOSED: if the endpoint is unreachable or malformed we do not report.
 * The bundle is served by the same origin as the API, so an unreachable API
 * means the app is broken anyway, and silently reporting against a consent
 * decision we could not read is the worse failure.
 */
const TELEMETRY_CONFIG_PATH = '/api/config/telemetry';

/**
 * Where to ask about consent — or `null` when there is nobody to ask.
 *
 * On the web the bundle is served by the API's own origin, so a relative path is
 * correct. The native shell is not: Capacitor serves the bundle from
 * `capacitor://localhost` (iOS) or `https://localhost` (Android), so a relative
 * path resolves to the WebView itself and can only 404. Because this check fails
 * closed, that silently disabled reporting for the entire mobile app — the DSN
 * was baked in, the SDK shipped, and no event could ever be sent. Resolving
 * through `buildApiUrl` points the probe at the server the user configured.
 *
 * Returns `null` on native before any server has been configured (first launch,
 * or the user cleared it). There is no appliance to ask, so we must not report.
 */
export function telemetryConfigUrl(): string | null {
  if (isNativePlatform() && !getApiBaseUrl()) {
    return null;
  }

  return buildApiUrl(TELEMETRY_CONFIG_PATH);
}

async function reportingPermitted(): Promise<boolean> {
  const url = telemetryConfigUrl();

  if (!url) {
    return false;
  }

  try {
    const response = await fetch(url, {
      // On native this request is cross-origin to the user's own appliance;
      // `same-origin` keeps cookies off it. The endpoint is unauthenticated by
      // design, so nothing is lost, and on web the behaviour is unchanged.
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    });

    if (!response.ok) {
      return false;
    }

    return ((await response.json()) as { enabled?: unknown }).enabled === true;
  } catch {
    return false;
  }
}

/**
 * Start error reporting if permitted. Returns a promise for tests; callers may
 * ignore it — nothing is reported until consent is confirmed.
 */
export async function initTelemetry(): Promise<void> {
  if (initialized || typeof window === 'undefined') {
    return;
  }

  if (!DSN) {
    return;
  }

  const dsn = DSN.trim();

  if (!dsn || !(await reportingPermitted())) {
    return;
  }

  // Re-check: an await elapsed, and a concurrent caller may have won.
  if (initialized) {
    return;
  }

  Sentry.init({
    dsn,
    environment: import.meta.env.VITE_CI_SERVER_ENVIRONMENT?.trim() || import.meta.env.MODE,
    release: import.meta.env.VITE_SENTRY_RELEASE?.trim() || undefined,
    enabled: true,
    integrations: [
      Sentry.browserTracingIntegration(),
      Sentry.replayIntegration({ maskAllText: true, blockAllMedia: true }),
    ],
    tracesSampleRate: Number(import.meta.env.VITE_SENTRY_TRACES_SAMPLE_RATE ?? 0.1),
    replaysSessionSampleRate: Number(import.meta.env.VITE_SENTRY_REPLAYS_SESSION_SAMPLE_RATE ?? 0.1),
    replaysOnErrorSampleRate: Number(import.meta.env.VITE_SENTRY_REPLAYS_ON_ERROR_SAMPLE_RATE ?? 1),
    enableMetrics: import.meta.env.VITE_SENTRY_ENABLE_METRICS !== 'false',
    enableLogs: import.meta.env.VITE_SENTRY_ENABLE_LOGS !== 'false',
    sendDefaultPii: false,
    // Read the origin per event rather than capturing it once here. Today
    // `/server` is only routed to when no origin is set yet (App.tsx), so in
    // practice it cannot change after init — but `persistApiBaseUrl()` applies
    // a new origin immediately to the running session, so the moment that
    // screen is linked from Settings a value captured here would go stale and
    // silently stop matching the very string it exists to redact.
    beforeSend: (event) => scrubBrowserEvent(event, getApiBaseUrl()),
  });

  initialized = true;
  Sentry.setTag('component', componentTag());
}

export function captureException(error: unknown, context?: Record<string, unknown>): void {
  // `DSN` first, and deliberately not just `initialized`: the latter is a
  // runtime `let`, so `Sentry.withScope` below stays statically reachable and
  // drags the whole SDK back into a DSN-less bundle the moment this function
  // gains a caller. Today it has none, which is the only reason the build
  // measures 0 bytes without a DSN — this guard makes that hold on purpose
  // rather than by luck. (CI-WebXR-Time-Machine hit exactly this.)
  if (!DSN || !initialized) {
    return;
  }

  Sentry.withScope((scope) => {
    for (const [key, value] of Object.entries(context ?? {})) {
      if (value !== undefined) {
        scope.setExtra(key, value);
      }
    }

    Sentry.captureException(error);
  });
}
