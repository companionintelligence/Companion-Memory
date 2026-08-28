/**
 * The pure half of the map's location-history read
 * ({@link PositionService.findTrack}): page sizing, the downsample bucket, the
 * keyset cursor, and viewport-box normalisation.
 *
 * It lives apart from the service because these are the rules that decide how
 * many rows a viewport request can ever ship, and they must be provable without
 * a database. `ci.position` on the QA appliance holds 63,044 fixes over thirteen
 * years for a single user; the map used to plot none of them (it read located
 * *events* only — 121 of them), and the naive fix — "select them all" — is a
 * 63k-row payload on every pan.
 */

/** A geographic bounding box as [minLon, minLat, maxLon, maxLat] (WGS84 / EPSG:4326). */
export type TrackBbox = [number, number, number, number];

/**
 * Points one page may carry. A page is drawn all at once, so this is a payload
 * bound rather than a scroll window: a track point is ~80 bytes on the wire, so
 * 2,000 of them is ~160KB — about what one hydrated search page already costs.
 */
export const DEFAULT_TRACK_PAGE_SIZE = 2_000;
export const MAX_TRACK_PAGE_SIZE = 10_000;

/**
 * Downsample budget: roughly how many points the WHOLE requested window should
 * collapse to. The server turns it into a time bucket (see
 * {@link resolveBucketSeconds}), so the budget — not the row count — is what
 * bounds a world-zoom read. It is an upper bound, not a target: thirteen years
 * at a 2.4-day bucket yields 316 points here, because only 582 of those days
 * carry any fix at all.
 */
export const DEFAULT_TRACK_MAX_POINTS = 2_000;
export const MAX_TRACK_MAX_POINTS = 20_000;

/**
 * Widest viewport still expressed as a PostGIS envelope.
 *
 * `ST_MakeEnvelope(...)::geography` draws its edges as geodesics, and past
 * roughly a hemisphere PostGIS reads the ring the other way round — the box
 * becomes its own complement. Measured against the live table (63,044 located
 * fixes, all in North America): a 120°x60° box centred on Los Angeles matches
 * 62,118 rows, a 240°x120° box matches 926, and the whole-world envelope
 * `ST_MakeEnvelope(-180,-90,180,90,4326)::geography` raises
 * "Antipodal (180 degrees long) edge detected!" outright.
 *
 * So a viewport wider than this drops the spatial predicate entirely rather
 * than narrowing to nonsense. That is safe by construction: dropping a filter
 * can only widen the result, and at that zoom the point budget is what bounds
 * the read anyway.
 */
export const MAX_BBOX_LON_SPAN = 120;
export const MAX_BBOX_LAT_SPAN = 60;

/** Below this, bucketing buys nothing — `ci.position` fixes are at best one per second. */
const MIN_BUCKET_SECONDS = 2;

/** Cursor payload: the instant paged past, and the bucket that page was cut with. */
export interface TrackCursor {
  time: Date;
  /** Null means the page was raw (un-bucketed) — see {@link resolveBucketSeconds}. */
  bucketSeconds: number | null;
}

function clampInt(value: number, min: number, max: number): number {
  return Math.min(Math.max(Math.trunc(value), min), max);
}

/** Page size for one track read, defaulted and clamped. */
export function clampPageSize(first?: number | null): number {
  if (first == null || !Number.isFinite(first)) {
    return DEFAULT_TRACK_PAGE_SIZE;
  }

  return clampInt(first, 1, MAX_TRACK_PAGE_SIZE);
}

/**
 * Downsample budget, defaulted and clamped. A caller asking for `0` (or a
 * negative) is asking for raw fixes: {@link resolveBucketSeconds} answers null
 * for that, and the read pages through every row instead of bucketing.
 */
export function clampMaxPoints(maxPoints?: number | null): number {
  if (maxPoints == null || !Number.isFinite(maxPoints)) {
    return DEFAULT_TRACK_MAX_POINTS;
  }

  if (maxPoints <= 0) {
    return 0;
  }

  return clampInt(maxPoints, 1, MAX_TRACK_MAX_POINTS);
}

/**
 * Bucket width for a window of `spanMs` that should collapse to at most
 * `maxPoints` points, or null when the read should stay raw.
 *
 * Raw is the right answer for a narrow window: a single day against a 2,000
 * budget wants a 43-second bucket, and at that width nearly every bucket holds
 * exactly one fix — so bucketing costs an aggregate and returns the same rows.
 */
