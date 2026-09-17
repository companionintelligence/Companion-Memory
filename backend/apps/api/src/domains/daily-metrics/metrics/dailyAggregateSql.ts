/**
 * The single raw-aggregate query behind DailyMetricsService.computeForDay.
 *
 * It returns ONE row of primitive counts/sums (never a derived metric): the
 * derivation — ratios, means, unit conversions, and coverage — happens in the
 * pure {@link assembleDailyMetrics} so it is deterministic and unit-testable
 * without a database.
 *
 * Parameters: $1 = user_id (uuid), $2 = date (YYYY-MM-DD), $3 = timezone.
 *
 * A "day" is the user's LOCAL calendar day, not a UTC day, and it is expressed
 * as the half-open timestamptz range [local midnight, next local midnight).
 * It used to be written the other way round, as `(<ts> AT TIME ZONE $3)::date
 * = $2` on each row. That predicate is equivalent but NOT sargable: wrapping
 * the indexed `time` column in a function makes every one of the 22 subqueries
 * below fall back to a full scan of its source table. Measured on a
 * 326k-communication / 254k-browser_activity appliance, one call to this
 * statement took 74.7 SECONDS. The half-open form plans as an Index Only Scan
 * on the existing `(user_id, time)` indexes. That is not a micro-optimisation:
 * the caller materializes one day per call, so the old cost put a 180-day
 * backfill at ~3.7 hours and made even the 2-day hourly tick take minutes.
 *
 * The bounds are spelled out inline in all 22 subqueries rather than computed
 * once in a `WITH params` CTE, which is why this reads so repetitively. That is
 * deliberate and was measured, not a style choice. `ci.position` is a
 * TimescaleDB hypertable with 43 chunks on this appliance; bounds the planner
 * can constant-fold let it exclude chunks AT PLAN TIME, while bounds arriving
 * through a CTE scan are only knowable at runtime, so it plans all 43 chunks
 * for each of the four position subqueries. The two position counts alone
 * measured 9,213ms via a CTE and 8.8ms inlined — planning, not execution. If
 * you refactor these predicates back behind a CTE for readability, re-measure
 * `EXPLAIN` PLANNING time on a hypertable before keeping it.
 *
 * The one behavioural difference is at a DST boundary in a zone that shifts at
 * midnight (America/Santiago, Asia/Beirut, and a handful of others): on such a
 * day `d::timestamp AT TIME ZONE tz` has to resolve an ambiguous or
 * non-existent local midnight and picks one side, so a day boundary there can
 * land an hour off. Everywhere else — including every zone that shifts at
 * 02:00/03:00 — the two forms are identical. The trade is deliberate.
 *
 * Every source is counted independently so coverage can distinguish "no rows"
 * from "no value".
 *
 * The three `count(DISTINCT …)` legs were re-checked on 2026-09-15 after
 * `DuplicateDetectStage` lost six hours to TimescaleDB's skip-scan planner
 * rewriting a correlated `count(DISTINCT entity_id)` as a walk over the DISTINCT
 * column's own index. They do not share that exposure: each is bounded ONCE by
 * the `(user_id, time)` range above, not evaluated per row, and the planner
 * never reaches for `communications_thread_idx` — measured for one day (Index
 * Scan, 4 ms), a month (13 ms), a year (Bitmap) and the whole table (Seq Scan +
 * Sort, 82 ms). The whole statement ran in 12 ms on the busiest day of a 202k-
 * communication corpus. Leave them as written.
 */
