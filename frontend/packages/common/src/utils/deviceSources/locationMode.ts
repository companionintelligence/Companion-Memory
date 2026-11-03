/**
 * Per-device location-consent mode. Off / while-using / always (background).
 *
 * Stored on the device, not the account — the same rule as the old boolean toggle.
 * `always` is native-only (iOS and Android); web treats it as `when_in_use`.
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

/** Settings page watches this so Open Settings appears after Always is not granted. */
export const LOCATION_NEEDS_SETTINGS_EVENT = 'ci:location-needs-settings';

/**
 * Fixes looser than this in the background are dropped, not queued. The persist gate itself
 * is the one in `location.ts` (`MIN_DISTANCE_METERS` / `MIN_INTERVAL_MS`): since 2026-10-14
 * the background has no looser gate of its own.
 */
export const BACKGROUND_MAX_ACCURACY_METERS = 200;

/**
 * Exit geofence around the spot where the phone came to rest (Android background sampling).
 * The smallest radius Play Services evaluates dependably; it is the one still-to-moving
 * signal there, so its radius plus the evaluation latency is the unsampled start of every
 * trip. iOS sizes its own resume region from `MIN_DISTANCE_METERS` and ignores this.
 */
export const HOME_GEOFENCE_RADIUS_METERS = 100;

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

export function publishLocationNeedsSettingsUpgrade(needs: boolean): void {
  if (typeof window === 'undefined') {
    return;
  }

  window.dispatchEvent(new CustomEvent(LOCATION_NEEDS_SETTINGS_EVENT, { detail: needs }));
}
