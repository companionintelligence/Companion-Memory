/**
 * Pure coordinate-parsing helpers for the memory Map view. Kept in their own
 * module (separate from the React component) so they can be unit-tested: every
 * map pin's position flows through these, including geocoded, reverse-geocoded
 * and temporally-estimated event coordinates.
 */

export type Coordinates = {
  latitude?: number | null;
  longitude?: number | null;
  /**
   * The short spelling, which is what the WRITERS actually use:
   * `PlaceService.upsert` stores `{ lat, lng }` in a place's properties bag,
   * and the geocode path does the same. Reading only `latitude`/`longitude`
   * meant a place whose coordinate was perfectly well known resolved to null
   * and never rendered a pin.
   */
  lat?: number | null;
  lng?: number | null;
};

/** A resolved marker position, or null when the input has no usable coordinate. */
export type LatLng = { lat: number; lng: number };

/**
 * Read `{ latitude, longitude }` from an arbitrary properties bag (e.g. a
 * PlaceType's `properties`). Rejects non-numbers, NaN, and the (0,0) null-island
 * sentinel so a missing coordinate never renders at the Gulf of Guinea.
 */
export function readCoordinates(props: unknown): LatLng | null {
  if (props == null || typeof props !== 'object') {
    return null;
  }

  const bag = props as Coordinates;
  // Accept both spellings. `latitude`/`longitude` is what PlaceType exposes as
  // typed fields; `lat`/`lng` is what lands in the raw properties jsonb.
  const latitude = bag.latitude ?? bag.lat;
  const longitude = bag.longitude ?? bag.lng;

  if (
    typeof latitude !== 'number' ||
    typeof longitude !== 'number' ||
    isNaN(latitude) ||
    isNaN(longitude) ||
    (latitude === 0 && longitude === 0)
  ) {
    return null;
  }

  return { lat: latitude, lng: longitude };
}

/**
 * Read a PostGIS / GeoJSON Point: `{ type: 'Point', coordinates: [lng, lat] }`.
 * Note the [lng, lat] axis order. Same NaN / null-island guards as
 * {@link readCoordinates}.
 */
export function readGeoJsonPoint(value: unknown): LatLng | null {
  if (value == null || typeof value !== 'object') {
    return null;
  }

  const coords = (value as { coordinates?: unknown }).coordinates;

  if (!Array.isArray(coords) || coords.length < 2) {
    return null;
  }

  const [lng, lat] = coords;

  if (
    typeof lat !== 'number' ||
    typeof lng !== 'number' ||
    isNaN(lat) ||
    isNaN(lng) ||
    (lat === 0 && lng === 0)
  ) {
    return null;
  }

  return { lat, lng };
}
