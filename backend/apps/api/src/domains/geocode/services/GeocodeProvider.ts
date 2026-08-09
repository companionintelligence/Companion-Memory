/**
 * Provider abstraction for geocoding, in both directions. Two implementations
 * exist: {@link PortalGeocodeProvider} (the default — egress goes through
 * CI-Portal, which holds the provider key and fronts a cache shared by every
 * appliance) and {@link GoogleGeocodeProvider} (a direct-key fallback). Keeping
 * the interface lets the cache orchestration in GeocodeService stay
 * provider-agnostic and lets tests stub the network.
 */

/** Injection token for the active geocode provider. */
export const GEOCODE_PROVIDER = Symbol('GEOCODE_PROVIDER');

/**
 * Normalized result of a single forward-geocode call. `status` mirrors the
 * provider's own status vocabulary (Google's JSON `status` field verbatim) so
 * the orchestration layer can branch on it for retry / negative-cache decisions
 * WITHOUT inspecting HTTP codes — Google returns HTTP 200 even on REQUEST_DENIED
 * and ZERO_RESULTS.
 */
export interface GeocodeProviderResult {
  /** Provider status: OK | ZERO_RESULTS | REQUEST_DENIED | INVALID_REQUEST | OVER_QUERY_LIMIT | UNKNOWN_ERROR. */
  status: string;
  /** Latitude (WGS84). Present only when status === 'OK'. */
  lat?: number;
  /** Longitude (WGS84). Present only when status === 'OK'. */
  lng?: number;
  /** Provider's canonical formatted address. */
  normalizedAddress?: string;
  /** Provider place id. */
  placeId?: string;
  /** Google geometry.location_type: ROOFTOP | RANGE_INTERPOLATED | GEOMETRIC_CENTER | APPROXIMATE. */
  locationType?: string;
  /** Whether the provider flagged this as a partial match. */
  partialMatch?: boolean;
  /** Raw address-component payload, stored for later enrichment. */
  components?: Record<string, unknown>;
  /** Provider error message, when present (e.g. for REQUEST_DENIED). */
  errorMessage?: string;
}

/** A WGS84 coordinate pair, the unit of a reverse-geocode request. */
export interface GeocodePoint {
  lat: number;
  lng: number;
}

export interface GeocodeProvider {
  /**
   * Forward-geocode a single address string. MUST NOT throw on a provider-level
   * failure (REQUEST_DENIED, ZERO_RESULTS, …); instead return a result carrying
   * that `status`. May throw only on transport failures (network/timeout), which
   * the caller treats as a transient (retryable) error.
   */
  geocode(address: string): Promise<GeocodeProviderResult>;

  /**
   * Reverse-geocode a (lat, lng) pair into a human-readable place name. The
   * resolved name is returned in {@link GeocodeProviderResult.normalizedAddress}.
   * Same error contract as {@link geocode}: return a result carrying the
   * provider `status` on a provider-level failure; throw only on transport
   * failures (treated as transient/retryable by the caller).
   */
  reverseGeocode(lat: number, lng: number): Promise<GeocodeProviderResult>;

  /**
   * OPTIONAL capability: resolve a whole page in one call.
   *
   * The single-item methods above are the contract every provider must honor,
   * because GeocodeService's cache is keyed per query and therefore asks per
   * query. A provider that fronts a *batch* endpoint (Portal) can additionally
   * expose these so a caller holding a page of work — a backfill, an importer —
   * pays one round trip instead of N. Callers must feature-detect
   * (`provider.geocodeBatch?.(…)`) and fall back to the single-item path.
   *
   * Contract, and the only thing a caller may rely on: the returned array is
   * INDEX-ALIGNED with the input array and has exactly the same length. A
   * per-item failure is a `status` on that item's result, never a short array
   * and never a rejection — one bad address must not discard the other 99
   * answers, which is the whole reason the batch call is worth making.
   */
  geocodeBatch?(addresses: string[]): Promise<GeocodeProviderResult[]>;

  /** Batch counterpart of {@link reverseGeocode}. Same index-alignment contract. */
  reverseGeocodeBatch?(points: GeocodePoint[]): Promise<GeocodeProviderResult[]>;
}
