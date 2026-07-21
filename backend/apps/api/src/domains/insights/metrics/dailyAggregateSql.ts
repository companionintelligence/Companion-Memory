/**
 * The single raw-aggregate query behind DailyMetricsService.computeForDay.
 *
 * It returns ONE row of primitive counts/sums (never a derived metric): the
 * derivation — ratios, means, unit conversions, and coverage — happens in the
 * pure {@link assembleDailyMetrics} so it is deterministic and unit-testable
 * without a database.
 *
 * Parameters: $1 = user_id (uuid), $2 = date (YYYY-MM-DD), $3 = timezone.
 * Day bucketing uses `(<ts> AT TIME ZONE $3)::date = $2` so a "day" is the
 * user's local calendar day, not a UTC day. Every source is counted
 * independently so coverage can distinguish "no rows" from "no value".
 */
export const DAILY_AGGREGATE_SQL = `
WITH params AS (
  SELECT $1::uuid AS user_id, $2::date AS d, $3::text AS tz
)
SELECT
  (SELECT count(*) FROM ci.communications c, params p
     WHERE c.user_id = p.user_id AND (c.time AT TIME ZONE p.tz)::date = p.d)
     AS comms_rows,
  (SELECT count(*) FROM ci.communications c, params p
     WHERE c.user_id = p.user_id AND (c.time AT TIME ZONE p.tz)::date = p.d
       AND c.direction = 'outbound')
     AS comms_outbound,
  (SELECT count(DISTINCT c.thread_id) FROM ci.communications c, params p
     WHERE c.user_id = p.user_id AND (c.time AT TIME ZONE p.tz)::date = p.d)
     AS comms_threads,
  (SELECT count(*) FROM ci.communications c, params p
     WHERE c.user_id = p.user_id AND (c.time AT TIME ZONE p.tz)::date = p.d
       AND c.thread_id IS NULL)
     AS comms_nullthread_rows,
  (SELECT count(DISTINCT contacts.eid) FROM (
       SELECT c.from_entity_id AS eid FROM ci.communications c, params p
         WHERE c.user_id = p.user_id AND (c.time AT TIME ZONE p.tz)::date = p.d
       UNION ALL
       SELECT unnest(c.to_entity_ids) AS eid FROM ci.communications c, params p
         WHERE c.user_id = p.user_id AND (c.time AT TIME ZONE p.tz)::date = p.d
     ) contacts WHERE contacts.eid IS NOT NULL)
     AS comms_unique_contacts,
  (SELECT sum(c.sentiment_score) FROM ci.communications c, params p
     WHERE c.user_id = p.user_id AND (c.time AT TIME ZONE p.tz)::date = p.d)
     AS comms_sentiment_sum,
  (SELECT count(c.sentiment_score) FROM ci.communications c, params p
     WHERE c.user_id = p.user_id AND (c.time AT TIME ZONE p.tz)::date = p.d)
     AS comms_sentiment_count,

  (SELECT count(*) FROM ci.position pos, params p
     WHERE pos.user_id = p.user_id AND (pos.time AT TIME ZONE p.tz)::date = p.d)
     AS pos_rows,
  (SELECT count(*) FROM ci.position pos, params p
     WHERE pos.user_id = p.user_id AND (pos.time AT TIME ZONE p.tz)::date = p.d
       AND pos.location IS NOT NULL)
     AS pos_rows_with_location,
  (SELECT count(*) FROM (
       SELECT DISTINCT
              round(ST_Y(pos.location::geometry)::numeric, 3) AS lat3,
              round(ST_X(pos.location::geometry)::numeric, 3) AS lng3
         FROM ci.position pos, params p
         WHERE pos.user_id = p.user_id AND (pos.time AT TIME ZONE p.tz)::date = p.d
           AND pos.location IS NOT NULL
     ) cells)
     AS pos_place_cells,
  (SELECT COALESCE(sum(segs.seg), 0) FROM (
       SELECT ST_Distance(
                pos.location::geography,
                lag(pos.location::geography) OVER (ORDER BY pos.time)
              ) / 1000.0 AS seg
         FROM ci.position pos, params p
         WHERE pos.user_id = p.user_id AND (pos.time AT TIME ZONE p.tz)::date = p.d
           AND pos.location IS NOT NULL
     ) segs WHERE segs.seg IS NOT NULL)
     AS pos_km,

  (SELECT count(*) FROM ci.browser_activity b, params p
     WHERE b.user_id = p.user_id AND (b.time AT TIME ZONE p.tz)::date = p.d)
     AS br_rows,
  (SELECT count(b.duration_seconds) FROM ci.browser_activity b, params p
     WHERE b.user_id = p.user_id AND (b.time AT TIME ZONE p.tz)::date = p.d)
     AS br_rows_with_duration,
  (SELECT sum(b.duration_seconds) FROM ci.browser_activity b, params p
     WHERE b.user_id = p.user_id AND (b.time AT TIME ZONE p.tz)::date = p.d)
     AS br_duration_seconds_sum,
  (SELECT count(DISTINCT lower(substring(b.url from '^[a-zA-Z][a-zA-Z0-9+.-]*://([^/:]+)')))
     FROM ci.browser_activity b, params p
     WHERE b.user_id = p.user_id AND (b.time AT TIME ZONE p.tz)::date = p.d
       AND b.url IS NOT NULL)
     AS br_distinct_domains,

  (SELECT count(*) FROM ci.inventory i, params p
     WHERE i.user_id = p.user_id AND (i.acquired_at AT TIME ZONE p.tz)::date = p.d)
     AS inv_rows,
  (SELECT count(i.purchase_price) FROM ci.inventory i, params p
     WHERE i.user_id = p.user_id AND (i.acquired_at AT TIME ZONE p.tz)::date = p.d)
     AS inv_rows_with_price,
  (SELECT sum(i.purchase_price) FROM ci.inventory i, params p
     WHERE i.user_id = p.user_id AND (i.acquired_at AT TIME ZONE p.tz)::date = p.d)
     AS inv_price_sum
`;

