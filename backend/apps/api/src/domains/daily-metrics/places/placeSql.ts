/**
 * Deterministic SQL for the next-place engine (the dailyAggregateSql pattern:
 * SQL returns primitives, all derivation happens in pure functions). Spatial
 * columns are read via ST_Y/ST_X and written via EWKT text casts so nothing
 * depends on TypeORM's spatial hydration.
 */

import type { PositionFix } from './stayPoints';
import type { PlaceClusterSnapshot } from './types';

/** Format a (lat, lng) pair as EWKT accepted by a text-to-geography cast. */
export function toEwktPoint(lat: number, lng: number): string {
  return `SRID=4326;POINT(${lng} ${lat})`;
}

/**
 * One keyset page of usable GPS fixes, oldest first.
 * $1 user_id, $2 exclusive lower time bound, $3 inclusive upper time bound,
 * $4 max accuracy in meters (fixes with a worse reported accuracy smear stay
 * detection and are dropped; NULL accuracy is kept), $5 page size.
 */
export const POSITION_PAGE_SQL = `
SELECT pos.time AS time,
       ST_Y(pos.location::geometry) AS lat,
       ST_X(pos.location::geometry) AS lng
  FROM ci.position pos
 WHERE pos.user_id = $1
   AND pos.location IS NOT NULL
   AND (pos.accuracy_meters IS NULL OR pos.accuracy_meters <= $4)
   AND pos.time > $2
   AND pos.time <= $3
 ORDER BY pos.time ASC
 LIMIT $5
`;

/**
 * Where the cluster scan window sits: the start of the `$3`-th most recent day
 * that has a usable fix, plus the newest usable fix itself.
 * $1 user_id, $2 max accuracy in meters, $3 how many days-with-fixes to span.
 *
 * `PlaceClusterService.resolveWindow` documents why the window is positioned
 * by counting days-with-fixes rather than by subtracting 90 days from `now()`
 * or from MAX(time). The usability predicates here MUST match
 * {@link POSITION_PAGE_SQL}'s — a day this counts but that query then filters
 * out silently shortens the window.
 *
 * `oldest_day` comes back as the start of that day minus a microsecond,
 * because POSITION_PAGE_SQL's lower bound is EXCLUSIVE (`pos.time > $2`) and a
 * fix landing exactly on local midnight would otherwise be dropped.
 *
 * Days are bucketed in UTC. That is a counting device, not a user-facing day
 * boundary — the value returned is a timestamp, so which side of midnight a
 * fix falls on can shift the window's far edge by at most one day and nothing
 * else. `time <= now()` keeps a future-dated fix from stealing slots.
 */
export const POSITION_WINDOW_ANCHOR_SQL = `
WITH usable AS (
  SELECT pos.time
    FROM ci.position pos
   WHERE pos.user_id = $1
     AND pos.location IS NOT NULL
     AND (pos.accuracy_meters IS NULL OR pos.accuracy_meters <= $2)
     AND pos.time <= now()
), days AS (
  SELECT DISTINCT date_trunc('day', usable.time AT TIME ZONE 'UTC') AS day
    FROM usable
   ORDER BY day DESC
   LIMIT $3
)
SELECT ((SELECT min(day) FROM days) AT TIME ZONE 'UTC') - INTERVAL '1 microsecond' AS oldest_day,
       (SELECT max(usable.time) FROM usable) AS newest_fix
`;

export function parsePositionRow(row: Record<string, unknown>): PositionFix {
  return {
    time: row.time instanceof Date ? row.time : new Date(String(row.time)),
    lat: Number(row.lat),
    lng: Number(row.lng),
  };
}

/**
 * All clusters of a user with scalar centroid coordinates, most recently
 * visited first (deterministic tie-breaks), so rows[0] is the current place.
 */
export const CLUSTERS_FOR_USER_SQL = `
SELECT id,
       ST_Y(centroid::geometry) AS lat,
       ST_X(centroid::geometry) AS lng,
       radius_m,
       label,
       visit_count,
       first_seen,
       last_seen
  FROM ci_derived.place_clusters
 WHERE user_id = $1
 ORDER BY last_seen DESC NULLS LAST, visit_count DESC, id ASC
`;

function dateOrNull(value: unknown): Date | null {
  if (value === null || value === undefined) {
    return null;
  }

  return value instanceof Date ? value : new Date(String(value));
}

export function parseClusterRow(row: Record<string, unknown>): PlaceClusterSnapshot {
  return {
    id: String(row.id),
    lat: Number(row.lat),
    lng: Number(row.lng),
    radiusM: Number(row.radius_m),
    label: row.label === null || row.label === undefined ? null : String(row.label),
    visitCount: Number(row.visit_count),
    firstSeen: dateOrNull(row.first_seen),
    lastSeen: dateOrNull(row.last_seen),
  };
}

/**
 * Idempotent cluster upsert. Counts/seen-ranges are SET (recompute-from-window
 * semantics, see PlaceClusterService), except first_seen/last_seen which keep
 * widening so a narrower re-scan never shrinks a cluster's known lifespan.
 * label is never clobbered here (labeling is a separate read-only step).
 * $1 id, $2 user_id, $3 centroid EWKT, $4 radius_m, $5 visit_count,
 * $6 first_seen, $7 last_seen.
 */
export const UPSERT_CLUSTER_SQL = `
INSERT INTO ci_derived.place_clusters
  (id, user_id, centroid, radius_m, visit_count, first_seen, last_seen)
VALUES ($1::uuid, $2::uuid, $3::geography, $4, $5, $6, $7)
ON CONFLICT (id) DO UPDATE SET
  centroid    = EXCLUDED.centroid,
  radius_m    = GREATEST(place_clusters.radius_m, EXCLUDED.radius_m),
  visit_count = EXCLUDED.visit_count,
  first_seen  = LEAST(COALESCE(place_clusters.first_seen, EXCLUDED.first_seen), EXCLUDED.first_seen),
  last_seen   = GREATEST(COALESCE(place_clusters.last_seen, EXCLUDED.last_seen), EXCLUDED.last_seen)
`;

/** $1 cluster id, $2 user_id, $3 label. */
export const SET_CLUSTER_LABEL_SQL = `
UPDATE ci_derived.place_clusters
   SET label = $3
 WHERE id = $1::uuid
   AND user_id = $2::uuid
`;

/**
 * Read-only label lookup against the reverse-geocode rows GeocodeService has
 * already cached (raw_query = 'reverse:<lat4>,<lng4>', label in
 * normalized_address). The coordinate is parsed back out of raw_query — it is
 * always present there, unlike the lat/lng columns — and the nearest cached
 * label within $2 meters of the centroid wins. NO external geocoding calls.
 * $1 centroid EWKT, $2 search radius in meters.
 */
export const REVERSE_GEOCODE_LABEL_SQL = `
SELECT gc.normalized_address AS label
  FROM ci.geocode_cache gc
 CROSS JOIN LATERAL (
   SELECT ST_SetSRID(ST_MakePoint(
            split_part(split_part(gc.raw_query, ':', 2), ',', 2)::double precision,
            split_part(split_part(gc.raw_query, ':', 2), ',', 1)::double precision
          ), 4326)::geography AS point
 ) pt
 WHERE gc.status = 'OK'
   AND gc.raw_query LIKE 'reverse:%'
   AND gc.normalized_address IS NOT NULL
   AND ST_DWithin(pt.point, $1::geography, $2)
 ORDER BY ST_Distance(pt.point, $1::geography) ASC, gc.query_hash ASC
 LIMIT 1
`;
