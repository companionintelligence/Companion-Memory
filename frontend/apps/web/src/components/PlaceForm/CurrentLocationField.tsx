import { useRef, useState } from 'react';

import { useLazyQuery } from '@apollo/client';
import {
  getCurrentDeviceLocation,
  isDeviceLocationError,
  isIosPlatform,
  openNativeAppSettings,
} from '@ci/common';
import { Button, Spinner, cn } from '@ci/shadcn';
import { LocateFixed } from '@ci/shadcn/icons';

import { Map } from '@/components/Map';
import { gql } from '@/graphql';

import { applyCurrentLocation, parseCoordinates, type PlaceDraft } from './placeDraft';

const REVERSE_GEOCODE = gql(`
  query ReverseGeocode($latitude: Float!, $longitude: Float!) {
    reverseGeocode(latitude: $latitude, longitude: $longitude) {
      status
      placeName
    }
  }
`);

type LocateState = 'idle' | 'locating' | 'denied' | 'failed';

interface Props {
  value: PlaceDraft;
  onChange: (next: PlaceDraft) => void;
  disabled?: boolean;
}

/**
 * One-tap "where I am" for the add-place sheet: native iOS GPS when the app
 * is running in the shell, then reverse-geocode so the address and pin match.
 */
export function CurrentLocationField({ value, onChange, disabled }: Props) {
  const valueRef = useRef(value);
  valueRef.current = value;

  const [state, setState] = useState<LocateState>('idle');
  const [accuracy, setAccuracy] = useState<number | null>(null);
  const [reverseGeocode] = useLazyQuery(REVERSE_GEOCODE);

  const coords = parseCoordinates(value.latitude, value.longitude);
  const locating = state === 'locating';

  const locate = async () => {
    if (disabled || locating) {
      return;
    }

    setState('locating');

    try {
      const fix = await getCurrentDeviceLocation();
      setAccuracy(typeof fix.accuracy === 'number' && fix.accuracy > 0 ? fix.accuracy : null);

      let address: string | null = null;

      try {
        const result = await reverseGeocode({
          variables: { latitude: fix.latitude, longitude: fix.longitude },
        });

        if (result.data?.reverseGeocode.status === 'OK') {
          address = result.data.reverseGeocode.placeName ?? null;
        }
      } catch {
        // The pin is still exact without a street name.
      }

      onChange(applyCurrentLocation(valueRef.current, { ...fix, address }));
      setState('idle');
    } catch (error) {
      setState(isDeviceLocationError(error) && error.code === 'denied' ? 'denied' : 'failed');
    }
  };

  return (
    <div className="overflow-hidden rounded-2xl border border-border/70 bg-card shadow-sm">
      {coords ? (
        <>
          <div className="relative h-44 overflow-hidden bg-muted">
            <Map
              key={`${coords.latitude},${coords.longitude}`}
              center={[coords.latitude, coords.longitude]}
              zoom={17}
              zoomEnabled={false}
            >
              <Map.Marker position={[coords.latitude, coords.longitude]} />
            </Map>
            <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-background via-background/85 to-transparent px-4 pb-3 pt-12">
              <p className="text-sm font-medium leading-snug">
                {value.address.trim() || 'Pinned at your location'}
              </p>
              {accuracy != null && (
                <p className="mt-0.5 text-xs text-muted-foreground">Within {Math.round(accuracy)} m</p>
              )}
            </div>
          </div>
          <div className="flex items-center justify-between gap-3 border-t border-border/60 px-4 py-3">
            <p className="text-xs text-muted-foreground">Exact coordinates from this device</p>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => void locate()}
              disabled={disabled || locating}
            >
              {locating ? <Spinner className="h-4 w-4" /> : <LocateFixed className="h-4 w-4" />}
              Update
            </Button>
          </div>
        </>
      ) : (
        <button
          type="button"
          onClick={() => void locate()}
          disabled={disabled || locating}
          className={cn(
            'flex w-full items-center gap-4 px-4 py-4 text-left transition-colors',
            'hover:bg-muted/50 disabled:pointer-events-none disabled:opacity-60',
          )}
        >
          <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
            {locating ? <Spinner className="h-5 w-5" /> : <LocateFixed className="h-5 w-5" />}
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold">{locating ? 'Finding you…' : 'Use my location'}</p>
            <p className="text-xs text-muted-foreground">Drop a pin exactly where you are</p>
          </div>
        </button>
      )}

      {state === 'denied' && (
        <div className="flex flex-col gap-2 border-t border-border/60 px-4 py-3">
          <p className="text-sm text-muted-foreground">
            {isIosPlatform()
              ? 'Companion needs location access to drop this pin. Allow it in Settings, then try again.'
              : 'Location access is off. Allow it for this site, then try again.'}
          </p>
          {isIosPlatform() && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="self-start"
              onClick={() => void openNativeAppSettings()}
            >
              Open iOS Settings
            </Button>
          )}
        </div>
      )}

      {state === 'failed' && (
        <p role="status" className="border-t border-border/60 px-4 py-3 text-sm text-destructive">
          Couldn’t find your location. Try again in a moment.
        </p>
      )}
    </div>
  );
}
