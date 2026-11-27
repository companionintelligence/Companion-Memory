/**
 * The credential the phone and desktop apps send with each request (`x-api-key`), held outside
 * React so the request layer (Apollo's auth link, `fetchJson`, the raw `fetch` call sites) can
 * read it synchronously.
 *
 * The apps sign in once and keep a durable API key in the OS keystore. The page never holds that
 * key: it would let any script that ever ran in the page carry off a credential that works from
 * anywhere until someone revokes it. The native side keeps the key and hands the page short-lived
 * access tokens for it (`deviceAccessToken` on the LocalHub plugin, `device_access_token` on the
 * desktop), which Memory accepts in the key's place (`POST /keys/access-token`). This module asks
 * for one when the app starts ({@link startDeviceAccessTokens}), asks again a minute before each
 * expires, retries while Memory cannot be reached, and reports a key Memory refused.
 *
 * On web nothing is set, so `apiKeyHeaders()` returns `{}` and nothing changes.
 */

const API_KEY_HEADER = 'x-api-key';

/** What the native side found; mirrors `DeviceAccessTokenResult` in `@ci/capacitor-local-hub`. */
export type DeviceAccessTokenStatus = 'ok' | 'none' | 'revoked' | 'unreachable' | 'legacy';

export interface DeviceAccessTokenResult {
  status: DeviceAccessTokenStatus;
  /** A token (`ok`), the stored key itself when Memory predates tokens (`legacy`), else null. */
  token: string | null;
  /** When `token` stops working, in ms since the epoch. Only for `ok`. */
  expiresAt: number | null;
  keyId: string | null;
  ownerStamp: string | null;
}

/** Asks the native side; `refresh` makes it ask Memory even when its copy is still good. */
export type DeviceAccessTokenSource = (options: { refresh: boolean }) => Promise<DeviceAccessTokenResult>;

/** Ask this long before a token expires. The native side keeps its copy until then too. */
const REFRESH_AHEAD_MS = 60_000;
/** Never ask again sooner than this, whatever a token claims. */
const MIN_DELAY_MS = 5_000;
/** While Memory cannot be reached: first retry, then doubling up to the ceiling. */
const UNREACHABLE_FLOOR_MS = 15_000;
const UNREACHABLE_CEILING_MS = 120_000;
/** A Memory from before tokens is asked again this often, so an upgrade takes effect. */
const LEGACY_RECHECK_MS = 30 * 60_000;
/** A forced refresh (a 401, the app coming back into view) at most this often. */
const FORCED_REFRESH_MIN_GAP_MS = 10_000;

let credential: string | null = null;
let source: DeviceAccessTokenSource | null = null;
let expiresAt: number | null = null;
let ownerStamp: string | null = null;
let keyId: string | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let unreachableDelay = UNREACHABLE_FLOOR_MS;
let inFlight: Promise<DeviceAccessTokenResult> | null = null;
let lastForcedAt = 0;
/** Bumped on every start and stop, so an answer to an older session is dropped. */
let generation = 0;

const listeners = new Set<() => void>();
const revokedListeners = new Set<(revokedKeyId: string | null) => void>();

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

function setCredential(next: string | null): void {
  const value = next && next.length > 0 ? next : null;

  if (value !== credential) {
    credential = value;
    notify();
  }
}

