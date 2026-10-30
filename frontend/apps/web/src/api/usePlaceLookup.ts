import { useCallback } from 'react';

import { useLazyQuery } from '@apollo/client';

import { gql } from '@/graphql';

const PLACE_LOOKUP = gql(`
  query PlaceLookup($query: String!) {
    geocodingConfigured
    geocode(query: $query) {
      status
      latitude
      longitude
      normalizedAddress
      confidence
      cached
    }
  }
`);

/**
 * At or below this the provider only placed the name in an area: Google's
 * APPROXIMATE, a city or region centroid (`GeocodeService.confidenceForLocationType`
 * maps it to 0.4, and `LOW_CONFIDENCE_THRESHOLD` there is the same line). "Blue
 * Bottle Coffee, San Francisco" comes back as the middle of San Francisco.
 */
const APPROXIMATE_CONFIDENCE = 0.4;

/** Lower case, accents off, spaces collapsed: "  São   Paulo" and "sao paulo" are one name. */
function normalizePart(part: string): string {
  return part.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function addressParts(text: string): string[] {
  return text.split(',').map(normalizePart).filter(Boolean);
}

/**
 * Whether an area match is the place that was typed: "Tokyo" finding "Tokyo,
 * Japan", or "Portland, OR" finding "Portland, OR, USA". The match has to start
 * with the same name and carry every other part that was typed, so "Blue Bottle
 * Coffee, San Francisco" finding "San Francisco, CA, USA" is still only the
 * area around a café, and "Portland, Maine" finding "Portland, OR, USA" is not
 * the Portland that was asked for.
 */
export function namesTypedPlace(query: string, address: string | null): boolean {
  if (address == null) {
    return false;
  }

  const typed = addressParts(query);
  const found = addressParts(address);

  return typed.length > 0 && typed[0] === found[0] && typed.every((part) => found.includes(part));
}

export type PlaceLookupResult =
  | {
      status: 'ok';
      latitude: number;
      longitude: number;
      address: string | null;
      /** The match is an area around the name (a city, a region), not the place itself. */
      approximate: boolean;
    }
  | { status: 'none' }
  /** This appliance has no geocoding provider set up (see Places). */
  | { status: 'unconfigured' }
  | { status: 'error' };

export type PlaceLookup = (name: string) => Promise<PlaceLookupResult>;

/**
 * A place name → its best match, for the event form's "Look up" button.
 *
 * Returns a plain function so `EventForm` can take it as a prop and stay free
 * of Apollo: the form renders in places that have no client (tests, stories),
 * and a form that could not look anything up simply shows no button.
 */
export function usePlaceLookup(): PlaceLookup {
  const [run] = useLazyQuery(PLACE_LOOKUP);

  return useCallback(
    async (name: string): Promise<PlaceLookupResult> => {
      try {
        const { data, error } = await run({ variables: { query: name } });
        const match = data?.geocode;

        if (error || !match) {
          return { status: 'error' };
        }

        if (data?.geocodingConfigured === false) {
          return { status: 'unconfigured' };
        }

        if (match.status === 'OK' && match.latitude != null && match.longitude != null) {
          return {
            status: 'ok',
            latitude: match.latitude,
            longitude: match.longitude,
            address: match.normalizedAddress ?? null,
            // An area is what was asked for when the name typed is the area found.
            approximate:
              match.confidence != null &&
              match.confidence <= APPROXIMATE_CONFIDENCE &&
              !namesTypedPlace(name, match.normalizedAddress ?? null),
          };
        }

        return match.status === 'ZERO_RESULTS' ? { status: 'none' } : { status: 'error' };
      } catch {
        return { status: 'error' };
      }
    },
    [run],
  );
}
