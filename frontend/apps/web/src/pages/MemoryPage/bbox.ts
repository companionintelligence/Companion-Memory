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

/** A Leaflet viewport's bounds → [minLon, minLat, maxLon, maxLat]. */
export function boundsToBbox(bounds: LatLngBounds): Bbox {
  return [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()];
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
