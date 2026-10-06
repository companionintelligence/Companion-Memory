import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { isLocationTrackingEnabled, useLocationTracking } from './useLocationTracking';

const STORAGE_KEY = 'ci-location-tracking-enabled';

const h = vi.hoisted(() => ({
  authToken: null as string | null,
  authenticated: false,
  isNativePlatform: vi.fn(() => false),
  isIosPlatform: vi.fn(() => false),
  captureLocationFix: vi.fn(),
  createLocationSampler: vi.fn(),
  addBackgroundLocationWatcher: vi.fn(),
  removeBackgroundLocationWatcher: vi.fn(),
  startSignificantLocationUpdates: vi.fn(),
  addAppStateListener: vi.fn(),
  requestNotificationPermission: vi.fn(),
  getNativeLocationAuthorization: vi.fn(),
  requestNativeLocationAuthorization: vi.fn(),
}));

vi.mock('./useAuth', () => ({
  useAuth: () => [{ authToken: h.authToken, authenticated: h.authenticated }, {}],
}));

// The @ci/common seams useLocationTracking pulls on, overridden over the real module so
// nothing rendered here loses an unrelated export. `fixFrom*` adapters are given small
// real-ish implementations (rather than bare mocks) so the fix objects reaching
// `captureLocationFix` reflect the position/location passed to the callback — that's the
// seam this hook actually owns.
vi.mock('@ci/common', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@ci/common')>()),
  captureLocationFix: h.captureLocationFix,
  createLocationSampler: h.createLocationSampler,
  fixFromGeolocationPosition: (position: GeolocationPosition) => ({
    latitude: position.coords.latitude,
    longitude: position.coords.longitude,
    capturedAtMs: position.timestamp,
  }),
  fixFromBackgroundGeolocationLocation: (location: {
    latitude: number;
    longitude: number;
    time: number;
  }) => ({
    latitude: location.latitude,
    longitude: location.longitude,
    capturedAtMs: location.time,
  }),
  isNativePlatform: h.isNativePlatform,
  isIosPlatform: h.isIosPlatform,
  addBackgroundLocationWatcher: h.addBackgroundLocationWatcher,
  removeBackgroundLocationWatcher: h.removeBackgroundLocationWatcher,
  startSignificantLocationUpdates: h.startSignificantLocationUpdates,
  addAppStateListener: h.addAppStateListener,
  requestNotificationPermission: h.requestNotificationPermission,
  getNativeLocationAuthorization: h.getNativeLocationAuthorization,
  requestNativeLocationAuthorization: h.requestNativeLocationAuthorization,
}));

interface FakeSampler {
  shouldCapture: ReturnType<typeof vi.fn>;
  accept: ReturnType<typeof vi.fn>;
  reset: ReturnType<typeof vi.fn>;
  last: null;
}

function newSampler(): FakeSampler {
  return { shouldCapture: vi.fn(() => true), accept: vi.fn(), reset: vi.fn(), last: null };
}

function fakePosition(): GeolocationPosition {
  return {
    coords: {
      latitude: 37.7749,
      longitude: -122.4194,
      accuracy: 10,
      altitude: null,
      altitudeAccuracy: null,
      heading: null,
      speed: null,
    },
    timestamp: 1_723_500_000_000,
  } as unknown as GeolocationPosition;
}

function fakeBackgroundLocation() {
  return {
    latitude: 37.7749,
    longitude: -122.4194,
    accuracy: 10,
    altitude: null,
    altitudeAccuracy: null,
    bearing: null,
    speed: null,
    time: 1_723_500_000_000,
  };
}

type GeoSuccess = (position: GeolocationPosition) => void;

/** Installs a fake `navigator.geolocation`, configurable so each test can start clean. */
function installGeolocation() {
  const getCurrentPosition = vi.fn();
  const watchPosition = vi.fn(() => 42);
  const clearWatch = vi.fn();

  Object.defineProperty(globalThis.navigator, 'geolocation', {
    value: { getCurrentPosition, watchPosition, clearWatch },
    configurable: true,
    writable: true,
  });

  return { getCurrentPosition, watchPosition, clearWatch };
}

