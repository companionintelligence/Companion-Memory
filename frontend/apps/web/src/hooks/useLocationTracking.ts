import { useCallback, useEffect, useRef, useState } from 'react';

import {
  type BackgroundGeolocationError,
  type LocationCaptureOutcome,
  type LocationSampler,
  type LocationTrackingMode,
  BACKGROUND_MAX_ACCURACY_METERS,
  LOCATION_MODE_CHANGE_EVENT,
  LOCATION_NEEDS_SETTINGS_EVENT,
  MIN_DISTANCE_METERS,
  MIN_INTERVAL_MS,
  addAppStateListener,
  addBackgroundLocationWatcher,
  captureLocationFix,
  createLocationSampler,
  deviceSourceKey,
  fixFromBackgroundGeolocationLocation,
  fixFromGeolocationPosition,
  getNativeLocationAuthorization,
  isIosPlatform,
  isNativePlatform,
  outboxOwnerStamp,
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
 * Native (iOS + Android) `when_in_use` uses `@capacitor-community/background-geolocation`
 * as a foreground-only watcher. `always` differs per platform. Android hands recording to
 * the LocalHub plugin's own location foreground service: started from the screen, it keeps
 * sampling after the app leaves the foreground AND after it is swiped out of recents (the
 * community plugin's bound service stopped with the activity), queues each fix natively so
 * nothing depends on this WebView, and delivers the fix here too -- the shared `source_id`
 * makes the second enqueue a no-op. No community watcher runs in Android Always. iOS Always
 * keeps the foreground watcher and adds significant-change monitoring, which records a real
 * move and stays quiet while the phone sits still, without the solid blue indicator. Plain
 * web falls back to `navigator.geolocation`.
 *
 * Consent is per-device (localStorage). Settings → Location owns the disclosure.
 */
export function useLocationTracking(options: { watch?: boolean } = {}) {
  const { watch = true } = options;
  const [{ authToken, authenticated }] = useAuth();
  const [mode, setModeState] = useState<LocationTrackingMode>(() => readLocationTrackingMode());
  const [lastOutcome, setLastOutcome] = useState<LocationCaptureOutcome | null>(null);
  const [needsSettingsUpgrade, setNeedsSettingsUpgrade] = useState(false);

  // One gate (150 m or 5 min) whether the app is on screen or not; a denser trail while
  // the app happens to be open adds nothing.
  const samplerRef = useRef<LocationSampler | null>(null);
  const modeRef = useRef(mode);
  modeRef.current = mode;

  samplerRef.current ??= createLocationSampler();

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

  // iOS: when the app comes back to the screen in Always mode, re-check the grant so Open
  // Settings appears if it was lowered in Settings while the app was away.
  useEffect(() => {
    if (!watch || !isNativePlatform()) {
      return;
    }

    let unsubscribe: (() => void) | undefined;
    let cancelled = false;

    void addAppStateListener((isActive) => {
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

      void captureLocationFix(fixFromBackgroundGeolocationLocation(location), {
        sampler: samplerRef.current ?? undefined,
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

      if (mode === 'always' && !isIosPlatform()) {
        // Android Always: the LocalHub service is the one recorder (see the hook docs). It
        // prompts for location itself. The options are exactly what captureLocationFix would
        // use here, so a record built natively and this hook's re-enqueue share a source_id.
        stopSignificant = await startSignificantLocationUpdates(
          {
            deviceKey: deviceSourceKey(),
            provider: 'companion-mobile',
            owner: outboxOwnerStamp(),
            minDistanceMeters: MIN_DISTANCE_METERS,
            minIntervalMs: MIN_INTERVAL_MS,
            maxAccuracyMeters: BACKGROUND_MAX_ACCURACY_METERS,
            notificationTitle: 'Recording location',
            notificationText: 'Companion is recording your location so it can place memories on the map.',
          },
          onLocation,
          onError,
        );

        if (cancelled) {
          void stopSignificant?.();
        }

        return;
      }

      const id = await addBackgroundLocationWatcher(
        {
          // Foreground-only on this plugin, in every mode that reaches it. iOS Always's
          // background samples go through significant-change monitoring below, which does
          // not hold the blue pill; Android Always never gets here.
          background: false,
          distanceFilter: MIN_DISTANCE_METERS,
          // iOS Always is requested above so the plugin does not skip the second prompt.
          requestPermissions: !(mode === 'always' && isIosPlatform()),
        },
        onLocation,
        onError,
      );

      if (mode === 'always' && isIosPlatform()) {
        stopSignificant = await startSignificantLocationUpdates(
          { deviceKey: deviceSourceKey(), provider: 'companion-mobile', owner: outboxOwnerStamp() },
          onLocation,
          onError,
        );
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
