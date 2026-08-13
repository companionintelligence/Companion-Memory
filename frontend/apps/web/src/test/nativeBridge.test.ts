import {
  addAppUrlOpenListener,
  addBackButtonListener,
  exitApp,
  hasNotificationPermission,
  hideSplashScreen,
  openExternalUrl,
  requestNotificationPermission,
  scheduleLocalNotification,
  secureStorageGet,
  secureStorageRemove,
  secureStorageSet,
  setStatusBarStyle,
} from '@ci/common/src/utils/nativeBridge';
import { afterEach, describe, expect, it, vi } from 'vitest';

type GlobalWithWindow = { window?: unknown };

function setWindow(value: unknown): void {
  (globalThis as GlobalWithWindow).window = value;
}

afterEach(() => {
  delete (globalThis as GlobalWithWindow).window;
});

describe('nativeBridge — web (no Capacitor) falls back to localStorage', () => {
  function fakeLocalStorage() {
    const store = new Map<string, string>();

    return {
      store,
      ls: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => {
          store.set(key, value);
        },
        removeItem: (key: string) => {
          store.delete(key);
        },
      },
    };
  }

  it('set/get/remove use localStorage when not native', async () => {
    const { store, ls } = fakeLocalStorage();
    setWindow({ localStorage: ls });

    await secureStorageSet('k', 'v');
    expect(store.get('k')).toBe('v');
    expect(await secureStorageGet('k')).toBe('v');

    await secureStorageRemove('k');
    expect(await secureStorageGet('k')).toBeNull();
  });

  it('openExternalUrl navigates via location.assign on web', async () => {
    const assign = vi.fn();
    setWindow({ location: { assign } });

    await openExternalUrl('https://example.com/x');

    expect(assign).toHaveBeenCalledWith('https://example.com/x');
  });
});

describe('nativeBridge — native uses the Capacitor plugins', () => {
  function fakeNativeWindow() {
    const secureStore = new Map<string, string>();
    const browserOpen = vi.fn(async () => {});

    const win = {
      Capacitor: {
        isNativePlatform: () => true,
        Plugins: {
          SecureStoragePlugin: {
            get: vi.fn(async ({ key }: { key: string }) => {
              if (!secureStore.has(key)) {
                throw new Error('not found');
              }

              return { value: secureStore.get(key)! };
            }),
            set: vi.fn(async ({ key, value }: { key: string; value: string }) => {
              secureStore.set(key, value);

              return { value: true };
            }),
            remove: vi.fn(async ({ key }: { key: string }) => {
              secureStore.delete(key);

              return { value: true };
            }),
          },
          Browser: { open: browserOpen },
        },
      },
    };

    return { win, secureStore, browserOpen };
  }

  it('falls back to the legacy SecureStoragePlugin on a shell without LocalHub', async () => {
    // An older native shell that predates the Local Hub plugin. The credential such an
    // install already holds must stay reachable rather than reading as "signed out".
    const { win, secureStore } = fakeNativeWindow();
    setWindow(win);

    await secureStorageSet('apiKey', 'secret');
    expect(secureStore.get('apiKey')).toBe('secret');
    expect(await secureStorageGet('apiKey')).toBe('secret');

    await secureStorageRemove('apiKey');
    // The plugin throws on a missing key — the bridge maps that to null.
    expect(await secureStorageGet('apiKey')).toBeNull();
  });

  it('openExternalUrl opens the system browser', async () => {
    const { win, browserOpen } = fakeNativeWindow();
    setWindow(win);

    await openExternalUrl('https://idp.example.com/auth');

    expect(browserOpen).toHaveBeenCalledWith({ url: 'https://idp.example.com/auth' });
  });
});

/**
 * The appliance API key moved out of `capacitor-secure-storage-plugin` — which silently
 * degrades to unencrypted Base64 on Android when Keystore init fails, and on iOS writes with
 * a keychain class that rides along in encrypted device backups — into the Local Hub plugin's
 * keystore-backed store.
 *
 * These cover the bridge half of that move. The native halves have their own on-device
 * coverage in `frontend/packages/capacitor-local-hub/android/src/androidTest/`.
 */
