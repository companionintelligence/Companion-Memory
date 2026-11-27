import type { DeviceAccessTokenResult } from '@ci/common';
import { vi } from 'vitest';

/**
 * Faithful fakes of the native side that keeps the device key: the phone's LocalHub plugin and
 * Memory Desktop's keychain commands. Each behaves the way the real one does where the page can
 * tell (`frontend/packages/capacitor-local-hub` Kotlin/Swift, `src-tauri/src/device_key.rs`):
 *
 * - the device key is written once and never read back (`secureGet` / `device_secure_get_command`
 *   answer null for it);
 * - `deviceAccessToken` hands out a token that is NOT the key (`tokenFor(key)`), so a test that
 *   finds the key in a request header has found a leak;
 * - on the phone, a different `ci.apiBaseUrl` written, or the origin removed, while a key is
 *   stored removes the key, its id and its capability (the key never goes to another address).
 *
 * What Memory says about the key is the test's `verdict`, per call or per key.
 */

/** What Memory answers the native side's token request with. `hang` never answers; `reject` is an unreadable keystore. */
export type DeviceTokenVerdict = 'ok' | 'revoked' | 'unreachable' | 'legacy' | 'hang' | 'reject';

/** A verdict, or one decided per key; it may take its time, as Memory can. */
type VerdictSource = DeviceTokenVerdict | ((key: string) => DeviceTokenVerdict | Promise<DeviceTokenVerdict>);

/** The access token the fakes hand out for `key`. Never equal to the key. */
export const tokenFor = (key: string): string => `token-for:${key}`;

/** The owner stamp the fakes report for `key` at `origin` (the real one is a fingerprint; any stable value will do). */
export const stampFor = (origin: string, key: string): string => `${origin || 'same-origin'} stamp:${key}`;

/** How long the fakes' tokens work. Two minutes, so the page asks again after one. */
export const FAKE_TOKEN_TTL_MS = 120_000;

const NONE: DeviceAccessTokenResult = {
  status: 'none',
  token: null,
  expiresAt: null,
  keyId: null,
  ownerStamp: null,
};

async function verdictOf(source: VerdictSource, key: string): Promise<DeviceTokenVerdict> {
  return typeof source === 'function' ? source(key) : source;
}

/** The result for `verdict`, as the real native side builds it. */
async function answer(
  verdict: DeviceTokenVerdict,
  key: string,
  origin: string | null,
  keyId: string | null,
  ttlMs: number,
  held: Array<() => void>,
): Promise<DeviceAccessTokenResult> {
  const common = { keyId, ownerStamp: origin === null ? null : stampFor(origin, key) };

  switch (verdict) {
    case 'reject':
      throw new Error('keystore unavailable');
    case 'hang':
      await new Promise<void>((resolve) => held.push(resolve));

      return { status: 'unreachable', token: null, expiresAt: null, ...common };
    case 'legacy':
      return { status: 'legacy', token: key, expiresAt: null, ...common };
    case 'revoked':
      return { status: 'revoked', token: null, expiresAt: null, ...common };
    case 'unreachable':
      return { status: 'unreachable', token: null, expiresAt: null, ...common };
    case 'ok':
      return { status: 'ok', token: tokenFor(key), expiresAt: Date.now() + ttlMs, ...common };
  }
}

const KEY = 'ci.apiKey';
const KEY_ID = 'ci.apiKeyId';
const KEY_CAPABILITY = 'ci.apiKeyCapability';
const BASE_URL = 'ci.apiBaseUrl';

const normalize = (origin: string | null | undefined) => (origin ?? '').replace(/\/+$/, '');

export interface FakeLocalHubOptions {
  verdict?: VerdictSource;
  ttlMs?: number;
}

/** A phone's LocalHub plugin over a credential store that starts with `entries`. */
export function fakeLocalHub(entries: Iterable<[string, string]> = [], options: FakeLocalHubOptions = {}) {
  const store = new Map(entries);
  const held: Array<() => void> = [];
  let verdict: VerdictSource = options.verdict ?? 'ok';

  const dropKey = () => {
    store.delete(KEY);
    store.delete(KEY_ID);
    store.delete(KEY_CAPABILITY);
  };

  const plugin = {
    secureGet: vi.fn(async ({ key }: { key: string }) => ({
      value: key === KEY ? null : (store.get(key) ?? null),
    })),
    secureSet: vi.fn(async ({ key, value }: { key: string; value: string }) => {
      const stored = store.get(BASE_URL);

      if (key === BASE_URL && store.has(KEY) && stored && normalize(stored) !== normalize(value)) {
        dropKey();
      }

      store.set(key, value);
    }),
    secureRemove: vi.fn(async ({ key }: { key: string }) => {
      if (key === BASE_URL && store.has(KEY)) {
        dropKey();
      }

      store.delete(key);
    }),
    deviceAccessToken: vi.fn(async (_options?: { refresh?: boolean }): Promise<DeviceAccessTokenResult> => {
      const key = store.get(KEY);

      if (!key) {
        return NONE;
      }

      const origin = store.get(BASE_URL) ? normalize(store.get(BASE_URL)) : null;
      const chosen = await verdictOf(verdict, key);
      const keyId = store.get(KEY_ID) ?? null;

      // No stored origin: nowhere to ask, as the real one reports it.
      if (origin === null && (chosen === 'ok' || chosen === 'legacy')) {
        return { status: 'unreachable', token: null, expiresAt: null, keyId, ownerStamp: null };
      }

      return answer(chosen, key, origin, keyId, options.ttlMs ?? FAKE_TOKEN_TTL_MS, held);
    }),
  };

  return {
    store,
    plugin,
    setVerdict(next: VerdictSource) {
      verdict = next;
    },
    /** Let every `hang` answer through (as `unreachable`). */
    releaseHeld() {
      held.splice(0).forEach((resolve) => resolve());
    },
  };
}