function clearTimer(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

function schedule(delayMs: number): void {
  clearTimer();
  timer = setTimeout(
    () => {
      timer = null;
      void ask(false);
    },
    Math.max(delayMs, MIN_DELAY_MS),
  );
}

function apply(result: DeviceAccessTokenResult): void {
  keyId = result.keyId;
  ownerStamp = result.ownerStamp;

  switch (result.status) {
    case 'ok':
      expiresAt = result.expiresAt;
      unreachableDelay = UNREACHABLE_FLOOR_MS;
      setCredential(result.token);
      schedule((result.expiresAt ?? Date.now()) - REFRESH_AHEAD_MS - Date.now());

      return;
    case 'legacy':
      expiresAt = null;
      unreachableDelay = UNREACHABLE_FLOOR_MS;
      setCredential(result.token);
      schedule(LEGACY_RECHECK_MS);

      return;
    case 'unreachable':
      // A token that has not expired yet still works once Memory answers again.
      if (expiresAt === null || expiresAt <= Date.now()) {
        expiresAt = null;
        setCredential(null);
      }

      schedule(unreachableDelay);
      unreachableDelay = Math.min(unreachableDelay * 2, UNREACHABLE_CEILING_MS);

      return;
    case 'revoked':
    case 'none':
      clearTimer();
      expiresAt = null;
      setCredential(null);

      if (result.status === 'revoked') {
        for (const listener of revokedListeners) {
          listener(result.keyId);
        }
      } else {
        keyId = null;
        ownerStamp = null;
      }
  }
}

function ask(refresh: boolean): Promise<DeviceAccessTokenResult> {
  if (!source) {
    return Promise.resolve({ status: 'none', token: null, expiresAt: null, keyId: null, ownerStamp: null });
  }

  // One question at a time. A forced refresh while an ordinary one is out takes its answer.
  if (inFlight) {
    return inFlight;
  }

  const asked = generation;
  const from = source;

  inFlight = from({ refresh })
    .catch((): DeviceAccessTokenResult => ({
      status: 'unreachable',
      token: null,
      expiresAt: null,
      keyId,
      ownerStamp,
    }))
    .then((result) => {
      if (asked === generation) {
        apply(result);
      }

      return result;
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}

/**
 * Start sending the native side's access tokens: asks for the first one and resolves with what it
 * found, then keeps the token fresh until {@link stopDeviceAccessTokens}. `none` means no key is
 * stored, so nothing is sent.
 */
export async function startDeviceAccessTokens(
  from: DeviceAccessTokenSource,
): Promise<DeviceAccessTokenResult> {
  stopDeviceAccessTokens();
  source = from;

  return ask(false);
}

/** Stop and forget the token, its owner stamp and key id (sign-out, or a new sign-in starting). */
export function stopDeviceAccessTokens(): void {
  generation += 1;
  source = null;
  inFlight = null;
  clearTimer();
  expiresAt = null;
  ownerStamp = null;
  keyId = null;
  unreachableDelay = UNREACHABLE_FLOOR_MS;
  setCredential(null);
}

/** Whether requests are carrying the native side's tokens (a phone or desktop signed in with a key). */
export function deviceAccessTokensActive(): boolean {
  return source !== null;
}

/**
 * Ask the native side for a new token now, for a request that came back 401 with the one it
 * carried. Resolves with the credential to retry with: a new one, or null when there is none or
 * it is the same one (the key itself was refused, or Memory cannot be reached). At most once every
 * {@link FORCED_REFRESH_MIN_GAP_MS}, so a burst of 401s asks once.
 */
export async function refreshDeviceAccessToken(refused: string | null): Promise<string | null> {
  if (!source) {
    return null;
  }

  // A newer token than the one refused is already here: retry with it.
  if (credential && credential !== refused) {
    return credential;
  }

  if (Date.now() - lastForcedAt < FORCED_REFRESH_MIN_GAP_MS && !inFlight) {
    return null;
  }

  lastForcedAt = Date.now();
  await ask(true);

  return credential && credential !== refused ? credential : null;
}

/**
 * Make sure the token is good for at least another minute, asking if not: for the app coming back
 * into view, when timers may not have run for a while. Asks nothing while it still is.
 */
export function ensureFreshDeviceAccessToken(): void {
  if (!source || inFlight) {
    return;
  }

  if (credential && (expiresAt === null || expiresAt - Date.now() > REFRESH_AHEAD_MS)) {
    return;
  }

  void ask(false);
}

/** Called with the key id when Memory refuses the stored key, so the app can sign out. */
export function onDeviceKeyRevoked(listener: (revokedKeyId: string | null) => void): () => void {
  revokedListeners.add(listener);

  return () => revokedListeners.delete(listener);
}

/** The outbox owner stamp the native side computed for the stored key, while tokens are active. */
export function deviceOwnerStamp(): string | null {
  return source ? ownerStamp : null;
}

/** The stored key's id, while tokens are active. */
export function deviceKeyId(): string | null {
  return source ? keyId : null;
}

/** Called whenever the credential requests carry changes (a new token, a sign-out). */
export function subscribeApiKey(listener: () => void): () => void {
  listeners.add(listener);

  return () => listeners.delete(listener);
}

/**
 * Set (or clear, with null) the credential directly, with nothing kept fresh. Clearing also stops
 * the native side's tokens. Tests use it to stand in for a signed-in native shell.
 */
export function setApiKey(key: string | null): void {
  if (key === null) {
    stopDeviceAccessTokens();

    return;
  }

  setCredential(key);
}

/** The credential requests carry right now (an access token on the apps), or null on web. */
export function getApiKey(): string | null {
  return credential;
}

/**
 * Header fragment to merge into a request: `x-api-key` when a credential is active, otherwise
 * empty. Spread into any authenticated request's headers.
 */
export function apiKeyHeaders(): Record<string, string> {
  return credential ? { [API_KEY_HEADER]: credential } : {};
}
