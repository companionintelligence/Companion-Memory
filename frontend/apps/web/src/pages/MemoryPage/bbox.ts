import type { LatLngBounds } from 'leaflet';

/** A geographic bounding box as [minLon, minLat, maxLon, maxLat] (WGS84 / EPSG:4326). */
export type Bbox = [number, number, number, number];

/**
 * Parse the `?bbox=minLon,minLat,maxLon,maxLat` URL param (set by the map's
 * "Search this area" button) into a tuple, returning undefined for anything that
 * isn't exactly four finite numbers.
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
