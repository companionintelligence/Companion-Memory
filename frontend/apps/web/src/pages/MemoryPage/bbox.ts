import type { LatLngBounds } from 'leaflet';

/** A geographic bounding box as [minLon, minLat, maxLon, maxLat] (WGS84 / EPSG:4326). */
export type Bbox = [number, number, number, number];

/**
 * Parse the `?bbox=minLon,minLat,maxLon,maxLat` URL param (set by the map's
 * "Search events in this area" button) into a tuple, returning undefined for
 * anything that isn't exactly four finite numbers.
 */
export function parseBbox(raw: string | null | undefined): Bbox | undefined {
  if (!raw) {
    return undefined;
  }

  const parts = raw.split(',').map(Number);

  return parts.length === 4 && parts.every((value) => Number.isFinite(value)) ? (parts as Bbox) : undefined;
}

/** Serialise a bbox for the URL param (~1m precision keeps the param short). */
export function formatBbox(bbox: Bbox): string {
  return bbox.map((value) => value.toFixed(6)).join(',');
}

/** The URL param carrying the searched map areas; `bbox` is its single-box predecessor, still read. */
export const AREAS_PARAM = 'areas';
export const LEGACY_BBOX_PARAM = 'bbox';

/**
 * Parse the `?areas=w,s,e,n;w,s,e,n` URL param — several rectangles, ORed by
 * the search — dropping any entry that is not four finite numbers. Undefined
 * when nothing usable is left, so callers can treat "no areas" and "no param"
 * alike.
 */
export function parseAreas(raw: string | null | undefined): Bbox[] | undefined {
  if (!raw) {
    return undefined;
  }

  const areas = raw
    .split(';')
    .map((part) => parseBbox(part))
    .filter((area): area is Bbox => area != null);

  return areas.length > 0 ? areas : undefined;
}

/** Serialise rectangles for the `?areas=` param, semicolon-separated. */
export function formatAreas(areas: readonly Bbox[]): string {
  return areas.map(formatBbox).join(';');
}

/**
 * The searched areas a URL carries: `?areas=`, else the legacy single
 * `?bbox=` as a one-entry list, else undefined.
 */
export function readAreasParam(params: URLSearchParams): Bbox[] | undefined {
  const areas = parseAreas(params.get(AREAS_PARAM));

  if (areas) {
    return areas;
  }

  const legacy = parseBbox(params.get(LEGACY_BBOX_PARAM));

  return legacy ? [legacy] : undefined;
}

/**
 * Whether a server-shaped list (nullable floats, any length) is a usable set
 * of areas: at least one entry, every entry four finite numbers.
 */
export function asAreas(
  value: readonly (readonly (number | null)[] | null)[] | null | undefined,
): Bbox[] | undefined {
  if (value == null) {
    return undefined;
  }

  const areas = value.filter(
    (area): area is Bbox =>
      area != null && area.length === 4 && area.every((n) => typeof n === 'number' && Number.isFinite(n)),
  );

  return areas.length > 0 ? areas : undefined;
}

/** The smallest bbox containing every given one; undefined for an empty list. */
export function unionBbox(areas: readonly Bbox[]): Bbox | undefined {
  if (areas.length === 0) {
    return undefined;
  }

  return areas.reduce<Bbox>(
    (acc, [minLon, minLat, maxLon, maxLat]) => [
      Math.min(acc[0], minLon),
      Math.min(acc[1], minLat),
      Math.max(acc[2], maxLon),
      Math.max(acc[3], maxLat),
    ],
    [...areas[0]] as Bbox,
  );
}

/** A Leaflet viewport's bounds → [minLon, minLat, maxLon, maxLat]. */
export function boundsToBbox(bounds: LatLngBounds): Bbox {
  return [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()];
}

/**
 * Decimals that show an axis's span to about two significant figures: one for
 * a country-sized area, four for a few streets, never more than the six the URL
 * keeps. A fixed one decimal read a street-sized area as `37.8°N–37.8°N`.
 */
function spanDecimals(min: number, max: number): number {
  // Rounded to the URL's six decimals first: 1.2 - 1.1 is 0.0999…9, which
  // would otherwise get one decimal more than the same span at 0.1–0.2.
  const span = Math.abs(Number((max - min).toFixed(6)));

  if (!(span > 0)) {
    return 6;
  }

  return Math.min(6, Math.max(1, Math.ceil(-Math.log10(span)) + 1));
}