export const DAILY_AGGREGATE_SQL = `
SELECT
  (SELECT count(*) FROM ci.communications c
     WHERE c.user_id = $1::uuid AND c.time >= ($2::date::timestamp AT TIME ZONE $3::text)
       AND c.time < (($2::date + 1)::timestamp AT TIME ZONE $3::text))
     AS comms_rows,
  (SELECT count(*) FROM ci.communications c
     WHERE c.user_id = $1::uuid AND c.time >= ($2::date::timestamp AT TIME ZONE $3::text)
       AND c.time < (($2::date + 1)::timestamp AT TIME ZONE $3::text)
       AND c.direction = 'outbound')
     AS comms_outbound,
  (SELECT count(DISTINCT c.thread_id) FROM ci.communications c
     WHERE c.user_id = $1::uuid AND c.time >= ($2::date::timestamp AT TIME ZONE $3::text)
       AND c.time < (($2::date + 1)::timestamp AT TIME ZONE $3::text))
     AS comms_threads,
  (SELECT count(*) FROM ci.communications c
     WHERE c.user_id = $1::uuid AND c.time >= ($2::date::timestamp AT TIME ZONE $3::text)
       AND c.time < (($2::date + 1)::timestamp AT TIME ZONE $3::text)
       AND c.thread_id IS NULL)
     AS comms_nullthread_rows,
  (SELECT count(DISTINCT contacts.eid) FROM (
       SELECT c.from_entity_id AS eid FROM ci.communications c
         WHERE c.user_id = $1::uuid AND c.time >= ($2::date::timestamp AT TIME ZONE $3::text)
       AND c.time < (($2::date + 1)::timestamp AT TIME ZONE $3::text)
       UNION ALL
       SELECT unnest(c.to_entity_ids) AS eid FROM ci.communications c
         WHERE c.user_id = $1::uuid AND c.time >= ($2::date::timestamp AT TIME ZONE $3::text)
       AND c.time < (($2::date + 1)::timestamp AT TIME ZONE $3::text)
     ) contacts WHERE contacts.eid IS NOT NULL)
     AS comms_unique_contacts,
  (SELECT sum(c.sentiment_score) FROM ci.communications c
     WHERE c.user_id = $1::uuid AND c.time >= ($2::date::timestamp AT TIME ZONE $3::text)
       AND c.time < (($2::date + 1)::timestamp AT TIME ZONE $3::text))
     AS comms_sentiment_sum,
  (SELECT count(c.sentiment_score) FROM ci.communications c
     WHERE c.user_id = $1::uuid AND c.time >= ($2::date::timestamp AT TIME ZONE $3::text)
       AND c.time < (($2::date + 1)::timestamp AT TIME ZONE $3::text))
     AS comms_sentiment_count,

  (SELECT count(*) FROM ci.position pos
     WHERE pos.user_id = $1::uuid AND pos.time >= ($2::date::timestamp AT TIME ZONE $3::text)
       AND pos.time < (($2::date + 1)::timestamp AT TIME ZONE $3::text))
     AS pos_rows,
  (SELECT count(*) FROM ci.position pos
     WHERE pos.user_id = $1::uuid AND pos.time >= ($2::date::timestamp AT TIME ZONE $3::text)
       AND pos.time < (($2::date + 1)::timestamp AT TIME ZONE $3::text)
       AND pos.location IS NOT NULL)
     AS pos_rows_with_location,
  (SELECT count(*) FROM (
       SELECT DISTINCT
              round(ST_Y(pos.location::geometry)::numeric, 3) AS lat3,
              round(ST_X(pos.location::geometry)::numeric, 3) AS lng3
         FROM ci.position pos
         WHERE pos.user_id = $1::uuid AND pos.time >= ($2::date::timestamp AT TIME ZONE $3::text)
       AND pos.time < (($2::date + 1)::timestamp AT TIME ZONE $3::text)
           AND pos.location IS NOT NULL
     ) cells)
     AS pos_place_cells,
  (SELECT COALESCE(sum(segs.seg), 0) FROM (
       SELECT ST_Distance(
                pos.location::geography,
                lag(pos.location::geography) OVER (ORDER BY pos.time)
              ) / 1000.0 AS seg
         FROM ci.position pos
         WHERE pos.user_id = $1::uuid AND pos.time >= ($2::date::timestamp AT TIME ZONE $3::text)
       AND pos.time < (($2::date + 1)::timestamp AT TIME ZONE $3::text)
           AND pos.location IS NOT NULL
     ) segs WHERE segs.seg IS NOT NULL)
     AS pos_km,

  (SELECT count(*) FROM ci.browser_activity b
     WHERE b.user_id = $1::uuid AND b.time >= ($2::date::timestamp AT TIME ZONE $3::text)
       AND b.time < (($2::date + 1)::timestamp AT TIME ZONE $3::text))
     AS br_rows,
  (SELECT count(b.duration_seconds) FROM ci.browser_activity b
     WHERE b.user_id = $1::uuid AND b.time >= ($2::date::timestamp AT TIME ZONE $3::text)
       AND b.time < (($2::date + 1)::timestamp AT TIME ZONE $3::text))
     AS br_rows_with_duration,
  (SELECT sum(b.duration_seconds) FROM ci.browser_activity b
     WHERE b.user_id = $1::uuid AND b.time >= ($2::date::timestamp AT TIME ZONE $3::text)
       AND b.time < (($2::date + 1)::timestamp AT TIME ZONE $3::text))
     AS br_duration_seconds_sum,
  (SELECT count(DISTINCT lower(substring(b.url from '^[a-zA-Z][a-zA-Z0-9+.-]*://([^/:]+)')))
     FROM ci.browser_activity b
     WHERE b.user_id = $1::uuid AND b.time >= ($2::date::timestamp AT TIME ZONE $3::text)
       AND b.time < (($2::date + 1)::timestamp AT TIME ZONE $3::text)
       AND b.url IS NOT NULL)
     AS br_distinct_domains,

  (SELECT count(*) FROM ci.objects i
     WHERE i.user_id::uuid = $1::uuid AND i.acquired_at >= ($2::date::timestamp AT TIME ZONE $3::text)
       AND i.acquired_at < (($2::date + 1)::timestamp AT TIME ZONE $3::text))
     AS inv_rows,
  (SELECT count(i.purchase_price) FROM ci.objects i
     WHERE i.user_id::uuid = $1::uuid AND i.acquired_at >= ($2::date::timestamp AT TIME ZONE $3::text)
       AND i.acquired_at < (($2::date + 1)::timestamp AT TIME ZONE $3::text))
     AS inv_rows_with_price,
  (SELECT sum(i.purchase_price) FROM ci.objects i
     WHERE i.user_id::uuid = $1::uuid AND i.acquired_at >= ($2::date::timestamp AT TIME ZONE $3::text)
       AND i.acquired_at < (($2::date + 1)::timestamp AT TIME ZONE $3::text))
     AS inv_price_sum,

  (SELECT count(*) FROM ci.events e
     WHERE e.user_id = $1::uuid
       AND e.start_time >= ($2::date::timestamp AT TIME ZONE $3::text)
       AND e.start_time < (($2::date + 1)::timestamp AT TIME ZONE $3::text)
       AND e.event_type IN ('calendar_event', 'meeting', 'appointment', 'event')
       AND COALESCE(e.is_all_day, FALSE) = FALSE
       AND COALESCE(e.status, '') NOT IN ('cancelled', 'canceled')
       AND COALESCE(e.is_deleted, FALSE) = FALSE)
     AS meeting_rows,
  (SELECT COALESCE(sum(e.duration_minutes), 0) FROM ci.events e
     WHERE e.user_id = $1::uuid
       AND e.start_time >= ($2::date::timestamp AT TIME ZONE $3::text)
       AND e.start_time < (($2::date + 1)::timestamp AT TIME ZONE $3::text)
       AND e.event_type IN ('calendar_event', 'meeting', 'appointment', 'event')
       AND COALESCE(e.is_all_day, FALSE) = FALSE
       AND COALESCE(e.status, '') NOT IN ('cancelled', 'canceled')
       AND COALESCE(e.is_deleted, FALSE) = FALSE)
     AS meeting_minutes_sum,

  (SELECT count(*) FROM ci.events e
     WHERE e.user_id = $1::uuid
       AND e.start_time >= ($2::date::timestamp AT TIME ZONE $3::text)
       AND e.start_time < (($2::date + 1)::timestamp AT TIME ZONE $3::text)
       AND e.event_type = 'sleep'
       AND COALESCE(e.is_deleted, FALSE) = FALSE)
     AS sleep_rows,
  (SELECT COALESCE(sum(
            CASE
              WHEN e.metadata->>'Minutes Asleep' ~ '^[0-9]+(\\.[0-9]+)?$'
                THEN (e.metadata->>'Minutes Asleep')::double precision
              ELSE e.duration_minutes
            END
          ), 0) FROM ci.events e
     WHERE e.user_id = $1::uuid
       AND e.start_time >= ($2::date::timestamp AT TIME ZONE $3::text)
       AND e.start_time < (($2::date + 1)::timestamp AT TIME ZONE $3::text)
       AND e.event_type = 'sleep'
       AND COALESCE(e.is_deleted, FALSE) = FALSE)
     AS sleep_minutes_sum
`;

