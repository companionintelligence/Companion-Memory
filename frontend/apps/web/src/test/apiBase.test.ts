import {
  buildApiUrl,
  clearPersistedApiBaseUrl,
  getApiBaseUrl,
  initApiBaseUrl,
  isIosPlatform,
  isLocalApplianceOrigin,
  isNativePlatform,
  needsNativeCloudConnect,
  persistApiBaseUrl,
  resolveHttpOrigin,
  setApiBaseUrl,
  subscribeApiBaseUrl,
} from '@ci/common/src/utils/apiBase';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// Minimal stand-ins for the native Capacitor runtime + Web Storage, used to
// exercise the native code paths from the node test environment.
interface FakeWindow {
  Capacitor?: { isNativePlatform: () => boolean; getPlatform?: () => string };
  localStorage: Pick<Storage, 'getItem' | 'removeItem' | 'setItem'>;
}

function installFakeWindow(opts: {
  native: boolean;
  platform?: string;
  stored?: string | null;
}): Map<string, string> {
  const store = new Map<string, string>();

  if (opts.stored != null) {
    store.set('ci.apiBaseUrl', opts.stored);
  }

  const platform = opts.platform;
  const fakeWindow: FakeWindow = {
    Capacitor: {
      isNativePlatform: () => opts.native,
      ...(platform ? { getPlatform: () => platform } : {}),
    },
    localStorage: {
      getItem: (key) => store.get(key) ?? null,
      removeItem: (key) => {
        store.delete(key);
      },
      setItem: (key, value) => {
        store.set(key, value);
      },
    },
  };

  (globalThis as unknown as { window?: unknown }).window = fakeWindow;

  return store;
}

describe('apiBase — origin resolution', () => {
  beforeEach(() => {
    // Reset the module singleton to the web default before each case.
    setApiBaseUrl('');
  });

  it('defaults to same-origin so relative paths are unchanged', () => {
    expect(getApiBaseUrl()).toBe('');
    expect(buildApiUrl('/api/graphql')).toBe('/api/graphql');
  });

  it('prefixes the configured origin and strips a trailing slash', () => {
    setApiBaseUrl('https://ci.example.com/');

    expect(getApiBaseUrl()).toBe('https://ci.example.com');
    expect(buildApiUrl('/api/graphql')).toBe('https://ci.example.com/api/graphql');
  });

  it('resetting to empty restores same-origin behavior', () => {
    setApiBaseUrl('https://ci.example.com');
    setApiBaseUrl('');

    expect(buildApiUrl('/api/x')).toBe('/api/x');
  });

  it('passes absolute URLs through untouched (e.g. signed media URLs)', () => {
    setApiBaseUrl('https://ci.example.com');

    expect(buildApiUrl('https://minio.example.com/file.png')).toBe('https://minio.example.com/file.png');
    expect(buildApiUrl('http://other.host/x')).toBe('http://other.host/x');
  });
});

