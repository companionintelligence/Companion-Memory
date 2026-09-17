import { apiFetch } from '@ci/common';

/**
 * Portal client for the native `/device-connect` flow. Signs into CI-Portal, then
 * lists Companion Memory (`ci-memory`) apps the user owns so the phone can point
 * at a Hub-published Memory Server.
 *
 * Portal OIDC access tokens must hit `/api/users/me/apps?slug=…`, not `/api/devices`
 * (that route 401s on OIDC). Email/password uses `/api/devices` and filters for
 * the Memory app URL. Modeled on CI-Hub's mobile-connect portal-client, without
 * Tauri — Capacitor native HTTP is used when present so webview CORS cannot block
 * the Portal origin.
 */

/**
 * Phone cloud-connect always starts on production. `VITE_CI_CLOUD_URL` /
 * `CI_CLOUD_URL` are the Memory server / Hub appliance Portal, not the phone —
 * a local Vite or unmarked store build must not silently aim Sign in at the
 * internal host (`hub.companionintelligence.com`). Advanced can override the
 * Companion URL. A persisted internal host is ignored so old installs migrate
 * to production.
 */
export const DEFAULT_PORTAL_URL = 'https://hub.ci.computer';
const PORTAL_URL_STORAGE_KEY = 'ci.deviceConnect.portalUrl';

/** Portal Hub URL for the next Safari OIDC hop. Independent of the Memory origin. */
export function readPersistedPortalUrl(): string {
  try {
    const stored = typeof localStorage === 'undefined' ? null : localStorage.getItem(PORTAL_URL_STORAGE_KEY);

    if (stored && !stored.includes('companionintelligence.com')) {
      return normalizePortalUrl(stored);
    }

    return DEFAULT_PORTAL_URL;
  } catch {
    return DEFAULT_PORTAL_URL;
  }
}

export function persistPortalUrl(url: string): string {
  const next = normalizePortalUrl(url);

  try {
    localStorage.setItem(PORTAL_URL_STORAGE_KEY, next);
  } catch {
    /* private mode / quota */
  }

  return next;
}

export interface PortalAuth {
  token: string | null;
  cookie: string | null;
  kind?: 'session' | 'oauth';
  /** Portal OIDC id_token — preferred when minting a Memory API key. */
  idToken?: string | null;
}

export interface MemoryServerDevice {
  id: string;
  name: string;
  status: string;
  memoryUrl: string | null;
}

const MEMORY_SLUGS = ['ci-memory', 'companion-memory', 'ci-server'];

export function normalizePortalUrl(url: string): string {
  return url.trim().replace(/\/+$/, '') || DEFAULT_PORTAL_URL;
}

/**
 * Reachability probe for a Memory Server origin. Uses the same native HTTP
 * bridge as Portal calls — WKWebView `fetch` is CORS-bound and fails with
 * TypeError "Load failed" against a Hub-published appliance.
 */
export async function probeMemoryOrigin(origin: string): Promise<void> {
  const url = `${origin.replace(/\/+$/, '')}/api/health`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);

  try {
    const res = await apiFetch(url, { method: 'GET', signal: controller.signal });

    if (!res.ok) {
      throw new Error(`Memory Server responded with ${res.status}`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function portalFetch(url: string, init: RequestInit = {}): Promise<Response> {
  return apiFetch(url, { ...init, signal: init.signal ?? AbortSignal.timeout(15_000) });
}

function extractSessionCookie(setCookie: string | null): string | null {
  if (!setCookie) {
    return null;
  }

  const pairs = setCookie
    .split(/,(?=[^;]+?=)/)
    .map((c) => (c.split(';')[0] ?? '').trim())
    .filter((c) => /session|token|^ci/i.test(c));

  return pairs.length ? pairs.join('; ') : null;
}

function memoryUrlForDevice(device: {
  apps?: Array<{ slug?: string; name?: string; url?: string }>;
}): string | null {
  const apps = device.apps ?? [];
  const memory = apps.find(
    (a) => MEMORY_SLUGS.includes(a.slug ?? '') || /memory|ci-server/i.test(a.name ?? ''),
  );

  return memory?.url ?? null;
}

export async function signInToPortal(
  email: string,
  password: string,
  portalUrl = DEFAULT_PORTAL_URL,
): Promise<PortalAuth> {
  const portal = normalizePortalUrl(portalUrl);
  const res = await portalFetch(`${portal}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });

  if (!res.ok) {
    let message = `Sign-in failed (${res.status})`;

    try {
      const body = (await res.json()) as { message?: string };

      if (body?.message) {
        message = body.message;
      }
    } catch {
      /* keep default */
    }

    throw new Error(message);
  }

  const cookie = extractSessionCookie(res.headers.get('set-cookie'));
  let token: string | null = null;

  try {
    const body = (await res.json()) as { token?: string; session?: { token?: string } };
    token = body?.token ?? body?.session?.token ?? null;
  } catch {
    /* token may only be in the cookie */
  }

  if (!token && !cookie) {
    throw new Error('Sign-in succeeded but no session was returned by the Portal.');
  }

  return { token, cookie, kind: 'session' };
}

async function listMemoryWithOauthToken(auth: PortalAuth, portal: string): Promise<MemoryServerDevice[]> {
  const headers: Record<string, string> = {};

  if (auth.token) {
    headers.Authorization = `Bearer ${auth.token}`;
  }

  const seen = new Set<string>();
  const devices: MemoryServerDevice[] = [];

  for (const slug of MEMORY_SLUGS) {
    const res = await portalFetch(`${portal}/api/users/me/apps?slug=${encodeURIComponent(slug)}`, {
      method: 'GET',
      headers,
    });

    if (!res.ok) {
      throw new Error(`Could not load your Memory Servers (${res.status}).`);
    }

    const body = (await res.json()) as {
      apps?: Array<{ slug?: string; url?: string; deviceName?: string; deviceSlug?: string }>;
    };

    for (const app of body.apps ?? []) {
      const key = app.url || app.deviceSlug || app.deviceName;

      if (!key || seen.has(key)) {
        continue;
      }

      seen.add(key);
      devices.push({
        id: app.deviceSlug || app.url || key,
        name: app.deviceName || app.deviceSlug || key,
        status: 'active',
        memoryUrl: app.url ?? null,
      });
    }

    if (devices.length > 0) {
      break;
    }
  }

  return devices;
}

/** List Companion Memory appliances the authenticated Portal user owns. */
export async function listMemoryServers(
  auth: PortalAuth,
  portalUrl = DEFAULT_PORTAL_URL,
): Promise<MemoryServerDevice[]> {
  const portal = normalizePortalUrl(portalUrl);

  if (auth.kind === 'oauth') {
    return listMemoryWithOauthToken(auth, portal);
  }

  const headers: Record<string, string> = {};

  if (auth.token) {
    headers.Authorization = `Bearer ${auth.token}`;
  }

  if (auth.cookie) {
    headers.Cookie = auth.cookie;
  }

  const res = await portalFetch(`${portal}/api/devices`, { method: 'GET', headers });

  if (!res.ok) {
    throw new Error(`Could not load your Memory Servers (${res.status}).`);
  }

  const body = (await res.json()) as {
    devices?: Array<{
      id: string;
      name?: string;
      displayName?: string;
      slug?: string;
      status?: string;
      apps?: Array<{ slug?: string; name?: string; url?: string }>;
    }>;
  };

  return (body.devices ?? []).map((d) => ({
    id: d.id,
    name: d.displayName || d.name || d.slug || d.id,
    status: d.status ?? 'unknown',
    memoryUrl: memoryUrlForDevice(d),
  }));
}
