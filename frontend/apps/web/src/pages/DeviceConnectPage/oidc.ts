/**
 * OIDC (PKCE) login to the CI cloud Portal for the native Memory app.
 *
 * Mirrors CI-Hub's mobile-connect flow, Capacitor instead of Tauri:
 *
 *   1. build {portal}/api/auth/oauth2/authorize?... and open it in the system browser
 *   2. user signs in / consents on the Portal
 *   3. Portal redirects to companion://auth/callback?code=…&state=… (deep link)
 *   4. exchange the code at {portal}/api/auth/oauth2/token (with the PKCE verifier)
 *
 * Pairing with a Memory the Portal lists a `resource` for takes a second run of
 * the same flow once the person has picked it. On Android the Auth Tab shares
 * Chrome's Portal session, so that is usually a quick hop. The iOS sheet is
 * ephemeral (`prefersEphemeralWebBrowserSession` in LocalHubPlugin.swift), so
 * there the person signs in again. The second sign-in's code exchange adds that
 * `resource`, and the id_token comes back addressed to that one Memory: `aud` is
 * `["ci-server", "urn:ci:device:<device id>"]`. The first sign-in never sends a
 * resource, and nothing is added to the authorize URL.
 *
 * `companion://oidc/callback` is a different path — that is CI-Server's own
 * "Sign in with CI Portal" after an origin is already chosen. Do not mix them.
 *
 * PKCE is persisted to localStorage before Safari opens because iOS often kills
 * the webview while the user is on the Portal, then cold-starts us from the callback.
 */
import {
  addAppUrlOpenListener,
  apiFetch,
  AuthSessionCancelledError,
  closeBrowser,
  getLaunchUrl,
  openAuthSession,
} from '@ci/common';

import { DEFAULT_PORTAL_URL, type MemoryServerDevice } from './portal-client';

export const OIDC_CLIENT_ID = 'ci-server';
export const OIDC_REDIRECT_URI = 'companion://auth/callback';
const OIDC_SCOPE = 'openid email profile';
const OIDC_PENDING_KEY = 'ci-memory.oidc.pending';
const OIDC_CALLBACK_KEY = 'ci-memory.oidc.callback';
const OIDC_PENDING_MAX_AGE_MS = 10 * 60 * 1000;

export interface OidcTokens {
  accessToken: string;
  idToken: string | null;
  tokenType: string;
  expiresIn: number | null;
}

/** A Memory from the Portal's list that the Portal can address a sign-in to. */
export type PairingTarget = MemoryServerDevice & { memoryUrl: string; resource: string };

/** What {@link resumePendingOidcLogin} finished, and for which Memory when it was a pairing sign-in. */
export interface ResumedOidcLogin {
  tokens: OidcTokens;
  /** The Memory the person picked before the pairing sign-in, or null after the first sign-in. */
  pairWith: PairingTarget | null;
}

/**
 * The Portal refused the `resource` a pairing sign-in asked for (`invalid_target`): the Memory is
 * not registered to an organization this Companion account belongs to, or no longer is.
 */
export class PortalInvalidTargetError extends Error {
  constructor() {
    super("This Memory Server isn't one your Companion account can connect to.");
    this.name = 'PortalInvalidTargetError';
  }
}

export interface JwtClaims {
  aud?: string | string[];
  email?: string;
  exp?: number;
  iss?: string;
}

/** Decode a JWT payload without verifying the signature. Display / routing only. */
export function decodeJwtPayload(token: string | null | undefined): JwtClaims | null {
  if (!token) {
    return null;
  }

  const payload = token.split('.')[1];

  if (!payload) {
    return null;
  }

  try {
    const padded = payload.replace(/-/g, '+').replace(/_/g, '/');

    return JSON.parse(atob(padded)) as JwtClaims;
  } catch {
    return null;
  }
}