/** The success callback the hook registered with `getCurrentPosition`, i.e. its `send`. */
function successCallbackOf(getCurrentPosition: ReturnType<typeof vi.fn>): GeoSuccess {
  const calls = getCurrentPosition.mock.calls as unknown as Array<[GeoSuccess, ...unknown[]]>;

  return calls[0][0];
}

beforeEach(() => {
  localStorage.clear();
  h.authToken = null;
  h.authenticated = false;
  h.isNativePlatform.mockReset();
  h.isNativePlatform.mockReturnValue(false);
  h.isIosPlatform.mockReset();
  h.isIosPlatform.mockReturnValue(false);
  h.captureLocationFix.mockReset();
  h.captureLocationFix.mockResolvedValue({ status: 'queued', record: {}, id: 'row-1' });
  h.createLocationSampler.mockReset();
  h.createLocationSampler.mockImplementation(newSampler);
  h.addBackgroundLocationWatcher.mockReset();
  h.addBackgroundLocationWatcher.mockResolvedValue('watcher-1');
  h.removeBackgroundLocationWatcher.mockReset();
  h.removeBackgroundLocationWatcher.mockResolvedValue(undefined);
  h.startSignificantLocationUpdates.mockReset();
  h.startSignificantLocationUpdates.mockResolvedValue(async () => {});
  h.addAppStateListener.mockReset();
  h.addAppStateListener.mockResolvedValue(() => {});
  h.requestNotificationPermission.mockReset();
  h.requestNotificationPermission.mockResolvedValue(true);
  h.getNativeLocationAuthorization.mockReset();
  h.getNativeLocationAuthorization.mockResolvedValue('notDetermined');
  h.requestNativeLocationAuthorization.mockReset();
  h.requestNativeLocationAuthorization.mockResolvedValue('whenInUse');
});

afterEach(() => {
  // Unmount any still-watching hook (via the shared setup.ts `cleanup()`) BEFORE removing
  // `navigator.geolocation` below — its own effect cleanup calls `clearWatch` on it, and
  // hook-teardown ordering across files is not something this file controls.
  cleanup();
  Reflect.deleteProperty(globalThis.navigator, 'geolocation');
  localStorage.clear();
});

describe('isLocationTrackingEnabled', () => {
  it('defaults to false with nothing persisted', () => {
    expect(isLocationTrackingEnabled()).toBe(false);
  });

  it('is true only for the literal stored string "true"', () => {
    localStorage.setItem(STORAGE_KEY, 'true');
    expect(isLocationTrackingEnabled()).toBe(true);

    localStorage.setItem(STORAGE_KEY, 'yes');
    expect(isLocationTrackingEnabled()).toBe(false);
  });
});

describe('useLocationTracking — the enable/disable consent toggle', () => {
  it('persists the choice to localStorage under the per-device key and reflects it immediately', () => {
    const { result } = renderHook(() => useLocationTracking({ watch: false }));

    expect(result.current.enabled).toBe(false);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();

    act(() => result.current.setEnabled(true));

    expect(result.current.enabled).toBe(true);
    expect(localStorage.getItem(STORAGE_KEY)).toBe('true');

    act(() => result.current.setEnabled(false));

    expect(result.current.enabled).toBe(false);
    expect(result.current.mode).toBe('off');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('false');
  });

  it('migrates a stored "true" to when_in_use, not always', () => {
    localStorage.setItem(STORAGE_KEY, 'true');

    const { result } = renderHook(() => useLocationTracking({ watch: false }));

    expect(result.current.enabled).toBe(true);
    expect(result.current.mode).toBe('when_in_use');
  });

  it('downgrades always to when_in_use on web', () => {
    h.isNativePlatform.mockReturnValue(false);
    const { result } = renderHook(() => useLocationTracking({ watch: false }));

    act(() => result.current.setMode('always'));

    expect(result.current.mode).toBe('when_in_use');
  });

  it('keeps always on native (iOS or Android)', () => {
    h.isNativePlatform.mockReturnValue(true);
    const { result } = renderHook(() => useLocationTracking({ watch: false }));

    act(() => result.current.setMode('always'));

    expect(result.current.mode).toBe('always');
  });

  it('reads a choice persisted by a previous session on mount', () => {
    localStorage.setItem(STORAGE_KEY, 'true');

    const { result } = renderHook(() => useLocationTracking({ watch: false }));

    expect(result.current.enabled).toBe(true);
  });
});

