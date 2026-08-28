import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import config from '@ci/configuration';

import type { GeocodeBounds, GeocodeProvider, GeocodeProviderResult } from './GeocodeProvider';

/** Google's box shape, shared by geometry.bounds and geometry.viewport. */
interface GoogleViewport {
  northeast?: { lat?: number; lng?: number };
  southwest?: { lat?: number; lng?: number };
}

interface GoogleGeocodeResponse {
  status: string;
  error_message?: string;
  results?: Array<{
    formatted_address?: string;
    place_id?: string;
    partial_match?: boolean;
    geometry?: {
      location?: { lat?: number; lng?: number };
      location_type?: string;
      bounds?: GoogleViewport;
      viewport?: GoogleViewport;
    };
    address_components?: unknown[];
  }>;
}

/**
 * Normalize Google's box into {@link GeocodeBounds}, preferring `bounds` (the
 * feature's true footprint) over `viewport` (a padded display box Google
 * returns for everything, including single addresses).
 *
 * Returns undefined unless all four corners are finite AND the box is
 * well-formed: north above south, and east above west. A box crossing the
 * antimeridian arrives with east < west and is dropped rather than silently
 * turned inside out into an envelope wrapping the whole globe.
 */
function toBounds(geometry: { bounds?: GoogleViewport; viewport?: GoogleViewport } | undefined) {
  for (const box of [geometry?.bounds, geometry?.viewport]) {
    const north = box?.northeast?.lat;
    const east = box?.northeast?.lng;
    const south = box?.southwest?.lat;
    const west = box?.southwest?.lng;

    if (
      typeof north === 'number' &&
      typeof south === 'number' &&
      typeof east === 'number' &&
      typeof west === 'number' &&
      Number.isFinite(north) &&
      Number.isFinite(south) &&
      Number.isFinite(east) &&
      Number.isFinite(west) &&
      north > south &&
      east > west
    ) {
      return { north, south, east, west } satisfies GeocodeBounds;
    }
  }

  return undefined;
}

const GOOGLE_GEOCODE_URL = 'https://maps.googleapis.com/maps/api/geocode/json';
const REQUEST_TIMEOUT_MS = 10000;

/**
 * Google Maps forward-geocode provider (direct key). Lifted from the original
 * TransformGoogleCalendar.geocodeLocation so that path can now delegate here
 * instead of forking the logic.
 *
 * CRITICAL: Google returns HTTP 200 even for REQUEST_DENIED / ZERO_RESULTS /
 * INVALID_REQUEST. We branch on the JSON `status` field, never on the HTTP
 * status, and surface that `status` to the caller so it can make the retry /
 * negative-cache decision.
 */
@Injectable()
export class GoogleGeocodeProvider implements GeocodeProvider {
  private readonly apiKey = config.geocoding.apiKey;

  constructor(private readonly logger: LoggerService) {
    this.logger.setContext(GoogleGeocodeProvider.name);
  }

  async geocode(address: string): Promise<GeocodeProviderResult> {
    const res = await this.fetchFirstResult(`address=${encodeURIComponent(address)}`);
    if (!res.ok) {
      return res.error;
    }

    const result = res.result;
    const lat = result.geometry?.location?.lat;
    const lng = result.geometry?.location?.lng;

    if (typeof lat !== 'number' || typeof lng !== 'number') {
      this.logger.warn('Google geocode returned a result without numeric coordinates', { address });

      return { status: 'ZERO_RESULTS', errorMessage: 'Result missing coordinates' };
    }

    return {
      status: 'OK',
      lat,
      lng,
      normalizedAddress: result.formatted_address,
      placeId: result.place_id,
      locationType: result.geometry?.location_type,
      partialMatch: result.partial_match ?? false,
      components: { address_components: result.address_components ?? [] },
      bounds: toBounds(result.geometry),
    };
  }

  async reverseGeocode(lat: number, lng: number): Promise<GeocodeProviderResult> {
    // Google's same endpoint reverse-geocodes via `latlng` instead of `address`.
    const res = await this.fetchFirstResult(`latlng=${lat},${lng}`);
    if (!res.ok) {
      return res.error;
    }

    const result = res.result;
    if (!result.formatted_address) {
      this.logger.warn('Google reverse-geocode returned a result without a formatted address', { lat, lng });

      return { status: 'ZERO_RESULTS', errorMessage: 'Result missing formatted_address' };
    }

    // Echo the query coordinates; the resolved name is the formatted_address.
    return {
      status: 'OK',
      lat,
      lng,
      normalizedAddress: result.formatted_address,
      placeId: result.place_id,
      locationType: result.geometry?.location_type,
      partialMatch: result.partial_match ?? false,
      components: { address_components: result.address_components ?? [] },
      bounds: toBounds(result.geometry),
    };
  }

  /**
   * Shared transport for both directions: build the URL from a query fragment
   * (`address=…` or `latlng=…`), enforce the timeout, and reduce the response to
   * either the first result or a {@link GeocodeProviderResult} carrying the
   * provider status. Throws only on transport failure (network/timeout), which
   * the caller treats as transient. Google returns HTTP 200 even on
   * REQUEST_DENIED / ZERO_RESULTS, so we branch on the JSON `status`, never HTTP.
   */
  private async fetchFirstResult(
    query: string,
  ): Promise<
    | { ok: true; result: NonNullable<GoogleGeocodeResponse['results']>[number] }
    | { ok: false; error: GeocodeProviderResult }
  > {
    if (!this.apiKey) {
      // No key configured — treat as a hard, non-retryable denial so the batch
      // listener does not spin. The startup config check already warns.
      this.logger.warn('Geocoding requested but no API key is configured');

      return {
        ok: false,
        error: { status: 'REQUEST_DENIED', errorMessage: 'No geocoding API key configured' },
      };
    }

    const url = `${GOOGLE_GEOCODE_URL}?${query}&key=${this.apiKey}`;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'CI-Server/1.0' },
      });
    } finally {
      clearTimeout(timeoutId);
    }

    // A non-2xx HTTP status is a transport-level failure (proxy, outage) and is
    // genuinely transient — surface it as UNKNOWN_ERROR so the caller retries.
    // The semantic outcomes (denied / zero results) all arrive as HTTP 200.
    if (!response.ok) {
      this.logger.warn('Google geocode HTTP request failed', {
        status: response.status,
        statusText: response.statusText,
      });

      return { ok: false, error: { status: 'UNKNOWN_ERROR', errorMessage: `HTTP ${response.status}` } };
    }

    const data = (await response.json()) as GoogleGeocodeResponse;

    if (data.status !== 'OK' || !data.results || data.results.length === 0) {
      return {
        ok: false,
        error: { status: data.status ?? 'UNKNOWN_ERROR', errorMessage: data.error_message },
      };
    }

    return { ok: true, result: data.results[0] };
  }
}