/** Read `email` from an OIDC id_token payload. Display-only — not a signature check. */
export function emailFromIdToken(idToken: string | null | undefined): string | null {
  const email = decodeJwtPayload(idToken)?.email;

  return typeof email === 'string' && email.trim() ? email.trim() : null;
}

/**
 * Client ids Memory's PortalTokenService accepts (auth.portal.audience). The
 * Portal's OIDC access token is opaque, not a JWT, and is a credential for the
 * Portal itself: it is never sent to a Memory.
 */
const MEMORY_PORTAL_AUDIENCES = new Set([
  'ci-server',
  'ci-hub',
  'ci-import-tools',
  'ci-browser-extension',
  'ci-even',
  'ci-applet',
]);

function audienceValues(aud: JwtClaims['aud']): string[] {
  if (!aud) {
    return [];
  }

  return (Array.isArray(aud) ? aud : [aud]).filter((value) => value.length > 0);
}

/**
 * The id_token from a pairing sign-in, when it is one a Memory accepts and the Portal addressed it
 * to `resource` as asked. Null otherwise: a token the Portal did not address is never sent in its
 * place.
 */
export function bearerAddressedTo(idToken: string | null | undefined, resource: string): string | null {
  const [bearer] = selectMemoryPortalBearers([idToken]);

  return bearer && audienceValues(decodeJwtPayload(bearer)?.aud).includes(resource) ? bearer : null;
}

export function isJwtExpired(token: string, nowSeconds = Date.now() / 1000): boolean {
  const exp = decodeJwtPayload(token)?.exp;

  return typeof exp === 'number' && exp < nowSeconds - 30;
}

/**
 * Portal bearers that may be sent to a Memory's `/api/keys`: unexpired JWTs
 * whose `aud` names a client Memory accepts. Nothing else, ever. This used to
 * fall back to every live JWT, and then to whatever was left (the Portal access
 * token included), handing the picked server credentials it had no use for.
 */
export function selectMemoryPortalBearers(tokens: Array<string | null | undefined>): string[] {
  const unique = [...new Set(tokens.filter((value): value is string => Boolean(value)))];

  return unique.filter(
    (token) =>
      !isJwtExpired(token) &&
      audienceValues(decodeJwtPayload(token)?.aud).some((aud) => MEMORY_PORTAL_AUDIENCES.has(aud)),
  );
}

function base64UrlEncode(bytes: Uint8Array): string {
  let str = '';

  for (const b of bytes) {
    str += String.fromCharCode(b);
  }

  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomString(byteLength = 48): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);

  return base64UrlEncode(bytes);
}

async function sha256Challenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));

  return base64UrlEncode(new Uint8Array(digest));
}

function normalizePortalUrl(url: string): string {
  return url.trim().replace(/\/+$/, '') || DEFAULT_PORTAL_URL;
}

