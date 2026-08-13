import { useCallback, useEffect, useRef, useState } from 'react';

import {
  type LocationCaptureOutcome,
  type LocationSampler,
  captureLocationFix,
  createLocationSampler,
  fixFromGeolocationPosition,
  isNativePlatform,
} from '@ci/common';

import { useAuth } from './useAuth';

const STORAGE_KEY = 'ci-location-tracking-enabled';
/** Keeps multiple hook instances (app-level watcher + settings toggle) in sync. */
const CHANGE_EVENT = 'ci:location-tracking-changed';

export function isLocationTrackingEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}

/**
 * Location tracking (issue #1811, LifeScope's location-tracking feature rebuilt):
 * while enabled, watches the platform geolocation and records fixes into
 * ci.position, throttled to meaningful movement (>=50 m) or a 5-minute
 * heartbeat — deliberately better than LifeScope's one-snapshot-per-page-visit.
 *
 * The sampling gate, the wire record and the delivery path all live in
 * `@ci/common` (`utils/deviceSources/location.ts`), because this is the first
 * **device-native ETL source** and every later one repeats the shape. This hook
 * is only the browser-geolocation adapter plus the enable toggle. Notably, on
 * native the capture goes through the durable outbox first — a fix taken with no
 * connectivity is committed to on-device SQLite before `captureLocationFix`
 * resolves, and is delivered whenever the appliance is next reachable.
 *
 * The enable flag is per-device (localStorage): location consent is a property
 * of the device, not the account. Toggled from Settings -> Location.
 */
export function useLocationTracking(options: { watch?: boolean } = {}) {
  const { watch = true } = options;
  const [{ authToken, authenticated }] = useAuth();
  const [enabled, setEnabledState] = useState<boolean>(() => isLocationTrackingEnabled());
  const [lastOutcome, setLastOutcome] = useState<LocationCaptureOutcome | null>(null);

  // One gate per hook instance, surviving re-renders. Only the watching instance
  // ever consults it; the settings instance passes `watch: false`.
  const samplerRef = useRef<LocationSampler | null>(null);

  samplerRef.current ??= createLocationSampler();

  const setEnabled = useCallback((value: boolean) => {
    try {
      localStorage.setItem(STORAGE_KEY, value ? 'true' : 'false');
    } catch {
      // Storage unavailable (private mode) — session-only toggle still works.
    }

    setEnabledState(value);
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: value }));
  }, []);

  // The settings toggle and the app-level watcher are separate hook instances;
  // sync them through the change event.
  useEffect(() => {
    const onChange = (event: Event) => {
      setEnabledState(Boolean((event as CustomEvent).detail));
    };

    window.addEventListener(CHANGE_EVENT, onChange);

    return () => window.removeEventListener(CHANGE_EVENT, onChange);
  }, []);

  useEffect(() => {
    // Gate on `authenticated`, NOT on authToken: the native shell authenticates
    // with an API key (fetchJson attaches x-api-key itself) and never populates
    // a JWT, so an authToken gate would silently disable tracking on mobile.
    if (!watch || !enabled || !authenticated || typeof navigator === 'undefined' || !navigator.geolocation) {
      return;
    }

    // The one-shot getCurrentPosition below can resolve long after the effect
    // is torn down (it blocks on the permission prompt), so a disabled toggle
    // must not still record a fix.
    let cancelled = false;
    const sampler = samplerRef.current;

    const send = (position: GeolocationPosition) => {
      if (cancelled) {
        return;
      }

      void captureLocationFix(fixFromGeolocationPosition(position), {
        sampler: sampler ?? undefined,
        authToken,
        // Distinguishes a fix recorded by the phone from one recorded by a
        // desktop browser; both are the user's own devices, stored verbatim.
        provider: isNativePlatform() ? 'companion-mobile' : 'browser',
      })
        .then((outcome) => {
          if (!cancelled && outcome.status !== 'throttled') {
            setLastOutcome(outcome);
          }
        })
        .catch(() => {
          // captureLocationFix reports failures in its result rather than
          // throwing; this is belt-and-braces so a watch callback never rejects.
        });
    };

    // One immediate fix so enabling has a visible effect, then a watch.
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
      // Re-enabling should record straight away rather than wait out a
      // heartbeat left over from the previous session.
      sampler?.reset();
    };
  }, [watch, enabled, authenticated, authToken]);

  return { enabled, setEnabled, lastOutcome };
}
