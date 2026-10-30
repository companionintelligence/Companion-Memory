import { useCallback, useEffect, useRef, useState } from 'react';

import {
  type LocationCaptureOutcome,
  type LocationSampler,
  type LocationTrackingMode,
  type NativeLocationError,
  type NativeLocationEvent,
  BACKGROUND_MAX_ACCURACY_METERS,
  HOME_GEOFENCE_RADIUS_METERS,
  LOCATION_MODE_CHANGE_EVENT,
  LOCATION_NEEDS_SETTINGS_EVENT,
  MIN_DISTANCE_METERS,
  MIN_INTERVAL_MS,
  addAppStateListener,
  captureLocationFix,
  createLocationSampler,
  deviceSourceKey,
  fixFromNativeLocationEvent,
  getNativeLocationAuthorization,
  isIosPlatform,
  isNativePlatform,
  outboxOwnerStamp,
  publishLocationNeedsSettingsUpgrade,
  publishLocationTrackingMode,
  readLocationTrackingMode,
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
 * Native (iOS + Android) has ONE recorder, the LocalHub plugin's background monitor, and it
 * runs only in `always`: on iOS, significant-change monitoring, which records a real move and
 * stays quiet while the phone sits still; on Android, motion-gated sampling, where the fixes
 * and an exit geofence decide when the phone is moving and GPS runs only then. Both queue
 * each fix natively, so recording goes on after the WebView is gone; the event is still
 * handed to `captureLocationFix` here, where the shared `source_id` makes the second
 * enqueue a no-op.
 *
 * There is no on-screen trail. `when_in_use` on native records nothing on its own: a current
 * location is fetched on request (`getCurrentDeviceLocation`) when a note or photo needs one.
 * The foreground watcher that used to provide one came from
 * `@capacitor-community/background-geolocation`, whose once-per-second GPS request never
 * stopped when the app left the screen and which our own location foreground service kept
 * alive on Android, doubling every trip's trail and undoing the battery saving.
 *
 * Plain web records nothing either (its browser trail went the same day, for the same
 * reason): a browser has no background monitor, and the one thing worth a location there,
 * placing a note or photo, asks for a single high-accuracy fix on demand through
 * `getCurrentDeviceLocation`.
 *
 * Consent is per-device (localStorage). Settings → Location owns the disclosure.
 */
export function useLocationTracking(options: { watch?: boolean } = {}) {
  const { watch = true } = options;
  const [{ authToken, authenticated }] = useAuth();
  const [mode, setModeState] = useState<LocationTrackingMode>(() => readLocationTrackingMode());
  const [lastOutcome, setLastOutcome] = useState<LocationCaptureOutcome | null>(null);
  const [needsSettingsUpgrade, setNeedsSettingsUpgrade] = useState(false);

  // The same 150 m / 5 min gate the native side applies before it queues a fix; here it
  // only keeps the web-side re-enqueue of an already-queued fix from being attempted.
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

  // Native (iOS + Android): the background monitor is the only recorder, and only in Always.
  // Web never starts this, and records nothing of its own.
  useEffect(() => {
    if (!watch) {
      return;
    }

    if (mode !== 'always' || !authenticated || !isNativePlatform()) {
      setNeedsSettingsUpgrade(false);
      publishLocationNeedsSettingsUpgrade(false);

      return;
    }

    let cancelled = false;
    let stopSignificant: (() => Promise<void>) | null = null;

    const onLocation = (location: NativeLocationEvent) => {
      if (cancelled) {
        return;
      }

      void captureLocationFix(fixFromNativeLocationEvent(location), {
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

    const onError = (error: NativeLocationError) => {
      if (!cancelled && error.code === 'NOT_AUTHORIZED') {
        setNeedsSettingsUpgrade(true);
        publishLocationNeedsSettingsUpgrade(true);
      }
    };

    void (async () => {
      // Android 13+ requires POST_NOTIFICATIONS before the tracking notification (the OS's
      // price of admission for a location foreground service; shown only while the phone is
      // moving) can show. iOS Always does not post that notification.
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

      // Both platforms: the LocalHub tracker is the background recorder and builds the wire
      // record natively from exactly what captureLocationFix would use here, so a record it
      // queues with no WebView alive and this hook's re-enqueue of the same fix share a
      // source_id. Android walks its own prompts (fine, then Allow all the time) inside this
      // call and arms the motion-gated tracker; iOS arms significant-change monitoring plus
      // a resume geofence, restarted by the app delegate on every launch. The notification
      // text is for Android's moving-only foreground service; iOS accepts and ignores it.
      stopSignificant = await startSignificantLocationUpdates(
        {
          deviceKey: deviceSourceKey(),
          provider: 'companion-mobile',
          owner: outboxOwnerStamp(),
          minDistanceMeters: MIN_DISTANCE_METERS,
          minIntervalMs: MIN_INTERVAL_MS,
          maxAccuracyMeters: BACKGROUND_MAX_ACCURACY_METERS,
          geofenceRadiusMeters: HOME_GEOFENCE_RADIUS_METERS,
          notificationTitle: 'Recording location',
          notificationText: 'Companion records your location while you are on the move.',
        },
        onLocation,
        onError,
      );

      if (cancelled) {
        void stopSignificant?.();
      }
    })();

    return () => {
      cancelled = true;
      void stopSignificant?.();
      samplerRef.current?.reset();
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
