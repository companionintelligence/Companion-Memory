/**
 * Pure coordinate-parsing helpers for the memory Map view. Kept in their own
 * module (separate from the React component) so they can be unit-tested: every
 * map pin's position flows through these, including geocoded, reverse-geocoded
 * and temporally-estimated event coordinates.
 */

export type Coordinates = { latitude?: number | null; longitude?: number | null };

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

  const { latitude, longitude } = props as Coordinates;

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
