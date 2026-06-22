import { Injectable } from '@nestjs/common';

import { LoggerService } from '@ci/common/logging';
import config from '@ci/configuration';

import type { GeocodeProvider, GeocodeProviderResult } from './GeocodeProvider';

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
    };
    address_components?: unknown[];
  }>;
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
    if (!this.apiKey) {
      // No key configured — treat as a hard, non-retryable denial so the batch
      // listener does not spin. The startup config check already warns.
      this.logger.warn('Geocoding requested but no API key is configured');

      return { status: 'REQUEST_DENIED', errorMessage: 'No geocoding API key configured' };
    }

    const url = `${GOOGLE_GEOCODE_URL}?address=${encodeURIComponent(address)}&key=${this.apiKey}`;

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

      return { status: 'UNKNOWN_ERROR', errorMessage: `HTTP ${response.status}` };
    }

    const data = (await response.json()) as GoogleGeocodeResponse;

    if (data.status !== 'OK' || !data.results || data.results.length === 0) {
      return {
        status: data.status ?? 'UNKNOWN_ERROR',
        errorMessage: data.error_message,
      };
    }

    const result = data.results[0];
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
    };
  }
}