describe('apiBase — native detection + persistence', () => {
  const hadWindow = 'window' in globalThis;

  afterEach(() => {
    if (!hadWindow) {
      delete (globalThis as unknown as { window?: unknown }).window;
    }

    setApiBaseUrl('');
  });

  it('isNativePlatform() is false without a Capacitor runtime', () => {
    delete (globalThis as unknown as { window?: unknown }).window;

    expect(isNativePlatform()).toBe(false);
  });

  it('isNativePlatform() reflects Capacitor.isNativePlatform()', () => {
    installFakeWindow({ native: true });
    expect(isNativePlatform()).toBe(true);

    installFakeWindow({ native: false });
    expect(isNativePlatform()).toBe(false);
  });

  it('isIosPlatform() is true only on native iOS', () => {
    delete (globalThis as unknown as { window?: unknown }).window;
    expect(isIosPlatform()).toBe(false);

    installFakeWindow({ native: true, platform: 'android' });
    expect(isIosPlatform()).toBe(false);

    installFakeWindow({ native: true, platform: 'ios' });
    expect(isIosPlatform()).toBe(true);
  });

  it('initApiBaseUrl() is a no-op when not native (web keeps same-origin)', () => {
    delete (globalThis as unknown as { window?: unknown }).window;
    // Simulate a stale in-memory value; init must not clobber it on web.
    setApiBaseUrl('https://leftover.example.com');

    initApiBaseUrl();

    expect(getApiBaseUrl()).toBe('https://leftover.example.com');
  });

  it('initApiBaseUrl() loads the stored origin on native', () => {
    installFakeWindow({ native: true, stored: 'https://stored.example.com' });
    setApiBaseUrl('');

    initApiBaseUrl();

    expect(getApiBaseUrl()).toBe('https://stored.example.com');
    expect(buildApiUrl('/api/graphql')).toBe('https://stored.example.com/api/graphql');
  });

  it('persistApiBaseUrl() writes the normalized origin to localStorage and applies it', () => {
    const store = installFakeWindow({ native: true });

    persistApiBaseUrl('https://new.example.com/');

    expect(getApiBaseUrl()).toBe('https://new.example.com');
    expect(store.get('ci.apiBaseUrl')).toBe('https://new.example.com');
  });

  it('clearPersistedApiBaseUrl() forgets a paired origin so iOS returns to the device picker', () => {
    const store = installFakeWindow({ native: true, platform: 'ios', stored: 'https://core7.example.com' });
    setApiBaseUrl('https://core7.example.com');

    clearPersistedApiBaseUrl();

    expect(getApiBaseUrl()).toBe('');
    expect(store.has('ci.apiBaseUrl')).toBe(false);
    expect(needsNativeCloudConnect()).toBe(true);
  });

  it('subscribeApiBaseUrl() notifies when the origin changes', () => {
    const seen: string[] = [];
    const stop = subscribeApiBaseUrl(() => seen.push(getApiBaseUrl()));

    setApiBaseUrl('https://memory.example.com');
    setApiBaseUrl('https://memory.example.com');
    setApiBaseUrl('https://other.example.com');
    stop();
    setApiBaseUrl('https://ignored.example.com');

    expect(seen).toEqual(['https://memory.example.com', 'https://other.example.com']);
  });

  it('resolveHttpOrigin() prefixes a bare hostname so iOS never sees a relative URL', () => {
    expect(resolveHttpOrigin('ci-memory-core7.example.com')).toBe('https://ci-memory-core7.example.com');
    expect(resolveHttpOrigin('https://memory.example.com/app?x=1')).toBe('https://memory.example.com');
    expect(resolveHttpOrigin('http://192.168.1.9:8642/')).toBe('http://192.168.1.9:8642');
    expect(() => resolveHttpOrigin('ftp://memory.example.com')).toThrow(/http or https/i);
    expect(() => resolveHttpOrigin('not a url')).toThrow(/not a valid/i);
  });

  it('isLocalApplianceOrigin() flags docker / LAN leftovers, not a Hub Memory URL', () => {
    expect(isLocalApplianceOrigin('')).toBe(true);
    expect(isLocalApplianceOrigin('http://localhost:64669')).toBe(true);
    expect(isLocalApplianceOrigin('https://ci-server.localhost')).toBe(true);
    expect(isLocalApplianceOrigin('http://memory.local')).toBe(true);
    expect(isLocalApplianceOrigin('https://memory.example.com')).toBe(false);
  });

  it('needsNativeCloudConnect() is always on for iOS until a non-local Memory origin is set', () => {
    installFakeWindow({ native: true, platform: 'ios' });
    setApiBaseUrl('');
    expect(needsNativeCloudConnect()).toBe(true);

    setApiBaseUrl('https://ci-server.localhost');
    expect(needsNativeCloudConnect()).toBe(true);

    setApiBaseUrl('https://memory.example.com');
    expect(needsNativeCloudConnect()).toBe(false);
  });

  it('needsNativeCloudConnect() on Android only fires when no origin is set', () => {
    installFakeWindow({ native: true, platform: 'android' });
    setApiBaseUrl('');
    expect(needsNativeCloudConnect()).toBe(true);

    setApiBaseUrl('http://localhost:64669');
    expect(needsNativeCloudConnect()).toBe(false);
  });

  it('needsNativeCloudConnect() is false on web', () => {
    delete (globalThis as unknown as { window?: unknown }).window;
    setApiBaseUrl('');
    expect(needsNativeCloudConnect()).toBe(false);
  });
});
