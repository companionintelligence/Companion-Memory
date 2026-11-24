/**
 * The write guard: while the appliance is unreachable, a request that would change its
 * database is refused up front, with one explanation the whole app shares, instead of
 * going out to fail on the network and surfacing as whatever each page makes of a
 * failed fetch.
 *
 * What counts as "unreachable" is the connection chip's own verdict: a probe has
 * answered (`isConnectionModeResolved`) and the answer was not "connected" — the phone
 * is on its sidecar, its synced copy, or nothing. Before the first probe nothing is
 * refused; "fresh" then is an absence of an answer, not one.
 *
 * What counts as a write is the HTTP method, aimed at the appliance's own origin.
 * GraphQL is the exception: every operation is a POST, so `/api/graphql` is left to the
 * Apollo link in the web app, which reads the operation and refuses mutations only.
 *
 * Two kinds of caller are deliberately let through:
 *
 * - Paths that must work to get connected at all, or to leave cleanly, listed in
 *   {@link OFFLINE_ALLOWED_PATH_PREFIXES}. Refusing a session refresh would sign the
 *   person out for being offline.
 * - Writers that queue and retry on their own and so do not need the person told
 *   anything — captures, the Local Hub outbox drain, position uploads — which pass
 *   `allowOffline: true` to `fetchJson` / `apiFetch`. Notes on the phone never reach
 *   this module: they are written to the synced `notes` table and replayed by the
 *   PowerSync connector's own fetch.
 *
 * A refused write throws {@link OfflineWriteError} (so the caller's error handling runs,
 * with a message that reads well in a toast) and notifies {@link subscribeOfflineWriteBlocked}
 * (so the app can show its one dialog). It also asks for a fresh probe: the mode it refused
 * on may be up to a re-probe interval old, and the person who just tried is the one who
 * most wants it current.
 */

import { getApiBaseUrl } from './apiBase';
import {
  getLatestConnectionMode,
  isConnectionModeResolved,
  requestConnectionRefresh,
} from './connectionMode';

/** The copy a caller shows when it renders the error's message itself (a toast, an inline error). */
export const OFFLINE_WRITE_MESSAGE =
  'Not connected to your Memory server. This change needs it, so wait until it is back online and try again.';

export class OfflineWriteError extends Error {
  /** The request that was refused, for logs; `operation` for a GraphQL mutation, `url` otherwise. */
  readonly url?: string;

  readonly operation?: string;

  constructor(detail: { url?: string; operation?: string } = {}) {
    super(OFFLINE_WRITE_MESSAGE);
    this.name = 'OfflineWriteError';
    this.url = detail.url;
    this.operation = detail.operation;
  }
}

export function isOfflineWriteError(err: unknown): err is OfflineWriteError {
  return err instanceof OfflineWriteError || (err instanceof Error && err.name === 'OfflineWriteError');
}

/** HTTP methods that change something. HEAD/GET/OPTIONS read. */
export const WRITE_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Appliance paths a write may reach while the probe says "unreachable".
 *
 * - `/api/authenticate` — sign-in, session refresh, logout, the native OIDC exchange. A
 *   refused refresh is a forced sign-out; a refused logout strands the person.
 * - `/api/keys` — the phone's API-key session (mint on pairing, revoke on sign-out).
 * - `/api/signup` — creating the account is how a fresh install gets connected.
 * - `/api/health` — the probe itself (a GET, listed so a future POST probe stays exempt).
 * - `/api/powersync` — the sync token; the connector's own fetch bypasses this module
 *   today, listed so routing it through `apiFetch` would not break sync.
 * - `/api/graphql` — refused per operation by the Apollo link, never here.
 */
export const OFFLINE_ALLOWED_PATH_PREFIXES: readonly string[] = [
  '/api/authenticate',
  '/api/keys',
  '/api/signup',
  '/api/health',
  '/api/powersync',
  '/api/graphql',
];

/**
 * Whether the connection chip currently says the appliance cannot be written to. The single
 * rule, shared with the Apollo link and with UI that disables a control ahead of the click.
 */
export function applianceWritesBlocked(): boolean {
  return isConnectionModeResolved() && getLatestConnectionMode() !== 'connected';
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** The appliance origin requests are resolved against: the configured one, else the page's own. */
function applianceOrigin(): string | null {
  const configured = getApiBaseUrl();

  if (configured) {
    return originOf(configured);
  }

  if (typeof window !== 'undefined' && window.location?.origin && window.location.origin !== 'null') {
    return window.location.origin;
  }

  return null;
}

/** The request's path on the appliance, or null when it is aimed somewhere else (Portal, the sidecar). */
export function appliancePathOf(url: string): string | null {
  if (url.startsWith('/')) {
    return url;
  }

  if (!/^https?:\/\//i.test(url)) {
    return null;
  }

  const origin = applianceOrigin();

  if (!origin || originOf(url) !== origin) {
    return null;
  }

  try {
    return new URL(url).pathname;
  } catch {
    return null;
  }
}

function isAllowedPath(path: string): boolean {
  return OFFLINE_ALLOWED_PATH_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

export interface OfflineWriteBlockedEvent {
  url?: string;
  operation?: string;
  at: number;
}

type Listener = (event: OfflineWriteBlockedEvent) => void;

const listeners = new Set<Listener>();

/** Hear every refused write. The web app mounts one dialog on this; returns the unsubscriber. */
export function subscribeOfflineWriteBlocked(listener: Listener): () => void {
  listeners.add(listener);

  return () => {
    listeners.delete(listener);
  };
}

/**
 * Refuse now if the appliance cannot be written to: notify, ask for a fresh probe, throw.
 * For writers the HTTP layer cannot see — an `XMLHttpRequest` upload, a redirect that
 * starts an OAuth flow — and for the Apollo link.
 */
export function assertApplianceWritable(detail: { url?: string; operation?: string } = {}): void {
  if (!applianceWritesBlocked()) {
    return;
  }

  const event: OfflineWriteBlockedEvent = { ...detail, at: Date.now() };

  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      // One listener's failure must not keep the others from hearing, or the throw below from happening.
    }
  }

  requestConnectionRefresh();

  throw new OfflineWriteError(detail);
}

/**
 * The HTTP-layer check `fetchJson` and `apiFetch` run before a request leaves: a write
 * method, aimed at the appliance, not on the allow-list, not opted out — refuse it.
 */
export function guardApplianceRequest(url: string, method: string | undefined, allowOffline?: boolean): void {
  if (allowOffline || !WRITE_METHODS.has((method ?? 'GET').toUpperCase())) {
    return;
  }

  const path = appliancePathOf(url);

  if (path == null || isAllowedPath(path)) {
    return;
  }

  assertApplianceWritable({ url: path });
}
