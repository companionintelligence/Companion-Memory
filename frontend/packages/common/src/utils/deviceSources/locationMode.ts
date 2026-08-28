/**
 * Per-device location-consent mode. Off / while-using / always (background).
 *
 * Stored on the device, not the account — the same rule as the old boolean toggle.
 * `always` is an iOS capability; Android and web treat it as `when_in_use`.
 *
 * The legacy key `ci-location-tracking-enabled` is still written so older readers
 * do not silently disable a user who already opted in. Reading prefers the new
 * key, then migrates `true` → `when_in_use` (never to `always`).
 */

export type LocationTrackingMode = 'off' | 'when_in_use' | 'always';

export const LOCATION_TRACKING_MODES = ['off', 'when_in_use', 'always'] as const;

export const LOCATION_MODE_STORAGE_KEY = 'ci-location-tracking-mode';

/** Legacy boolean key from the on/off toggle. Still written for back-compat. */
export const LOCATION_ENABLED_STORAGE_KEY = 'ci-location-tracking-enabled';

/** Keeps the settings screen and the app-level watcher on the same mode. */
export const LOCATION_MODE_CHANGE_EVENT = 'ci:location-tracking-changed';

/** Background persist gate — looser than the foreground 50 m / 5 min sampler. */
export const BACKGROUND_MIN_DISTANCE_METERS = 150;

export const BACKGROUND_MIN_INTERVAL_MS = 10 * 60 * 1000;

/** Fixes looser than this in the background are dropped, not queued. */
export const BACKGROUND_MAX_ACCURACY_METERS = 200;

/** Home-exit geofence. House-scale, not a city block. */
export const HOME_GEOFENCE_RADIUS_METERS = 200;

export function isLocationTrackingMode(value: unknown): value is LocationTrackingMode {
  return value === 'off' || value === 'when_in_use' || value === 'always';
}

export function readLocationTrackingMode(): LocationTrackingMode {
  try {
    const stored = window.localStorage.getItem(LOCATION_MODE_STORAGE_KEY);

    if (isLocationTrackingMode(stored)) {
      return stored;
    }

    if (window.localStorage.getItem(LOCATION_ENABLED_STORAGE_KEY) === 'true') {
      return 'when_in_use';
    }
  } catch {
    // Private mode — session default is off.
  }

  return 'off';
}

export function writeLocationTrackingMode(mode: LocationTrackingMode): void {
  try {
    window.localStorage.setItem(LOCATION_MODE_STORAGE_KEY, mode);
    window.localStorage.setItem(LOCATION_ENABLED_STORAGE_KEY, mode === 'off' ? 'false' : 'true');
  } catch {
    // Session-only; the in-memory hook state still updates.
  }
}

export function isLocationTrackingEnabled(): boolean {
  return readLocationTrackingMode() !== 'off';
}

export function publishLocationTrackingMode(mode: LocationTrackingMode): void {
  if (typeof window === 'undefined') {
    return;
  }

  window.dispatchEvent(new CustomEvent(LOCATION_MODE_CHANGE_EVENT, { detail: mode }));
}
