import { useCallback, useState } from 'react';

export interface LocationData {
  latitude: number;
  longitude: number;
  accuracy?: number;
  altitude?: number | null;
  altitudeAccuracy?: number | null;
  heading?: number | null;
  speed?: number | null;
  timestamp: number;
}

interface UseLocationReturn {
  location: LocationData | null;
  error: GeolocationPositionError | null;
  loading: boolean;
  requestLocation: () => Promise<LocationData | null>;
  isSupported: boolean;
}

export function useLocation(): UseLocationReturn {
  const [location, setLocation] = useState<LocationData | null>(null);
  const [error, setError] = useState<GeolocationPositionError | null>(null);
  const [loading, setLoading] = useState(false);
  const isSupported = typeof navigator !== 'undefined' && 'geolocation' in navigator;

  const requestLocation = useCallback(async (): Promise<LocationData | null> => {
    if (!isSupported) {
      // Geolocation not supported - return null gracefully without setting error
      // This is not an error condition, just a missing feature
      return null;
    }

    setLoading(true);
    setError(null);

    return new Promise((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          const locationData: LocationData = {
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
            accuracy: position.coords.accuracy,
            altitude: position.coords.altitude ?? null,
            altitudeAccuracy: position.coords.altitudeAccuracy ?? null,
            heading: position.coords.heading ?? null,
            speed: position.coords.speed ?? null,
            timestamp: position.timestamp,
          };

          setLocation(locationData);
          setLoading(false);
          resolve(locationData);
        },
        (err) => {
          // Store error for debugging, but still resolve with null to allow upload to proceed
          setError(err);
          setLoading(false);
          resolve(null);
        },
        {
          enableHighAccuracy: true,
          timeout: 10000,
          maximumAge: 0,
        },
      );
    });
  }, [isSupported]);

  return {
    location,
    error,
    loading,
    requestLocation,
    isSupported,
  };
}