describe('useLocationTracking — cross-instance sync', () => {
  it('a toggle in one instance (the settings screen) is reflected in another (the app-level watcher)', () => {
    const settingsToggle = renderHook(() => useLocationTracking({ watch: false }));
    const appWatcher = renderHook(() => useLocationTracking({ watch: false }));

    expect(appWatcher.result.current.enabled).toBe(false);

    act(() => settingsToggle.result.current.setEnabled(true));

    // Neither instance called the other directly — this only works if the CustomEvent
    // dispatched by setEnabled is actually picked up by the other instance's listener.
    expect(appWatcher.result.current.enabled).toBe(true);
    expect(settingsToggle.result.current.enabled).toBe(true);

    act(() => appWatcher.result.current.setEnabled(false));

    expect(settingsToggle.result.current.enabled).toBe(false);
  });
});

describe('useLocationTracking — watch gating', () => {
  it('does not touch geolocation while disabled', () => {
    const { getCurrentPosition } = installGeolocation();
    h.authenticated = true;

    renderHook(() => useLocationTracking());

    expect(getCurrentPosition).not.toHaveBeenCalled();
  });

  it('does not touch geolocation when not authenticated, even if enabled', () => {
    localStorage.setItem(STORAGE_KEY, 'true');
    const { getCurrentPosition } = installGeolocation();
    h.authenticated = false;

    renderHook(() => useLocationTracking());

    expect(getCurrentPosition).not.toHaveBeenCalled();
  });

  it('does not watch for an instance that opted out with watch:false, even if enabled and authenticated', () => {
    localStorage.setItem(STORAGE_KEY, 'true');
    const { getCurrentPosition } = installGeolocation();
    h.authenticated = true;

    renderHook(() => useLocationTracking({ watch: false }));

    expect(getCurrentPosition).not.toHaveBeenCalled();
  });

  it('gates on `authenticated`, not `authToken` — native has no JWT and must still watch', () => {
    localStorage.setItem(STORAGE_KEY, 'true');
    const { getCurrentPosition, watchPosition } = installGeolocation();
    h.authenticated = true;
    h.authToken = null;

    renderHook(() => useLocationTracking());

    expect(getCurrentPosition).toHaveBeenCalledTimes(1);
    expect(watchPosition).toHaveBeenCalledTimes(1);
  });
});