/** One row of primitive per-day counts/sums returned by {@link DAILY_AGGREGATE_SQL}. */
export interface RawDailyAggregates {
  comms_rows: number;
  comms_outbound: number;
  comms_threads: number;
  comms_nullthread_rows: number;
  comms_unique_contacts: number;
  comms_sentiment_sum: number | null;
  comms_sentiment_count: number;
  pos_rows: number;
  pos_rows_with_location: number;
  pos_place_cells: number;
  pos_km: number | null;
  br_rows: number;
  br_rows_with_duration: number;
  br_duration_seconds_sum: number | null;
  br_distinct_domains: number;
  inv_rows: number;
  inv_rows_with_price: number;
  inv_price_sum: number | null;
}

function num(value: unknown): number {
  if (value === null || value === undefined) {
    return 0;
  }

  const n = typeof value === 'number' ? value : Number(value);

  return Number.isFinite(n) ? n : 0;
}

function numOrNull(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }

  const n = typeof value === 'number' ? value : Number(value);

  return Number.isFinite(n) ? n : null;
}

/**
 * Coerce a raw pg row (bigint counts and numeric sums arrive as strings) into a
 * fully-numeric {@link RawDailyAggregates}. Missing keys default to 0 / null.
 */
export function parseAggregateRow(row: Record<string, unknown>): RawDailyAggregates {
  return {
    comms_rows: num(row.comms_rows),
    comms_outbound: num(row.comms_outbound),
    comms_threads: num(row.comms_threads),
    comms_nullthread_rows: num(row.comms_nullthread_rows),
    comms_unique_contacts: num(row.comms_unique_contacts),
    comms_sentiment_sum: numOrNull(row.comms_sentiment_sum),
    comms_sentiment_count: num(row.comms_sentiment_count),
    pos_rows: num(row.pos_rows),
    pos_rows_with_location: num(row.pos_rows_with_location),
    pos_place_cells: num(row.pos_place_cells),
    pos_km: numOrNull(row.pos_km),
    br_rows: num(row.br_rows),
    br_rows_with_duration: num(row.br_rows_with_duration),
    br_duration_seconds_sum: numOrNull(row.br_duration_seconds_sum),
    br_distinct_domains: num(row.br_distinct_domains),
    inv_rows: num(row.inv_rows),
    inv_rows_with_price: num(row.inv_rows_with_price),
    inv_price_sum: numOrNull(row.inv_price_sum),
  };
}