describe('nativeBridge — LocalHub secure storage and the migration off the legacy plugin', () => {
  function fakeHubWindow(options: { legacy?: Record<string, string>; hub?: Record<string, string> } = {}) {
    const legacyStore = new Map(Object.entries(options.legacy ?? {}));
    const hubStore = new Map(Object.entries(options.hub ?? {}));

    const legacy = {
      get: vi.fn(async ({ key }: { key: string }) => {
        if (!legacyStore.has(key)) {
          throw new Error('not found');
        }

        return { value: legacyStore.get(key)! };
      }),
      set: vi.fn(async ({ key, value }: { key: string; value: string }) => {
        legacyStore.set(key, value);

        return { value: true };
      }),
      remove: vi.fn(async ({ key }: { key: string }) => {
        legacyStore.delete(key);

        return { value: true };
      }),
    };

    const hub = {
      secureGet: vi.fn(async ({ key }: { key: string }) => ({ value: hubStore.get(key) ?? null })),
      secureSet: vi.fn(async ({ key, value }: { key: string; value: string }) => {
        hubStore.set(key, value);
      }),
      secureRemove: vi.fn(async ({ key }: { key: string }) => {
        hubStore.delete(key);
      }),
    };

    const win = {
      Capacitor: {
        isNativePlatform: () => true,
        Plugins: { LocalHub: hub, SecureStoragePlugin: legacy },
      },
    };

    return { win, hub, legacy, hubStore, legacyStore };
  }

  it('prefers LocalHub for reads and never consults the legacy plugin when it has a value', async () => {
    const { win, legacy } = fakeHubWindow({ hub: { 'ci.apiKey': 'from-keystore' } });
    setWindow(win);

    expect(await secureStorageGet('ci.apiKey')).toBe('from-keystore');
    expect(legacy.get).not.toHaveBeenCalled();
  });

  it('writes go to LocalHub and clear any stale legacy copy', async () => {
    const { win, hub, legacy, hubStore, legacyStore } = fakeHubWindow({ legacy: { 'ci.apiKey': 'old' } });
    setWindow(win);

    await secureStorageSet('ci.apiKey', 'new');

    expect(hub.secureSet).toHaveBeenCalledWith({ key: 'ci.apiKey', value: 'new' });
    expect(hubStore.get('ci.apiKey')).toBe('new');
    expect(legacy.set).not.toHaveBeenCalled();
    expect(legacyStore.has('ci.apiKey')).toBe(false);
  });

  it('migrates an existing install: reads through, rewrites into the keystore, then drops the old copy', async () => {
    const { win, hub, legacyStore, hubStore } = fakeHubWindow({
      legacy: { 'ci.apiKey': 'pre-existing-key' },
    });
    setWindow(win);

    expect(await secureStorageGet('ci.apiKey')).toBe('pre-existing-key');
    expect(hub.secureSet).toHaveBeenCalledWith({ key: 'ci.apiKey', value: 'pre-existing-key' });
    expect(hubStore.get('ci.apiKey')).toBe('pre-existing-key');
    expect(legacyStore.has('ci.apiKey')).toBe(false);

    // Second read is served from the keystore; nothing is migrated twice.
    hub.secureSet.mockClear();
    expect(await secureStorageGet('ci.apiKey')).toBe('pre-existing-key');
    expect(hub.secureSet).not.toHaveBeenCalled();
  });

  /**
   * The load-bearing ordering property. If the keystore write fails, the old copy must stay
   * exactly where it was so the next launch can retry — the value existing in two places is a
   * cosmetic problem, the value existing in none forces a full re-login against an appliance
   * URL the user may no longer remember.
   */
  it('keeps the legacy copy when the keystore write fails mid-migration', async () => {
    const { win, hub, legacy, legacyStore } = fakeHubWindow({ legacy: { 'ci.apiKey': 'pre-existing-key' } });
    hub.secureSet.mockRejectedValueOnce(new Error('keystore unavailable'));
    setWindow(win);

    expect(await secureStorageGet('ci.apiKey')).toBeNull();
    expect(legacy.remove).not.toHaveBeenCalled();
    expect(legacyStore.get('ci.apiKey')).toBe('pre-existing-key');
  });

  it('reports no value — rather than reading the weaker store — when the keystore is unusable', async () => {
    const { win, hub, legacy } = fakeHubWindow({ legacy: { 'ci.apiKey': 'pre-existing-key' } });
    hub.secureGet.mockRejectedValueOnce(new Error('keystore unavailable'));
    setWindow(win);

    // "Signed out" is recoverable and writes nothing weaker; silently falling back to the
    // plugin whose storage guarantees we just rejected would not be.
    expect(await secureStorageGet('ci.apiKey')).toBeNull();
    expect(legacy.get).not.toHaveBeenCalled();
  });

  it('propagates a failed write instead of pretending the credential was stored', async () => {
    const { win, hub } = fakeHubWindow();
    hub.secureSet.mockRejectedValueOnce(new Error('keystore unavailable'));
    setWindow(win);

    await expect(secureStorageSet('ci.apiKey', 'secret')).rejects.toThrow('keystore unavailable');
  });

  it('removal clears both stores, so sign-out cannot leave a copy in the weaker one', async () => {
    const { win, hub, legacy, hubStore, legacyStore } = fakeHubWindow({
      hub: { 'ci.apiKey': 'a' },
      legacy: { 'ci.apiKey': 'b' },
    });
    setWindow(win);

    await secureStorageRemove('ci.apiKey');

    expect(hub.secureRemove).toHaveBeenCalledWith({ key: 'ci.apiKey' });
    expect(legacy.remove).toHaveBeenCalledWith({ key: 'ci.apiKey' });
    expect(hubStore.has('ci.apiKey')).toBe(false);
    expect(legacyStore.has('ci.apiKey')).toBe(false);
  });

  it('returns null for a key neither store has, without writing anything', async () => {
    const { win, hub } = fakeHubWindow();
    setWindow(win);

    expect(await secureStorageGet('ci.apiKey')).toBeNull();
    expect(hub.secureSet).not.toHaveBeenCalled();
  });
});