/** Make `window` a Capacitor shell with `plugins` (LocalHub and any others the test needs). */
export function installNativeShell(
  plugins: Record<string, unknown>,
  platform: 'android' | 'ios' = 'android',
): void {
  (window as unknown as { Capacitor?: unknown }).Capacitor = {
    isNativePlatform: () => true,
    getPlatform: () => platform,
    Plugins: plugins,
  };
}

const DESKTOP_KEY = 'memory:ci.apiKey';
const DESKTOP_KEY_ID = 'memory:ci.apiKeyId';

export interface FakeDesktopOptions {
  verdict?: VerdictSource;
  ttlMs?: number;
  /** What `take_pending_deep_link_command` hands over once (a browser sign-in at launch). */
  deepLink?: string | null;
  /** Every keychain write is refused. */
  refuseWrites?: boolean;
  /**
   * Runs before `device_access_token_command` reads the key: await something to hold the launch
   * read back, or throw to make the keychain refuse it (which the real command reports as
   * `unreachable`). Gets how many times the key has been read.
   */
  beforeKeyRead?: (reads: number) => Promise<void> | void;
  /** A desktop app from before the device-key commands: only the plugin's `secure_*` exist. */
  olderApp?: boolean;
}

/** Memory Desktop's keychain commands over `keychain` (keys carry the `memory:` namespace). Installs itself on `window`. */
export function fakeDesktop(keychain = new Map<string, string>(), options: FakeDesktopOptions = {}) {
  const held: Array<() => void> = [];
  let verdict: VerdictSource = options.verdict ?? 'ok';
  let keyReads = 0;
  // A keychain that refused the key refuses everything until it is asked for the key again.
  let locked = false;
  let deepLink = options.deepLink ?? null;
  const notFound = (command: string) => new Error(`Command ${command} not found`);

  const invoke = vi.fn(
    async (command: string, args?: { key?: string; value?: string; refresh?: boolean }) => {
      switch (command) {
        case 'take_pending_deep_link_command': {
          const link = deepLink;

          deepLink = null;

          return link;
        }

        case 'device_secure_get_command':
          if (options.olderApp) {
            throw notFound(command);
          }

          if (locked) {
            throw new Error('secure_store_unavailable');
          }

          return { value: args?.key === DESKTOP_KEY ? null : (keychain.get(args?.key ?? '') ?? null) };
        case 'device_access_token_command': {
          if (options.olderApp) {
            throw notFound(command);
          }

          keyReads += 1;
          locked = false;

          try {
            await options.beforeKeyRead?.(keyReads);
          } catch {
            locked = true;

            return { status: 'unreachable', token: null, expiresAt: null, keyId: null, ownerStamp: null };
          }

          const key = keychain.get(DESKTOP_KEY);

          if (!key) {
            return NONE;
          }

          return answer(
            await verdictOf(verdict, key),
            key,
            '',
            keychain.get(DESKTOP_KEY_ID) ?? null,
            options.ttlMs ?? FAKE_TOKEN_TTL_MS,
            held,
          );
        }

        case 'plugin:ci-auth|secure_get':
          // Not granted to the page any more; an older app still grants it.
          if (!options.olderApp) {
            throw new Error('ci-auth.secure_get not allowed');
          }

          return { value: keychain.get(args?.key ?? '') ?? null };
        case 'plugin:ci-auth|secure_set':
          if (options.refuseWrites) {
            throw new Error('Keychain refused the write');
          }

          keychain.set(args?.key ?? '', args?.value ?? '');

          return null;
        case 'plugin:ci-auth|secure_remove':
          keychain.delete(args?.key ?? '');

          return null;
        default:
          return null;
      }
    },
  );

  (window as unknown as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = { invoke };

  return {
    keychain,
    invoke,
    setVerdict(next: VerdictSource) {
      verdict = next;
    },
    releaseHeld() {
      held.splice(0).forEach((resolve) => resolve());
    },
    /** How many times `device_access_token_command` was asked. */
    tokenRequests: () =>
      invoke.mock.calls.filter(([command]) => command === 'device_access_token_command').length,
  };
}

/** Every `x-api-key` a fetch mock was called with. */
export function sentApiKeys(fetchMock: { mock: { calls: unknown[][] } }): string[] {
  return fetchMock.mock.calls
    .map(([, init]) => (init as RequestInit | undefined)?.headers)
    .map((headers) => {
      if (!headers) {
        return undefined;
      }

      if (headers instanceof Headers) {
        return headers.get('x-api-key') ?? undefined;
      }

      const record = headers as Record<string, string>;
      const name = Object.keys(record).find((key) => key.toLowerCase() === 'x-api-key');

      return name ? record[name] : undefined;
    })
    .filter((value): value is string => typeof value === 'string');
}
