// Google Maps utility functions

// Optional build-time key. Route drawing relies on the billed Directions API,
// so when this is unset the route layer stays disabled rather than flooding the
// console with REQUEST_DENIED / "enable Billing" errors.
const GOOGLE_MAPS_API_KEY = import.meta.env.VITE_GOOGLE_MAPS_API_KEY;

let googleMapsLoadingPromise: Promise<void> | null = null;

/**
 * Whether a Google Maps API key is configured. Callers should gate on this
 * before invoking loadGoogleMaps / the Directions API.
 */
export function isGoogleMapsConfigured(): boolean {
  return typeof GOOGLE_MAPS_API_KEY === 'string' && GOOGLE_MAPS_API_KEY.length > 0;
}

/**
 * Load Google Maps API and return a promise that resolves when ready
 */
export function loadGoogleMaps(): Promise<void> {
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
    // Bail out (without touching the network) when no key is configured.
    if (!isGoogleMapsConfigured()) {
      reject(new Error('Google Maps API key is not configured (VITE_GOOGLE_MAPS_API_KEY).'));

      return;
    }

    const apiKey = GOOGLE_MAPS_API_KEY;

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