describe('nativeBridge — app lifecycle (back button, exit, splash)', () => {
  function fakeShellWindow() {
    const remove = vi.fn();
    let backHandler: ((e: { canGoBack?: boolean }) => void) | undefined;
    const addListener = vi.fn(async (_event: string, listener: (e: { canGoBack?: boolean }) => void) => {
      backHandler = listener;

      return { remove };
    });
    const exit = vi.fn(async () => {});
    const splashHide = vi.fn(async () => {});

    const win = {
      Capacitor: {
        isNativePlatform: () => true,
        Plugins: {
          App: { addListener, exitApp: exit },
          SplashScreen: { hide: splashHide },
        },
      },
    };

    return { win, remove, exit, splashHide, fireBack: (canGoBack: boolean) => backHandler?.({ canGoBack }) };
  }

  it('registers the back button, forwards canGoBack, and unsubscribes', async () => {
    const { win, remove, fireBack } = fakeShellWindow();
    setWindow(win);

    const seen: boolean[] = [];
    const unsubscribe = await addBackButtonListener((canGoBack) => seen.push(canGoBack));

    fireBack(true);
    fireBack(false);
    expect(seen).toEqual([true, false]);

    unsubscribe();
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('exitApp and hideSplashScreen call the plugins', async () => {
    const { win, exit, splashHide } = fakeShellWindow();
    setWindow(win);

    await exitApp();
    await hideSplashScreen();

    expect(exit).toHaveBeenCalledTimes(1);
    expect(splashHide).toHaveBeenCalledTimes(1);
  });

  it('is inert on web: back listener is a no-op and exit/splash do not throw', async () => {
    setWindow({});

    const handler = vi.fn();
    const unsubscribe = await addBackButtonListener(handler);
    unsubscribe();

    await expect(exitApp()).resolves.toBeUndefined();
    await expect(hideSplashScreen()).resolves.toBeUndefined();
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('nativeBridge — deep links (appUrlOpen)', () => {
  function fakeUrlOpenWindow() {
    const remove = vi.fn();
    let urlHandler: ((e: { url?: string }) => void) | undefined;
    const addListener = vi.fn(async (_event: string, listener: (e: { url?: string }) => void) => {
      urlHandler = listener;

      return { remove };
    });

    const win = {
      Capacitor: {
        isNativePlatform: () => true,
        Plugins: {
          App: { addListener },
        },
      },
    };

    return { win, remove, fireUrl: (url?: string) => urlHandler?.({ url }) };
  }

  it('forwards the opened URL and unsubscribes', async () => {
    const { win, remove, fireUrl } = fakeUrlOpenWindow();
    setWindow(win);

    const seen: string[] = [];
    const unsubscribe = await addAppUrlOpenListener((url) => seen.push(url));

    fireUrl('companion://oidc/callback?code=abc123');
    expect(seen).toEqual(['companion://oidc/callback?code=abc123']);

    unsubscribe();
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it('ignores events with no url', async () => {
    const { win, fireUrl } = fakeUrlOpenWindow();
    setWindow(win);

    const handler = vi.fn();
    await addAppUrlOpenListener(handler);

    fireUrl(undefined);
    expect(handler).not.toHaveBeenCalled();
  });

  it('is inert on web: returns a no-op unsubscribe and never fires', async () => {
    setWindow({});

    const handler = vi.fn();
    const unsubscribe = await addAppUrlOpenListener(handler);
    unsubscribe();

    expect(handler).not.toHaveBeenCalled();
  });
});

describe('nativeBridge — status bar', () => {
  it('sets glyph style and Android background color via the plugin', async () => {
    const setStyle = vi.fn(async () => {});
    const setBackgroundColor = vi.fn(async () => {});
    setWindow({
      Capacitor: {
        isNativePlatform: () => true,
        Plugins: { StatusBar: { setStyle, setBackgroundColor } },
      },
    });

    await setStatusBarStyle('DARK', '#ffffff');

    expect(setStyle).toHaveBeenCalledWith({ style: 'DARK' });
    expect(setBackgroundColor).toHaveBeenCalledWith({ color: '#ffffff' });
  });

  it('skips setBackgroundColor when no color is given', async () => {
    const setStyle = vi.fn(async () => {});
    const setBackgroundColor = vi.fn(async () => {});
    setWindow({
      Capacitor: {
        isNativePlatform: () => true,
        Plugins: { StatusBar: { setStyle, setBackgroundColor } },
      },
    });

    await setStatusBarStyle('LIGHT');

    expect(setStyle).toHaveBeenCalledWith({ style: 'LIGHT' });
    expect(setBackgroundColor).not.toHaveBeenCalled();
  });

  it('is inert on web (no plugin)', async () => {
    setWindow({});

    await expect(setStatusBarStyle('DARK', '#ffffff')).resolves.toBeUndefined();
  });
});

describe('nativeBridge — local notifications', () => {
  function fakeNotificationsWindow(initialDisplay: string) {
    let display = initialDisplay;
    const checkPermissions = vi.fn(async () => ({ display }));
    const requestPermissions = vi.fn(async () => {
      display = 'granted';

      return { display };
    });
    const schedule = vi.fn(async () => ({}));

    const win = {
      Capacitor: {
        isNativePlatform: () => true,
        Plugins: { LocalNotifications: { checkPermissions, requestPermissions, schedule } },
      },
    };

    return { win, checkPermissions, requestPermissions, schedule };
  }

  it('hasNotificationPermission reflects the granted state', async () => {
    const { win } = fakeNotificationsWindow('granted');
    setWindow(win);

    expect(await hasNotificationPermission()).toBe(true);
  });

  it('requestNotificationPermission prompts only when undecided', async () => {
    const { win, requestPermissions } = fakeNotificationsWindow('prompt');
    setWindow(win);

    expect(await requestNotificationPermission()).toBe(true);
    expect(requestPermissions).toHaveBeenCalledTimes(1);
  });

  it('requestNotificationPermission does not re-prompt when already granted', async () => {
    const { win, requestPermissions } = fakeNotificationsWindow('granted');
    setWindow(win);

    expect(await requestNotificationPermission()).toBe(true);
    expect(requestPermissions).not.toHaveBeenCalled();
  });

  it('scheduleLocalNotification schedules after ensuring permission', async () => {
    const { win, schedule } = fakeNotificationsWindow('granted');
    setWindow(win);

    const ok = await scheduleLocalNotification('Hello', 'World', { id: 7 });

    expect(ok).toBe(true);
    expect(schedule).toHaveBeenCalledWith({ notifications: [{ id: 7, title: 'Hello', body: 'World' }] });
  });

  it('scheduleLocalNotification bails when permission is denied', async () => {
    const { win, schedule } = fakeNotificationsWindow('denied');
    setWindow(win);

    expect(await scheduleLocalNotification('Hi', 'There')).toBe(false);
    expect(schedule).not.toHaveBeenCalled();
  });

  it('is inert on web: returns false and never throws', async () => {
    setWindow({});

    expect(await hasNotificationPermission()).toBe(false);
    expect(await requestNotificationPermission()).toBe(false);
    expect(await scheduleLocalNotification('a', 'b')).toBe(false);
  });
});
