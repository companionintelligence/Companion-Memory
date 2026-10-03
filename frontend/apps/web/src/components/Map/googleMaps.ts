// Google Maps utility functions

import { fetchJson } from '@ci/common';

// Optional build-time key (local Vite). Hub-installed Memory images have no
// baked key — they resolve GOOGLE_MAPS_KEY at runtime via GET /api/config/maps.
const BUILD_TIME_GOOGLE_MAPS_API_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;

const BAKED_GOOGLE_MAPS_API_KEY: string | null =
  typeof BUILD_TIME_GOOGLE_MAPS_API_KEY === 'string' && BUILD_TIME_GOOGLE_MAPS_API_KEY.length > 0
    ? BUILD_TIME_GOOGLE_MAPS_API_KEY
    : null;

let resolvedApiKey: string | null = BAKED_GOOGLE_MAPS_API_KEY;

let resolveKeyPromise: Promise<string | null> | null = null;
let googleMapsLoadingPromise: Promise<void> | null = null;

/**
 * Test seam: the key and its in-flight lookup are module-level, so a suite that resolves it once
 * would hand every later test the first answer.
 */
export function resetGoogleMapsKeyForTests(): void {
  resolvedApiKey = BAKED_GOOGLE_MAPS_API_KEY;
  resolveKeyPromise = null;
}

/**
 * Whether to ask, and what to send when asking. `ready` is a signed-in session of either kind; the
 * headers carry a bearer only when that session has a web JWT. The native shell has none — its
 * credential is a keystore API key, which `fetchJson` attaches as `x-api-key` on its own.
 */
export interface MapsSession {
  ready: boolean;
  headers: Record<string, string>;
}

/**
 * Resolve the Maps JS API key: Vite env first, otherwise authenticated
 * GET /api/config/maps (Hub-injected GOOGLE_MAPS_KEY on the api container).
 *
 * Gated on a signed-in session, not on a web JWT: `/config/maps` is `JwtOrApiKeyAuthGuard`, and a
 * JWT-only gate left the phone's map without its route layer, silently. Asked through `fetchJson`,
 * not a bare `fetch('/api/...')`, which in the native app is the shell's own origin with no key.
 */
export async function resolveGoogleMapsApiKey(session?: MapsSession | null): Promise<string | null> {
  if (resolvedApiKey) {
    return resolvedApiKey;
  }

  if (!session?.ready) {
    return null;
  }

  if (resolveKeyPromise) {
    return resolveKeyPromise;
  }

  resolveKeyPromise = (async () => {
    try {
      const data = await fetchJson<{ configured?: boolean; apiKey?: string }>('/api/config/maps', {
        headers: session.headers,
      });

      if (data?.configured && typeof data.apiKey === 'string' && data.apiKey.trim()) {
        resolvedApiKey = data.apiKey.trim();

        return resolvedApiKey;
      }

      return null;
    } catch {
      return null;
    } finally {
      resolveKeyPromise = null;
    }
  })();

  return resolveKeyPromise;
}

/**
 * Whether a Google Maps API key is already known synchronously (Vite or a
 * previous runtime resolve). Callers that can await should prefer
 * {@link resolveGoogleMapsApiKey}.
 */
export function isGoogleMapsConfigured(): boolean {
  return typeof resolvedApiKey === 'string' && resolvedApiKey.length > 0;
}

/**
 * Load Google Maps API and return a promise that resolves when ready.
 * Pass the session so Hub-deployed Memory can fetch the key
 * from `/api/config/maps` when Vite did not bake one in.
 */
export async function loadGoogleMaps(session?: MapsSession | null): Promise<void> {
  const apiKey = await resolveGoogleMapsApiKey(session);

  if (!apiKey) {
    throw new Error(
      'Google Maps API key is not configured (VITE_GOOGLE_MAPS_API_KEY / GET /api/config/maps).',
    );
  }

  // If already loading or loaded, return the existing promise
  if (googleMapsLoadingPromise) {
    return googleMapsLoadingPromise;
  }

  // Check if already loaded
  if (
    typeof window.google !== 'undefined' &&
    window.google.maps &&
    typeof window.google.maps.DirectionsService === 'function'
  ) {
    return Promise.resolve();
  }

  // Create loading promise
  googleMapsLoadingPromise = new Promise((resolve, reject) => {
    // Check if script is already loading
    const existingScripts = document.querySelectorAll('script[src*="maps.googleapis.com"]');
    if (existingScripts.length > 0) {
      // Script is already loading, wait for it
      const checkInterval = setInterval(() => {
        if (
          typeof window.google !== 'undefined' &&
          window.google.maps &&
          typeof window.google.maps.DirectionsService === 'function'
        ) {
          clearInterval(checkInterval);
          resolve();
        }
      }, 100);

      // Timeout after 10 seconds
      setTimeout(() => {
        clearInterval(checkInterval);
        reject(new Error('Google Maps failed to load within 10 seconds'));
      }, 10000);

      return;
    }

    // Load the script
    console.log('Loading Google Maps API...');
    const script = document.createElement('script');
    script.src = `https://maps.googleapis.com/maps/api/js?key=${apiKey}&libraries=geometry`;
    script.async = true;
    script.defer = true;

    script.onload = () => {
      console.log('Google Maps script loaded successfully');
      // Wait for the API to be ready
      const checkInterval = setInterval(() => {
        if (
          typeof window.google !== 'undefined' &&
          window.google.maps &&
          typeof window.google.maps.DirectionsService === 'function'
        ) {
          clearInterval(checkInterval);
          console.log('Google Maps API is ready');
          resolve();
        }
      }, 100);

      // Timeout after 10 seconds
      setTimeout(() => {
        clearInterval(checkInterval);
        reject(new Error('Google Maps API failed to initialize within 10 seconds'));
      }, 10000);
    };

    script.onerror = () => {
      console.error('Failed to load Google Maps script');
      reject(new Error('Failed to load Google Maps script'));
    };

    document.head.appendChild(script);
  });

  return googleMapsLoadingPromise;
}

/**
 * Check if Google Maps is ready
 */
export function isGoogleMapsReady(): boolean {
  return (
    typeof window.google !== 'undefined' &&
    window.google.maps &&
    typeof window.google.maps.DirectionsService === 'function'
  );
}
