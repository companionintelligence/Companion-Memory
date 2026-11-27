import {
  secureStorageGet,
  secureStorageSet,
  syncNativeIntentConfig,
} from '@ci/common/src/utils/nativeBridge';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Two seams the existing `nativeBridge.test.ts` never reaches.
 *
 * 1. `syncNativeIntentConfig` — untested anywhere, yet it is the ONLY link between the
 *    webview's configured server and the native Apple App Intents (Siri / Shortcuts /
 *    Spotlight). Those run OUTSIDE the webview and cannot read `localStorage`, so they
 *    read the server origin from the Keychain, which only this function writes. If it
 *    stops mirroring, every Siri phrase fails; if it stops CLEARING, they keep talking
 *    to a server the user has already left.
 *
 * 2. The half-native state: `isNativePlatform()` is true but a plugin is missing. Every
 *    existing test stubs the runtime and the plugin together, so nothing exercises the
 *    case where Capacitor is present but `SecureStoragePlugin` failed to register.
 */

type GlobalWithWindow = { window?: unknown };

function setWindow(value: unknown): void {
  (globalThis as GlobalWithWindow).window = value;
}

function fakeLocalStorage(initial: Record<string, string> = {}) {
  const store = new Map<string, string>(Object.entries(initial));

  return {
    store,
    ls: {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
      removeItem: (key: string) => void store.delete(key),
    },
  };
}

/** A native runtime whose SecureStoragePlugin can be selectively withheld. */
function nativeWindow({ withPlugin = true, localStorage: initial = {} } = {}) {
  const keychain = new Map<string, string>();
  const { store, ls } = fakeLocalStorage(initial);

  const SecureStoragePlugin = {
    get: vi.fn(async ({ key }: { key: string }) => {
      if (!keychain.has(key)) {
        throw new Error('not found');
      }

      return { value: keychain.get(key) };
    }),
    set: vi.fn(async ({ key, value }: { key: string; value: string }) => {
      keychain.set(key, value);

      return { value: true };
    }),
    remove: vi.fn(async ({ key }: { key: string }) => {
      keychain.delete(key);

      return { value: true };
    }),
  };

  setWindow({
    Capacitor: {
      isNativePlatform: () => true,
      Plugins: withPlugin ? { SecureStoragePlugin } : {},
    },
    localStorage: ls,
  });

  return { keychain, localStorage: store, SecureStoragePlugin };
}

const BASE_URL_KEY = 'ci.apiBaseUrl';

afterEach(() => {
  delete (globalThis as GlobalWithWindow).window;
  vi.restoreAllMocks();
});

describe('syncNativeIntentConfig — mirrors the server origin into the keystore for App Intents', () => {
  it('copies the configured server origin from localStorage into the keystore', async () => {
    const { keychain } = nativeWindow({ localStorage: { [BASE_URL_KEY]: 'https://ci.example.com' } });

    await syncNativeIntentConfig();

    expect(keychain.get(BASE_URL_KEY)).toBe('https://ci.example.com');
  });

  it('CLEARS the keystore copy when the server is unset, so Siri cannot use a stale server', async () => {
    const { keychain, SecureStoragePlugin } = nativeWindow();
    // A previous sync left a server behind; the user has since cleared it.
    keychain.set(BASE_URL_KEY, 'https://old.example.com');

    await syncNativeIntentConfig();

    expect(SecureStoragePlugin.remove).toHaveBeenCalledWith({ key: BASE_URL_KEY });
    expect(keychain.has(BASE_URL_KEY)).toBe(false);
  });

  it('re-mirrors the new origin after the user switches servers', async () => {
    const { keychain, localStorage } = nativeWindow({
      localStorage: { [BASE_URL_KEY]: 'https://first.example.com' },
    });

    await syncNativeIntentConfig();
    expect(keychain.get(BASE_URL_KEY)).toBe('https://first.example.com');

    localStorage.set(BASE_URL_KEY, 'https://second.example.com');
    await syncNativeIntentConfig();

    expect(keychain.get(BASE_URL_KEY)).toBe('https://second.example.com');
  });

  it('is inert on web — there are no App Intents to configure', async () => {
    const { store, ls } = fakeLocalStorage({ [BASE_URL_KEY]: 'https://ci.example.com' });
    setWindow({ localStorage: ls });

    await syncNativeIntentConfig();

    // Must not mirror into localStorage under a different key or otherwise mutate it.
    expect([...store.entries()]).toEqual([[BASE_URL_KEY, 'https://ci.example.com']]);
  });

  it('never rejects when the keystore write fails (best-effort by design)', async () => {
    const { SecureStoragePlugin } = nativeWindow({
      localStorage: { [BASE_URL_KEY]: 'https://ci.example.com' },
    });
    SecureStoragePlugin.set.mockRejectedValueOnce(new Error('keychain locked'));

    // App Intents simply stay unconfigured; this must not take down the caller
    // (`useNativeShell` runs it on mount and on every appStateChange).
    await expect(syncNativeIntentConfig()).resolves.toBeUndefined();
  });
});

describe('secure storage in the HALF-NATIVE state (plugin missing)', () => {
  /**
   * ⚠️ Documents CURRENT behavior, which is a real weakness rather than a desired
   * property: `secureStorageSet` guards on `isNativePlatform() && secure`, so when the
   * app is native but SecureStoragePlugin failed to register, it falls through to the
   * WEB branch and writes to webview `localStorage`.
   *
   * That path stores the long-lived API key (`useAuth` mints one at login and keeps it
   * as the native credential) outside the Keychain, where it is readable by any script
   * in the webview and is not protected by device-level key storage. It fails SILENTLY:
   * login still succeeds, so nothing surfaces the downgrade.
   *
   * Pinned here so the behavior is visible and any future hardening is a deliberate,
   * reviewed change rather than an accident.
   */
  it('falls back to webview localStorage instead of the Keychain — silent credential downgrade', async () => {
    const { keychain, localStorage } = nativeWindow({ withPlugin: false });

    await secureStorageSet('ci.apiKey', 'super-secret-key');

    expect(keychain.size).toBe(0);
    expect(localStorage.get('ci.apiKey')).toBe('super-secret-key');
    // The page never reads the device key back, from any store, so this read is null. Other
    // values still round-trip, so the app cannot tell it was downgraded.
    expect(await secureStorageGet('ci.apiKey')).toBeNull();
    await secureStorageSet('ci.apiKeyId', 'key-id');
    expect(localStorage.get('ci.apiKeyId')).toBe('key-id');
    expect(await secureStorageGet('ci.apiKeyId')).toBe('key-id');
  });

  it('does not leak the value into localStorage when the plugin IS present', async () => {
    const { keychain, localStorage } = nativeWindow({ withPlugin: true });

    await secureStorageSet('ci.apiKey', 'super-secret-key');

    expect(keychain.get('ci.apiKey')).toBe('super-secret-key');
    expect(localStorage.has('ci.apiKey')).toBe(false);
  });
});