/**
 * The `$4` most recent local days, newest first, on which at least one raw
 * source has a row that {@link DAILY_AGGREGATE_SQL} could turn into a metric.
 *
 * Parameters: $1 = user_id (uuid), $2 = timezone, $3 = the user's local today
 * (YYYY-MM-DD), $4 = limit.
 *
 * This is the positioning query for the daily feature store — see
 * `DailyMetricsService.recentDataDays` for why the store selects days instead
 * of anchoring a contiguous window. Each branch mirrors the corresponding
 * source predicate in DAILY_AGGREGATE_SQL, so the two stay in step:
 *
 *  - communications / browser_activity: any row (both produce count metrics)
 *  - position: `location IS NOT NULL`, since a fix with no point yields no
 *    metric (`assembleDailyMetrics` gates n_places/km_traveled on posLoc > 0)
 *  - objects: `purchase_price IS NOT NULL`, which is what spend_total needs
 *  - events: the meeting whitelist or `'sleep'`, NOT any event. Dropping that
 *    filter is what made a naive MAX() anchor land on 2026-08-30 on the live
 *    corpus: the only rows there are reddit `moderated_subreddit` records with
 *    an import-time `start_time`, which match no metric and would have burned
 *    the whole window on a day that can only ever be NULL.
 *
 * `$3` clamps the result to the user's local today. Without it a future-dated
 * calendar entry — this corpus has them out to 2026-10-15 — would take slots
 * away from days that have already happened. This mirrors the `time <= now()`
 * clamp on `InboxScanService.scanAnchor` (#2483), for the same reason.
 *
 * Unlike DAILY_AGGREGATE_SQL this one deliberately does NOT try to be
 * index-friendly: it is a whole-history DISTINCT and scans by design. It runs
 * once per refresh rather than once per day materialized, and measured 2.5s
 * against 326k communications + 254k browser_activity + 63k position.
 */
