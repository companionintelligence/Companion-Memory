import { useCallback, useEffect, useRef, useState } from 'react';

import {
  type BackgroundGeolocationError,
  type LocationCaptureOutcome,
  type LocationSampler,
  type LocationTrackingMode,
  BACKGROUND_MIN_DISTANCE_METERS,
  BACKGROUND_MIN_INTERVAL_MS,
  LOCATION_MODE_CHANGE_EVENT,
  LOCATION_NEEDS_SETTINGS_EVENT,
  MIN_DISTANCE_METERS,
  addAppStateListener,
  addBackgroundLocationWatcher,
  captureLocationFix,
  createLocationSampler,
  fixFromBackgroundGeolocationLocation,
  fixFromGeolocationPosition,
  getNativeLocationAuthorization,
  isIosPlatform,
  isNativePlatform,
  publishLocationNeedsSettingsUpgrade,
  publishLocationTrackingMode,
  readLocationTrackingMode,
  removeBackgroundLocationWatcher,
  requestNativeLocationAuthorization,
  startSignificantLocationUpdates,
  requestNotificationPermission,
  writeLocationTrackingMode,
} from '@ci/common';

import { useAuth } from './useAuth';

export { isLocationTrackingEnabled } from '@ci/common';

/**
 * iOS 13+ will not grant Always from `notDetermined` in one shot — it shows
 * When In Use first. Ask that, then escalate. Returns whether Always is held.
 */
async function ensureIosAlwaysAuthorization(): Promise<boolean> {
  let status = await getNativeLocationAuthorization();

  if (status === 'always') {
    return true;
  }

  if (status === 'denied' || status === 'restricted') {
    return false;
  }

  if (status === 'notDetermined') {
    status = await requestNativeLocationAuthorization({ always: false });
  }

  if (status === 'always') {
    return true;
  }

  if (status === 'whenInUse') {
    status = await requestNativeLocationAuthorization({ always: true });
  }

  return status === 'always';
}

/**
 * Location tracking: records `ci.position` fixes from this device.
 *
 * Native (iOS + Android) uses `@capacitor-community/background-geolocation` as the one
 * writer, gated by `mode`: `when_in_use` starts a foreground-only watcher. `always` on
 * Android adds a `backgroundMessage` so the OS keeps sampling after the app leaves the
 * foreground (the persistent notification Android requires). `always` on iOS does not:
 * that flag turns on the solid blue indicator for the whole background session. iOS
 * instead starts significant-change monitoring, which records a real move and stays
 * quiet while the phone sits still. Plain web falls back to `navigator.geolocation`.
 *
 * Consent is per-device (localStorage). Settings → Location owns the disclosure.
 */