describe('useLocationTracking — recording a fix (web)', () => {
  it('captures the immediate fix as a browser-provided position and surfaces the outcome', async () => {
    localStorage.setItem(STORAGE_KEY, 'true');
    const { getCurrentPosition } = installGeolocation();
    h.authenticated = true;
    h.authToken = 'jwt-token';
    h.isNativePlatform.mockReturnValue(false);

    const { result } = renderHook(() => useLocationTracking());

    await act(async () => {
      successCallbackOf(getCurrentPosition)(fakePosition());
    });

    expect(h.captureLocationFix).toHaveBeenCalledTimes(1);
    const calls = h.captureLocationFix.mock.calls as unknown as Array<
      [{ latitude: number; longitude: number }, Record<string, unknown>]
    >;
    const [fix, options] = calls[0];

    expect(fix).toMatchObject({ latitude: 37.7749, longitude: -122.4194 });
    expect(options).toMatchObject({ authToken: 'jwt-token', provider: 'browser' });

    await waitFor(() =>
      expect(result.current.lastOutcome).toEqual({ status: 'queued', record: {}, id: 'row-1' }),
    );
  });

  it('does not surface a throttled outcome as the last outcome', async () => {
    localStorage.setItem(STORAGE_KEY, 'true');
    const { getCurrentPosition } = installGeolocation();
    h.authenticated = true;
    h.captureLocationFix.mockResolvedValue({ status: 'throttled' });

    const { result } = renderHook(() => useLocationTracking());

    await act(async () => {
      successCallbackOf(getCurrentPosition)(fakePosition());
    });

    expect(result.current.lastOutcome).toBeNull();
  });

  it('swallows a rejected capture rather than throwing out of the watch callback', async () => {
    localStorage.setItem(STORAGE_KEY, 'true');
    const { getCurrentPosition } = installGeolocation();
    h.authenticated = true;
    h.captureLocationFix.mockRejectedValue(new Error('sidecar unreachable'));

    const { result } = renderHook(() => useLocationTracking());

    await act(async () => {
      successCallbackOf(getCurrentPosition)(fakePosition());
    });

    expect(result.current.lastOutcome).toBeNull();
  });
});

describe('useLocationTracking — the cancelled-effect race guard', () => {
  it('drops a getCurrentPosition result that resolves after tracking was disabled mid-flight', async () => {
    // The permission prompt behind getCurrentPosition can take a long time — long enough
    // that the user flips the toggle off before the browser ever calls back. That answer
    // must not resurrect a fix for a toggle the user already turned off.
    localStorage.setItem(STORAGE_KEY, 'true');
    const { getCurrentPosition } = installGeolocation();
    h.authenticated = true;

    const { result } = renderHook(() => useLocationTracking());
    const pendingSuccess = successCallbackOf(getCurrentPosition);

    act(() => result.current.setEnabled(false));

    await act(async () => {
      pendingSuccess(fakePosition());
    });

    expect(h.captureLocationFix).not.toHaveBeenCalled();
  });
});

describe('useLocationTracking — cleanup (web)', () => {
  it('clears the platform watch and resets the sampler gate when tracking is turned off', () => {
    localStorage.setItem(STORAGE_KEY, 'true');
    const { watchPosition, clearWatch } = installGeolocation();
    h.authenticated = true;

    const sampler = newSampler();
    h.createLocationSampler.mockReturnValue(sampler);

    const { result } = renderHook(() => useLocationTracking());

    expect(watchPosition).toHaveBeenCalledTimes(1);
    const watchId = watchPosition.mock.results[0]?.value as number;

    act(() => result.current.setEnabled(false));

    expect(clearWatch).toHaveBeenCalledWith(watchId);
    expect(sampler.reset).toHaveBeenCalledTimes(1);
  });
});