export const RECENT_DATA_DAYS_SQL = `
WITH days AS (
      SELECT DISTINCT (c.time AT TIME ZONE $2::text)::date AS day
        FROM ci.communications c
       WHERE c.user_id = $1::uuid
  UNION
      SELECT DISTINCT (b.time AT TIME ZONE $2::text)::date AS day
        FROM ci.browser_activity b
       WHERE b.user_id = $1::uuid
  UNION
      SELECT DISTINCT (pos.time AT TIME ZONE $2::text)::date AS day
        FROM ci.position pos
       WHERE pos.user_id = $1::uuid
         AND pos.location IS NOT NULL
  UNION
      SELECT DISTINCT (i.acquired_at AT TIME ZONE $2::text)::date AS day
        FROM ci.objects i
       WHERE i.user_id::uuid = $1::uuid
         AND i.purchase_price IS NOT NULL
  UNION
      SELECT DISTINCT (e.start_time AT TIME ZONE $2::text)::date AS day
        FROM ci.events e
       WHERE e.user_id = $1::uuid
         AND COALESCE(e.is_deleted, FALSE) = FALSE
         AND (
              (e.event_type IN ('calendar_event', 'meeting', 'appointment', 'event')
               AND COALESCE(e.is_all_day, FALSE) = FALSE
               AND COALESCE(e.status, '') NOT IN ('cancelled', 'canceled'))
              OR e.event_type = 'sleep'
             )
)
SELECT day
  FROM days
 WHERE day IS NOT NULL
   AND day <= $3::date
 ORDER BY day DESC
 LIMIT $4::int
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
  meeting_rows: number;
  meeting_minutes_sum: number | null;
  sleep_rows: number;
  sleep_minutes_sum: number | null;
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
    meeting_rows: num(row.meeting_rows),
    meeting_minutes_sum: numOrNull(row.meeting_minutes_sum),
    sleep_rows: num(row.sleep_rows),
    sleep_minutes_sum: numOrNull(row.sleep_minutes_sum),
  };
}