export function resolveBucketSeconds(spanMs: number, maxPoints: number): number | null {
  if (maxPoints <= 0 || !Number.isFinite(spanMs) || spanMs <= 0) {
    return null;
  }

  const seconds = Math.ceil(spanMs / 1000 / maxPoints);

  return seconds >= MIN_BUCKET_SECONDS ? seconds : null;
}

/**
 * Opaque keyset cursor.
 *
 * It carries the bucket as well as the instant, and that is load-bearing rather
 * than decorative: the bucket is derived on the first page from the window's
 * span, so a continuation page that recomputed it from a window that had since
 * grown (one more fix arrives, `max(time)` moves) would cut its groups on
 * different boundaries and either re-emit or skip a slice of the trace.
 * Inheriting it from the cursor makes every page of one walk agree by
 * construction — and saves the continuation page the `min(time)/max(time)`
 * round trip.
 *
 * Base64 of `<iso>::<bucketSeconds|raw>`, matching the `time::id` search
 * cursors (SearchResolver.encodeSearchCursor).
 */
export function encodeTrackCursor(time: Date, bucketSeconds: number | null): string {
  return Buffer.from(`${time.toISOString()}::${bucketSeconds ?? 'raw'}`).toString('base64');
}

/** Inverse of {@link encodeTrackCursor}; undefined for anything undecodable. */
export function decodeTrackCursor(cursor?: string | null): TrackCursor | undefined {
  if (cursor == null || cursor.length === 0) {
    return undefined;
  }

  const decoded = Buffer.from(cursor, 'base64').toString('utf8');
  const separator = decoded.lastIndexOf('::');

  if (separator < 0) {
    return undefined;
  }

  const time = new Date(decoded.slice(0, separator));

  if (isNaN(time.getTime())) {
    return undefined;
  }

  const rawBucket = decoded.slice(separator + 2);
  const bucketSeconds = rawBucket === 'raw' ? null : Number(rawBucket);

  if (bucketSeconds != null && (!Number.isFinite(bucketSeconds) || bucketSeconds < MIN_BUCKET_SECONDS)) {
    return undefined;
  }

  return { time, bucketSeconds };
}

/** Fold a longitude back into [-180, 180]; leave in-range values exactly as they are. */
function wrapLon(lon: number): number {
  if (lon >= -180 && lon <= 180) {
    return lon;
  }

  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

/**
 * A viewport as zero, one or two PostGIS-safe envelopes.
 *
 * Zero when there is nothing usable to filter on — a malformed box, or one
 * wider than {@link MAX_BBOX_LON_SPAN}/{@link MAX_BBOX_LAT_SPAN} (see there for
 * why a world-scale envelope is worse than no envelope).
 *
 * Two when the viewport straddles the antimeridian. Leaflet's `getBounds()`
 * happily reports longitudes outside [-180, 180] once the user pans into a
 * world copy — a box from 170°E to 190°E, say — and PostGIS coerces those into
 * range silently (`NOTICE: Coordinate values were coerced into range`), which
 * turns a 20°-wide Pacific viewport into a 340°-wide box spanning the wrong
 * half of the planet. Splitting at the date line keeps the query describing the
 * viewport the user is actually looking at.
 */
export function normalizeBbox(bbox?: readonly number[] | null): TrackBbox[] {
  if (bbox == null || bbox.length !== 4 || !bbox.every((value) => Number.isFinite(value))) {
    return [];
  }

  const [rawMinLon, rawMinLat, rawMaxLon, rawMaxLat] = bbox;

  const minLat = Math.max(Math.min(rawMinLat, rawMaxLat), -90);
  const maxLat = Math.min(Math.max(rawMinLat, rawMaxLat), 90);
  const minLon = Math.min(rawMinLon, rawMaxLon);
  const maxLon = Math.max(rawMinLon, rawMaxLon);

  if (maxLon - minLon > MAX_BBOX_LON_SPAN || maxLat - minLat > MAX_BBOX_LAT_SPAN) {
    return [];
  }

  const west = wrapLon(minLon);
  const east = wrapLon(maxLon);

  if (west <= east) {
    return [[west, minLat, east, maxLat]];
  }

  return [
    [west, minLat, 180, maxLat],
    [-180, minLat, east, maxLat],
  ];
}