/**
 * Leaflet's `getBounds()` reports longitudes past ±180 once the map is panned
 * into a world copy (a Pacific view runs 170 to 190), so bring those back into
 * range before naming a hemisphere.
 */
function wrapLongitude(value: number): number {
  return value > 180 || value < -180 ? ((((value + 180) % 360) + 360) % 360) - 180 : value;
}

/** One coordinate, its hemisphere read from the rounded figure so `-0.00003` is not `0.0000°S`. */
function coordinate(value: number, digits: number, negative: string, positive: string): string {
  const text = Math.abs(value).toFixed(digits);

  return `${text}°${value < 0 && Number(text) !== 0 ? negative : positive}`;
}

/**
 * A map area as a person would read it, e.g. `47.5°S–33.5°N, 165.5°E–179.5°E`,
 * or `37.7937°N–37.7965°N, 122.3989°W–122.3915°W` for a small one. The Where
 * popovers cannot redraw a rectangle (that is the map's job), only show the
 * ones the search carries and let each be removed.
 */
export function describeBbox([minLon, minLat, maxLon, maxLat]: Bbox): string {
  const latDigits = spanDecimals(minLat, maxLat);
  const lonDigits = spanDecimals(minLon, maxLon);
  const wholeWorld = Math.abs(maxLon - minLon) >= 360;
  const west = wholeWorld ? -180 : wrapLongitude(minLon);
  const east = wholeWorld ? 180 : wrapLongitude(maxLon);

  return [
    `${coordinate(minLat, latDigits, 'S', 'N')}–${coordinate(maxLat, latDigits, 'S', 'N')}`,
    `${coordinate(west, lonDigits, 'W', 'E')}–${coordinate(east, lonDigits, 'W', 'E')}`,
  ].join(', ');
}

/** What the Where trigger says for the rectangles beside the place names: "Map Areas (2)". */
export function mapAreasLabel(count: number): string {
  return `Map Areas (${count})`;
}

/** The geographic centre of a bbox as [lat, lng]. */
export function bboxCenter(bbox: Bbox): [number, number] {
  return [(bbox[1] + bbox[3]) / 2, (bbox[0] + bbox[2]) / 2];
}

/**
 * Shrink a bbox, symmetrically around its own centre, so neither span exceeds
 * the given ceiling. A no-op on a bbox already inside both limits.
 *
 * Exists for callers that PAD a viewport before sending it as a spatial
 * filter (the trace layer pads by `TRACE_VIEWPORT_PAD` so a small pan doesn't
 * blank the trace's edges): padding a raw viewport that is already close to
 * the server's own safe-envelope ceiling
 * (`positionTrack.ts`'s `MAX_BBOX_LAT_SPAN`/`MAX_BBOX_LON_SPAN` — PostGIS
 * reads a geodesic envelope wider than roughly a hemisphere as its own
 * complement) can push it over that ceiling. The server's answer to a bbox
 * that wide is to drop the spatial predicate ENTIRELY rather than narrow to
 * nonsense — silently turning a viewport-scoped request into an unscoped one,
 * for no reason the caller can see. Clamping the padded box here, before it
 * ever leaves the client, keeps the pad's purpose (a little slack at the
 * edges) without ever paying that cost.
 */
export function clampBboxSpan(bbox: Bbox, maxLonSpan: number, maxLatSpan: number): Bbox {
  const [minLon, minLat, maxLon, maxLat] = bbox;
  const lonSpan = maxLon - minLon;
  const latSpan = maxLat - minLat;
  const overLon = lonSpan > maxLonSpan;
  const overLat = latSpan > maxLatSpan;

  // Bit-exact passthrough when neither span is over — recomputing via the
  // centre below is lossy (float division/addition), and a caller comparing
  // this output against an un-clamped bbox for the (overwhelmingly common)
  // case that needed no clamping at all should see the SAME numbers back.
  if (!overLon && !overLat) {
    return bbox;
  }

  const [centerLat, centerLon] = bboxCenter(bbox);

  return [
    overLon ? centerLon - maxLonSpan / 2 : minLon,
    overLat ? centerLat - maxLatSpan / 2 : minLat,
    overLon ? centerLon + maxLonSpan / 2 : maxLon,
    overLat ? centerLat + maxLatSpan / 2 : maxLat,
  ];
}