interface PendingOidc {
  verifier: string;
  state: string;
  portal: string;
  startedAt: number;
  /** Set for a pairing sign-in: its exchange sends this Memory's `resource`. */
  pairWith?: PairingTarget;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isPairingTarget(value: unknown): value is PairingTarget {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const target = value as Record<string, unknown>;

  return (
    nonEmptyString(target.id) &&
    nonEmptyString(target.resource) &&
    nonEmptyString(target.memoryUrl) &&
    typeof target.name === 'string' &&
    typeof target.status === 'string'
  );
}

function persistPendingOidc(pending: PendingOidc): void {
  try {
    const raw = JSON.stringify(pending);
    sessionStorage.setItem(OIDC_PENDING_KEY, raw);
    localStorage.setItem(OIDC_PENDING_KEY, raw);
  } catch {
    // Private mode / quota — warm-resume via the live listener may still work.
  }
}

export function hasPendingPortalOidc(): boolean {
  return readPendingOidc() != null;
}

function readPendingOidc(): PendingOidc | null {
  try {
    const raw = sessionStorage.getItem(OIDC_PENDING_KEY) ?? localStorage.getItem(OIDC_PENDING_KEY);

    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as PendingOidc;

    if (!parsed.verifier || !parsed.state || !parsed.portal || !parsed.startedAt) {
      return null;
    }

    // A pairing sign-in whose Memory cannot be read back would be exchanged without its resource.
    if (parsed.pairWith !== undefined && !isPairingTarget(parsed.pairWith)) {
      return null;
    }

    if (Date.now() - parsed.startedAt > OIDC_PENDING_MAX_AGE_MS) {
      clearPendingOidc();

      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

async function clearPendingOidc(): Promise<void> {
  try {
    sessionStorage.removeItem(OIDC_PENDING_KEY);
    localStorage.removeItem(OIDC_PENDING_KEY);
    sessionStorage.removeItem(OIDC_CALLBACK_KEY);
    localStorage.removeItem(OIDC_CALLBACK_KEY);
  } catch {
    /* ignore */
  }
}

function persistOidcCallbackUrl(url: string): void {
  try {
    sessionStorage.setItem(OIDC_CALLBACK_KEY, url);
    localStorage.setItem(OIDC_CALLBACK_KEY, url);
  } catch {
    /* ignore */
  }
}

function readPersistedOidcCallbackUrl(): string | null {
  try {
    return sessionStorage.getItem(OIDC_CALLBACK_KEY) ?? localStorage.getItem(OIDC_CALLBACK_KEY);
  } catch {
    return null;
  }
}

export function parsePortalOidcCallback(
  url: string,
  expectedState?: string,
): { code: string } | { error: Error } | null {
  if (!url.startsWith(OIDC_REDIRECT_URI)) {
    return null;
  }

  const query = url.split('?')[1] ?? '';
  const params = new URLSearchParams(query);
  const error = params.get('error');

  if (error) {
    return { error: new Error(params.get('error_description') || error) };
  }

  const code = params.get('code');
  const state = params.get('state');

  if (!code) {
    return null;
  }

  if (expectedState !== undefined && state !== expectedState) {
    // Leftover callback from a previous Safari hop — ignore, keep waiting.
    return null;
  }

  return { code };
}

/** Pull a callback URL that arrived before JS was listening (iOS cold start). */
async function takePendingOidcCallbackUrl(): Promise<string | null> {
  const launched = await getLaunchUrl();

  if (launched?.startsWith(OIDC_REDIRECT_URI)) {
    persistOidcCallbackUrl(launched);

    return launched;
  }

  const stored = readPersistedOidcCallbackUrl();

  if (stored?.startsWith(OIDC_REDIRECT_URI)) {
    return stored;
  }

  if (typeof window !== 'undefined' && window.location.href.startsWith(OIDC_REDIRECT_URI)) {
    persistOidcCallbackUrl(window.location.href);

    return window.location.href;
  }

  return null;
}

/** Thrown when the user cancels the OIDC sign-in (so the UI can stay quiet). */
export class OidcCancelledError extends Error {
  constructor() {
    super('Sign-in cancelled');
    this.name = 'OidcCancelledError';
  }
}

function awaitOidcCallback(
  expectedState: string,
  signal?: AbortSignal,
  timeoutMs = 300_000,
): Promise<{ code: string }> {
  return new Promise((resolve, reject) => {
    let unlisten: (() => void) | undefined;
    const cleanup = () => {
      clearTimeout(timer);
      unlisten?.();
      signal?.removeEventListener('abort', onAbort);
    };

    const onAbort = () => {
      cleanup();
      void closeBrowser();
      reject(new OidcCancelledError());
    };

    if (signal?.aborted) {
      reject(new OidcCancelledError());

      return;
    }

    signal?.addEventListener('abort', onAbort);
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('Timed out waiting for sign-in to complete.'));
    }, timeoutMs);

    const handle = (url: string) => {
      const parsed = parsePortalOidcCallback(url, expectedState);

      if (!parsed) {
        return;
      }

      persistOidcCallbackUrl(url);
      cleanup();
      void closeBrowser();

      if ('error' in parsed) {
        reject(parsed.error);

        return;
      }

      resolve(parsed);
    };

    void (async () => {
      try {
        unlisten = await addAppUrlOpenListener(handle);

        if (signal?.aborted) {
          unlisten();

          return;
        }

        const already = await takePendingOidcCallbackUrl();

        if (already) {
          handle(already);
        }
      } catch (err) {
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    })();
  });
}

function portalTokenErrorMessage(status: number, body: unknown): string {
  if (body && typeof body === 'object') {
    const rec = body as Record<string, unknown>;
    const text = [rec.error_description, rec.error, rec.message].find(
      (value): value is string => typeof value === 'string' && value.trim().length > 0,
    );

    if (text) {
      return text;
    }
  }

  if (status === 403) {
    return 'Portal refused the token exchange (403). New accounts must verify the email Portal sent, then sign in again.';
  }

  return `Token exchange failed (${status})`;
}

async function tokenFetch(portal: string, body: URLSearchParams): Promise<Response> {
  return apiFetch(`${portal}/api/auth/oauth2/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      // better-auth origin check + Cloudflare bot rules treat a missing/native
      // Origin as a cross-site POST. Speak as the Portal itself.
      Origin: portal,
      Referer: `${portal}/`,
    },
    body: body.toString(),
    signal: AbortSignal.timeout(15_000),
  });
}

const exchangeByCode = new Map<string, Promise<OidcTokens>>();

async function exchangeCodeOnce(
  portal: string,
  code: string,
  codeVerifier: string,
  resource: string | undefined,
): Promise<OidcTokens> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: OIDC_CLIENT_ID,
    redirect_uri: OIDC_REDIRECT_URI,
    code,
    code_verifier: codeVerifier,
  });

  // Only a pairing sign-in asks for a resource. The Portal then addresses the id_token to that
  // one Memory, or answers 400 invalid_target.
  if (resource) {
    body.set('resource', resource);
  }

  const res = await tokenFetch(portal, body);

  if (!res.ok) {
    let parsed: unknown;

    try {
      parsed = await res.json();
    } catch {
      parsed = undefined;
    }

    if (parsed && typeof parsed === 'object' && (parsed as { error?: unknown }).error === 'invalid_target') {
      throw new PortalInvalidTargetError();
    }

    throw new Error(portalTokenErrorMessage(res.status, parsed));
  }

  const data = (await res.json()) as {
    access_token: string;
    id_token?: string;
    token_type?: string;
    expires_in?: number;
  };

  return {
    accessToken: data.access_token,
    idToken: data.id_token ?? null,
    tokenType: data.token_type ?? 'Bearer',
    expiresIn: data.expires_in ?? null,
  };
}

async function exchangeCode(
  portal: string,
  code: string,
  codeVerifier: string,
  resource?: string,
): Promise<OidcTokens> {
  const existing = exchangeByCode.get(code);

  if (existing) {
    return existing;
  }

  const pending = exchangeCodeOnce(portal, code, codeVerifier, resource).catch((err) => {
    exchangeByCode.delete(code);
    throw err;
  });
  exchangeByCode.set(code, pending);

  return pending;
}

/**
 * Run the full OIDC PKCE login against the Portal. On iOS the Portal page is an
 * in-app Safari sheet. On Android it is a Chrome Auth Tab. Resolves once the
 * user finishes and the `companion://auth/callback` deep link is captured and
 * exchanged for tokens.
 *
 * With `pairWith` this is the pairing sign-in for that Memory: the exchange
 * sends its `resource`, and the pending state keeps the Memory so a sign-in
 * finished by an iOS relaunch still pairs with it. A pairing sign-in that fails
 * drops its pending state, so a later resume can't pair behind an error the
 * person has already seen.
 */
export async function loginWithPortalOidc(
  portalUrl = DEFAULT_PORTAL_URL,
  options: { signal?: AbortSignal; pairWith?: PairingTarget } = {},
): Promise<OidcTokens> {
  const portal = normalizePortalUrl(portalUrl);
  const codeVerifier = randomString();
  const codeChallenge = await sha256Challenge(codeVerifier);
  const state = randomString(16);

  const authorizeUrl = new URL(`${portal}/api/auth/oauth2/authorize`);
  authorizeUrl.searchParams.set('client_id', OIDC_CLIENT_ID);
  authorizeUrl.searchParams.set('redirect_uri', OIDC_REDIRECT_URI);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('scope', OIDC_SCOPE);
  authorizeUrl.searchParams.set('code_challenge', codeChallenge);
  authorizeUrl.searchParams.set('code_challenge_method', 'S256');
  authorizeUrl.searchParams.set('state', state);

  await clearPendingOidc();
  exchangeByCode.clear();
  persistPendingOidc({
    verifier: codeVerifier,
    state,
    portal,
    startedAt: Date.now(),
    ...(options.pairWith ? { pairWith: options.pairWith } : {}),
  });

  // `addEventListener` does not fire for a signal that is already aborted, and
  // opening the sheet after the caller has given up is pointless.
  if (options.signal?.aborted) {
    await clearPendingOidc();
    throw new OidcCancelledError();
  }

  const abortOnDismiss = new AbortController();
  const onCallerAbort = () => abortOnDismiss.abort();
  options.signal?.addEventListener('abort', onCallerAbort);
  const callback = awaitOidcCallback(state, abortOnDismiss.signal);

  try {
    await openAuthSession(authorizeUrl.toString());
  } catch (err) {
    // The sheet (or the browser open) failed before a callback arrived. Stop the
    // waiter so its timeout does not keep running, then surface a cancel as the
    // same quiet error the abort path already uses.
    abortOnDismiss.abort();
    options.signal?.removeEventListener('abort', onCallerAbort);
    await callback.catch(() => undefined);

    if (err instanceof AuthSessionCancelledError) {
      await clearPendingOidc();
      throw new OidcCancelledError();
    }

    if (options.pairWith) {
      await clearPendingOidc();
    }

    throw err;
  }

  try {
    const { code } = await callback;
    const tokens = await exchangeCode(portal, code, codeVerifier, options.pairWith?.resource);
    await clearPendingOidc();

    return tokens;
  } catch (err) {
    if (err instanceof OidcCancelledError || options.pairWith) {
      await clearPendingOidc();
    }

    throw err;
  } finally {
    options.signal?.removeEventListener('abort', onCallerAbort);
  }
}

/**
 * Finish an OIDC login after iOS relaunched the app from
 * `companion://auth/callback` (Safari → "Open with Companion").
 * Returns `null` when there is nothing to resume. A pairing sign-in is
 * exchanged with its Memory's `resource` and comes back with that Memory, so
 * the caller can finish pairing instead of showing the list again.
 */
export async function resumePendingOidcLogin(): Promise<ResumedOidcLogin | null> {
  const pending = readPendingOidc();

  if (!pending) {
    return null;
  }

  const url = await takePendingOidcCallbackUrl();

  if (!url) {
    return null;
  }

  const parsed = parsePortalOidcCallback(url, pending.state);

  if (!parsed) {
    return null;
  }

  if ('error' in parsed) {
    await clearPendingOidc();
    throw parsed.error;
  }

  const pairWith = pending.pairWith ?? null;
  let tokens: OidcTokens;

  try {
    tokens = await exchangeCode(pending.portal, parsed.code, pending.verifier, pairWith?.resource);
  } catch (err) {
    if (pairWith) {
      await clearPendingOidc();
    }

    throw err;
  }

  await clearPendingOidc();
  void closeBrowser();

  return { tokens, pairWith };
}