export function useLocationTracking(options: { watch?: boolean } = {}) {
  const { watch = true } = options;
  const [{ authToken, authenticated }] = useAuth();
  const [mode, setModeState] = useState<LocationTrackingMode>(() => readLocationTrackingMode());
  const [lastOutcome, setLastOutcome] = useState<LocationCaptureOutcome | null>(null);
  const [needsSettingsUpgrade, setNeedsSettingsUpgrade] = useState(false);

  const samplerRef = useRef<LocationSampler | null>(null);
  const backgroundSamplerRef = useRef<LocationSampler | null>(null);
  const isActiveRef = useRef(true);
  const modeRef = useRef(mode);
  modeRef.current = mode;

  samplerRef.current ??= createLocationSampler();
  backgroundSamplerRef.current ??= createLocationSampler({
    minDistanceMeters: BACKGROUND_MIN_DISTANCE_METERS,
    minIntervalMs: BACKGROUND_MIN_INTERVAL_MS,
  });

  const setMode = useCallback((next: LocationTrackingMode) => {
    const resolved: LocationTrackingMode = next === 'always' && !isNativePlatform() ? 'when_in_use' : next;

    writeLocationTrackingMode(resolved);
    setModeState(resolved);
    publishLocationTrackingMode(resolved);
  }, []);

  const setEnabled = useCallback(
    (value: boolean) => {
      setMode(value ? 'when_in_use' : 'off');
    },
    [setMode],
  );

  useEffect(() => {
    const onChange = (event: Event) => {
      const detail = (event as CustomEvent<LocationTrackingMode>).detail;

      if (detail === 'off' || detail === 'when_in_use' || detail === 'always') {
        setModeState(detail);
      }
    };

    window.addEventListener(LOCATION_MODE_CHANGE_EVENT, onChange);

    return () => window.removeEventListener(LOCATION_MODE_CHANGE_EVENT, onChange);
  }, []);

  useEffect(() => {
    const onNeeds = (event: Event) => {
      const detail = (event as CustomEvent<boolean>).detail;

      if (typeof detail === 'boolean') {
        setNeedsSettingsUpgrade(detail);
      }
    };

    window.addEventListener(LOCATION_NEEDS_SETTINGS_EVENT, onNeeds);

    return () => window.removeEventListener(LOCATION_NEEDS_SETTINGS_EVENT, onNeeds);
  }, []);

  const enabled = mode !== 'off';

  // Tracks foreground/background so the watcher callback can pick the right sampling
  // gate — the OS keeps delivering fixes on the same watcher across the transition.
  useEffect(() => {
    if (!watch || !isNativePlatform()) {
      return;
    }

    let unsubscribe: (() => void) | undefined;
    let cancelled = false;

    void addAppStateListener((isActive) => {
      isActiveRef.current = isActive;

      if (!isActive || modeRef.current !== 'always' || !isIosPlatform()) {
        return;
      }

      void getNativeLocationAuthorization().then((status) => {
        const needs = status !== 'always';
        setNeedsSettingsUpgrade(needs);
        publishLocationNeedsSettingsUpgrade(needs);
      });
    }).then((fn) => {
      if (cancelled) {
        void fn();

        return;
      }

      unsubscribe = fn;
    });

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [watch]);

  // Native watcher — one writer for iOS + Android. Web never starts this; it uses
  // navigator.geolocation below instead.
  useEffect(() => {
    if (!watch) {
      return;
    }

    if (mode === 'off' || !authenticated || !isNativePlatform()) {
      setNeedsSettingsUpgrade(false);
      publishLocationNeedsSettingsUpgrade(false);

      return;
    }

    let cancelled = false;
    let watcherId: string | null = null;
    let stopSignificant: (() => Promise<void>) | null = null;

    const onLocation = (location: Parameters<typeof fixFromBackgroundGeolocationLocation>[0]) => {
      if (cancelled) {
        return;
      }

      const activeSampler = isActiveRef.current ? samplerRef.current : backgroundSamplerRef.current;

      void captureLocationFix(fixFromBackgroundGeolocationLocation(location), {
        sampler: activeSampler ?? undefined,
        authToken,
        provider: 'companion-mobile',
      })
        .then((outcome) => {
          if (!cancelled && outcome.status !== 'throttled') {
            setLastOutcome(outcome);
          }
        })
        .catch(() => {
          // captureLocationFix reports failures in its result rather than throwing.
        });
    };

    const onError = (error: BackgroundGeolocationError) => {
      if (!cancelled && error.code === 'NOT_AUTHORIZED') {
        setNeedsSettingsUpgrade(true);
        publishLocationNeedsSettingsUpgrade(true);
      }
    };

    void (async () => {
      if (mode === 'always') {
        // Android 13+ requires POST_NOTIFICATIONS before the persistent tracking
        // notification (the OS's price of admission for background sampling) can show.
        // iOS Always does not post that notification.
        if (!isIosPlatform()) {
          await requestNotificationPermission();
        }

        if (isIosPlatform()) {
          const granted = await ensureIosAlwaysAuthorization();

          if (cancelled) {
            return;
          }

          setNeedsSettingsUpgrade(!granted);
          publishLocationNeedsSettingsUpgrade(!granted);
        }
      } else {
        setNeedsSettingsUpgrade(false);
        publishLocationNeedsSettingsUpgrade(false);
      }

      const id = await addBackgroundLocationWatcher(
        {
          // iOS Always stays foreground-only on this plugin. Background samples go
          // through significant-change monitoring, which does not hold the blue pill.
          background: mode === 'always' && !isIosPlatform(),
          distanceFilter: mode === 'always' ? BACKGROUND_MIN_DISTANCE_METERS : MIN_DISTANCE_METERS,
          // iOS Always is requested above so the plugin does not skip the second prompt.
          requestPermissions: mode === 'always' ? !isIosPlatform() : true,
        },
        onLocation,
        onError,
      );

      if (mode === 'always' && isIosPlatform()) {
        stopSignificant = await startSignificantLocationUpdates(onLocation, onError);
      }

      if (cancelled) {
        if (id) {
          void removeBackgroundLocationWatcher(id);
        }

        void stopSignificant?.();

        return;
      }

      watcherId = id;
    })();

    return () => {
      cancelled = true;

      if (watcherId) {
        void removeBackgroundLocationWatcher(watcherId);
      }

      void stopSignificant?.();

      samplerRef.current?.reset();
      backgroundSamplerRef.current?.reset();
    };
  }, [watch, mode, authenticated, authToken]);

  // Web-only foreground watcher. Native (iOS + Android) never starts this — the
  // background-geolocation watcher above owns sampling there.
  useEffect(() => {
    if (
      !watch ||
      mode === 'off' ||
      !authenticated ||
      isNativePlatform() ||
      typeof navigator === 'undefined' ||
      !navigator.geolocation
    ) {
      return;
    }

    let cancelled = false;
    const sampler = samplerRef.current;

    const send = (position: GeolocationPosition) => {
      if (cancelled) {
        return;
      }

      void captureLocationFix(fixFromGeolocationPosition(position), {
        sampler: sampler ?? undefined,
        authToken,
        provider: 'browser',
      })
        .then((outcome) => {
          if (!cancelled && outcome.status !== 'throttled') {
            setLastOutcome(outcome);
          }
        })
        .catch(() => {
          // captureLocationFix reports failures in its result rather than throwing.
        });
    };

    navigator.geolocation.getCurrentPosition(send, () => undefined, {
      enableHighAccuracy: false,
      maximumAge: 60_000,
      timeout: 15_000,
    });

    const watchId = navigator.geolocation.watchPosition(send, () => undefined, {
      enableHighAccuracy: false,
      maximumAge: 60_000,
    });

    return () => {
      cancelled = true;
      navigator.geolocation.clearWatch(watchId);
      sampler?.reset();
    };
  }, [watch, mode, authenticated, authToken]);

  return {
    mode,
    setMode,
    enabled,
    setEnabled,
    lastOutcome,
    needsSettingsUpgrade,
  };
}
