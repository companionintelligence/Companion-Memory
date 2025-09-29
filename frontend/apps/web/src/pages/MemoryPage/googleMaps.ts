// Google Maps utility functions

let googleMapsLoadingPromise: Promise<void> | null = null;

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
    // Use the provided Google Maps API key
    const apiKey = 'AIzaSyCPwiAuP9LNzBm9sePxdkD-kED5rZAv5WI';

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