describe('useLocationTracking — native watcher is the only writer', () => {
  it('does not start navigator.geolocation on native; it starts the background watcher instead', async () => {
    localStorage.setItem(STORAGE_KEY, 'true');
    const { getCurrentPosition, watchPosition } = installGeolocation();
    h.authenticated = true;
    h.isNativePlatform.mockReturnValue(true);

    renderHook(() => useLocationTracking());

    await waitFor(() => expect(h.addBackgroundLocationWatcher).toHaveBeenCalled());

    expect(getCurrentPosition).not.toHaveBeenCalled();
    expect(watchPosition).not.toHaveBeenCalled();
    expect(h.addBackgroundLocationWatcher.mock.calls[0][0]).toMatchObject({ background: false });
  });

  it('starts a background watcher and requests notification permission for Always', async () => {
    localStorage.setItem(STORAGE_KEY, 'true');
    h.authenticated = true;
    h.isNativePlatform.mockReturnValue(true);

    const { result } = renderHook(() => useLocationTracking());

    act(() => result.current.setMode('always'));

    await waitFor(() =>
      expect(h.addBackgroundLocationWatcher).toHaveBeenLastCalledWith(
        expect.objectContaining({ background: true }),
        expect.any(Function),
        expect.any(Function),
      ),
    );
    expect(h.requestNotificationPermission).toHaveBeenCalled();
    expect(h.startSignificantLocationUpdates).not.toHaveBeenCalled();
  });

  it('on iOS asks When In Use then Always before starting the background watcher', async () => {
    localStorage.setItem(STORAGE_KEY, 'true');
    h.authenticated = true;
    h.isNativePlatform.mockReturnValue(true);
    h.isIosPlatform.mockReturnValue(true);
    h.getNativeLocationAuthorization.mockResolvedValue('notDetermined');
    h.requestNativeLocationAuthorization.mockResolvedValueOnce('whenInUse').mockResolvedValueOnce('always');

    const { result } = renderHook(() => useLocationTracking());

    act(() => result.current.setMode('always'));

    await waitFor(() =>
      expect(h.addBackgroundLocationWatcher).toHaveBeenLastCalledWith(
        expect.objectContaining({ background: false, requestPermissions: false }),
        expect.any(Function),
        expect.any(Function),
      ),
    );
    expect(h.startSignificantLocationUpdates).toHaveBeenCalled();
    expect(h.requestNotificationPermission).not.toHaveBeenCalled();
    expect(h.requestNativeLocationAuthorization).toHaveBeenNthCalledWith(1, { always: false });
    expect(h.requestNativeLocationAuthorization).toHaveBeenNthCalledWith(2, { always: true });
    expect(result.current.needsSettingsUpgrade).toBe(false);
  });

  it('on iOS records a significant move and stops monitoring when Always turns off', async () => {
    localStorage.setItem(STORAGE_KEY, 'true');
    h.authenticated = true;
    h.isNativePlatform.mockReturnValue(true);
    h.isIosPlatform.mockReturnValue(true);
    h.getNativeLocationAuthorization.mockResolvedValue('always');

    const stop = vi.fn(async () => {});
    let deliver: ((location: ReturnType<typeof fakeBackgroundLocation>) => void) | undefined;

    h.startSignificantLocationUpdates.mockImplementation(async (onLocation) => {
      deliver = onLocation;

      return stop;
    });

    const { result } = renderHook(() => useLocationTracking());

    act(() => result.current.setMode('always'));

    await waitFor(() => expect(h.startSignificantLocationUpdates).toHaveBeenCalled());

    await act(async () => {
      deliver?.(fakeBackgroundLocation());
    });

    expect(h.captureLocationFix).toHaveBeenCalled();

    act(() => result.current.setMode('off'));

    await waitFor(() => expect(stop).toHaveBeenCalled());
  });

  it('on iOS shows Open Settings when Always is requested but the OS stays on When In Use', async () => {
    localStorage.setItem(STORAGE_KEY, 'true');
    h.authenticated = true;
    h.isNativePlatform.mockReturnValue(true);
    h.isIosPlatform.mockReturnValue(true);
    h.getNativeLocationAuthorization.mockResolvedValue('whenInUse');
    h.requestNativeLocationAuthorization.mockResolvedValue('whenInUse');

    const { result } = renderHook(() => useLocationTracking());

    act(() => result.current.setMode('always'));

    await waitFor(() => expect(result.current.needsSettingsUpgrade).toBe(true));
    expect(h.addBackgroundLocationWatcher).toHaveBeenCalled();
  });

  it('shares needsSettingsUpgrade with a settings instance that is not watching', async () => {
    localStorage.setItem(STORAGE_KEY, 'true');
    h.authenticated = true;
    h.isNativePlatform.mockReturnValue(true);
    h.isIosPlatform.mockReturnValue(true);
    h.getNativeLocationAuthorization.mockResolvedValue('whenInUse');
    h.requestNativeLocationAuthorization.mockResolvedValue('whenInUse');

    const settings = renderHook(() => useLocationTracking({ watch: false }));
    const watcher = renderHook(() => useLocationTracking());

    act(() => watcher.result.current.setMode('always'));

    await waitFor(() => expect(settings.result.current.needsSettingsUpgrade).toBe(true));
  });

  it('clears Open Settings on the settings page when tracking is turned off', async () => {
    localStorage.setItem(STORAGE_KEY, 'true');
    h.authenticated = true;
    h.isNativePlatform.mockReturnValue(true);
    h.isIosPlatform.mockReturnValue(true);
    h.getNativeLocationAuthorization.mockResolvedValue('whenInUse');
    h.requestNativeLocationAuthorization.mockResolvedValue('whenInUse');

    const settings = renderHook(() => useLocationTracking({ watch: false }));
    const watcher = renderHook(() => useLocationTracking());

    act(() => watcher.result.current.setMode('always'));
    await waitFor(() => expect(settings.result.current.needsSettingsUpgrade).toBe(true));

    act(() => watcher.result.current.setMode('off'));
    await waitFor(() => expect(settings.result.current.needsSettingsUpgrade).toBe(false));
  });

  it('feeds a delivered location into captureLocationFix tagged as companion-mobile', async () => {
    localStorage.setItem(STORAGE_KEY, 'true');
    h.authenticated = true;
    h.isNativePlatform.mockReturnValue(true);

    let deliver: ((location: ReturnType<typeof fakeBackgroundLocation>) => void) | undefined;

    h.addBackgroundLocationWatcher.mockImplementation(async (_options, onLocation) => {
      deliver = onLocation;

      return 'watcher-1';
    });

    renderHook(() => useLocationTracking());

    await waitFor(() => expect(h.addBackgroundLocationWatcher).toHaveBeenCalled());

    await act(async () => {
      deliver?.(fakeBackgroundLocation());
    });

    expect(h.captureLocationFix).toHaveBeenCalledTimes(1);
    const calls = h.captureLocationFix.mock.calls as unknown as Array<
      [{ latitude: number; longitude: number }, Record<string, unknown>]
    >;
    const [fix, options] = calls[0];

    expect(fix).toMatchObject({ latitude: 37.7749, longitude: -122.4194 });
    expect(options).toMatchObject({ provider: 'companion-mobile' });
  });

  it('removes the watcher on unmount', async () => {
    localStorage.setItem(STORAGE_KEY, 'true');
    h.authenticated = true;
    h.isNativePlatform.mockReturnValue(true);
    h.addBackgroundLocationWatcher.mockResolvedValue('watcher-xyz');

    const { unmount } = renderHook(() => useLocationTracking());

    await waitFor(() => expect(h.addBackgroundLocationWatcher).toHaveBeenCalled());

    unmount();

    await waitFor(() => expect(h.removeBackgroundLocationWatcher).toHaveBeenCalledWith('watcher-xyz'));
  });

  it('sets needsSettingsUpgrade when the watcher reports NOT_AUTHORIZED', async () => {
    localStorage.setItem(STORAGE_KEY, 'true');
    h.authenticated = true;
    h.isNativePlatform.mockReturnValue(true);

    let deliverError: ((error: { code: string; message: string }) => void) | undefined;

    h.addBackgroundLocationWatcher.mockImplementation(async (_options, _onLocation, onError) => {
      deliverError = onError;

      return 'watcher-1';
    });

    const { result } = renderHook(() => useLocationTracking());

    await waitFor(() => expect(h.addBackgroundLocationWatcher).toHaveBeenCalled());

    await act(async () => {
      deliverError?.({ code: 'NOT_AUTHORIZED', message: 'denied' });
    });

    expect(result.current.needsSettingsUpgrade).toBe(true);
  });
});
