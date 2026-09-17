import { waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { registerNativePushToken } from './registerNativePushToken';

const h = vi.hoisted(() => ({
  isNativePlatform: vi.fn(() => false),
}));

vi.mock('@ci/common', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@ci/common')>();

  return {
    ...actual,
    isNativePlatform: h.isNativePlatform,
  };
});

afterEach(() => {
  h.isNativePlatform.mockReturnValue(false);
  vi.unstubAllGlobals();
  delete (window as unknown as { Capacitor?: unknown }).Capacitor;
});

function stubCapacitor(capacitor: unknown) {
  vi.stubGlobal('Capacitor', capacitor);
  (window as unknown as { Capacitor: unknown }).Capacitor = capacitor;
}

describe('registerNativePushToken', () => {
  it('is a no-op on web', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    await registerNativePushToken();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('registers the token and POSTs /api/devices on iOS', async () => {
    h.isNativePlatform.mockReturnValue(true);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ device_id: 'dev-1' }),
    });
    vi.stubGlobal('fetch', fetchMock);
    window.fetch = fetchMock as typeof fetch;

    const remove = vi.fn();
    const register = vi.fn().mockResolvedValue(undefined);
    const requestPermissions = vi.fn().mockResolvedValue({ receive: 'granted' });
    const addListener = vi.fn(async (_event: string, cb: (token: { value: string }) => void) => {
      cb({ value: 'apns-token' });

      return { remove };
    });

    stubCapacitor({
      getPlatform: () => 'ios',
      Plugins: { PushNotifications: { requestPermissions, register, addListener } },
    });

    await registerNativePushToken();

    await waitFor(() => {
      expect(register).toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalled();
    });
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(JSON.parse(String(init?.body)).push_token).toBe('apns-token');
  });

  it('skips Android register when FCM is not configured (avoids process crash)', async () => {
    h.isNativePlatform.mockReturnValue(true);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const register = vi.fn().mockResolvedValue(undefined);
    const requestPermissions = vi.fn().mockResolvedValue({ receive: 'granted' });
    const addListener = vi.fn();
    const isConfigured = vi.fn().mockResolvedValue({ configured: false });

    stubCapacitor({
      getPlatform: () => 'android',
      Plugins: {
        PushNotifications: { requestPermissions, register, addListener },
        FcmStatus: { isConfigured },
      },
    });

    await registerNativePushToken();

    expect(isConfigured).toHaveBeenCalled();
    expect(requestPermissions).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('skips Android register when FcmStatus plugin is missing', async () => {
    h.isNativePlatform.mockReturnValue(true);
    const register = vi.fn().mockResolvedValue(undefined);
    const requestPermissions = vi.fn().mockResolvedValue({ receive: 'granted' });

    stubCapacitor({
      getPlatform: () => 'android',
      Plugins: { PushNotifications: { requestPermissions, register, addListener: vi.fn() } },
    });

    await registerNativePushToken();

    expect(requestPermissions).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
  });

  it('registers on Android when FCM is configured', async () => {
    h.isNativePlatform.mockReturnValue(true);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ device_id: 'dev-android' }),
    });
    vi.stubGlobal('fetch', fetchMock);
    window.fetch = fetchMock as typeof fetch;

    const remove = vi.fn();
    const register = vi.fn().mockResolvedValue(undefined);
    const requestPermissions = vi.fn().mockResolvedValue({ receive: 'granted' });
    const addListener = vi.fn(async (_event: string, cb: (token: { value: string }) => void) => {
      cb({ value: 'fcm-token' });

      return { remove };
    });
    const isConfigured = vi.fn().mockResolvedValue({ configured: true });

    stubCapacitor({
      getPlatform: () => 'android',
      Plugins: {
        PushNotifications: { requestPermissions, register, addListener },
        FcmStatus: { isConfigured },
      },
    });

    await registerNativePushToken();

    await waitFor(() => {
      expect(register).toHaveBeenCalled();
      expect(fetchMock).toHaveBeenCalled();
    });
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(JSON.parse(String(init?.body)).push_token).toBe('fcm-token');
  });
});
