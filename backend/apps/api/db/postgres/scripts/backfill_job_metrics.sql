-- Seed ci.job_metrics from the job history pg-boss still holds.
--
-- The collector samples forward from the moment it starts, so a freshly
-- migrated appliance shows empty charts until enough ticks have accumulated.
-- `pgboss.job` still holds up to ~24 hours of terminal jobs with
-- `completed_on` and `started_on` on every row, which is exactly the throughput
-- and latency the collector would have recorded had it been running.
--
-- So: bucket that into the same five-minute grid and write it as history. This
-- is real observed data, not synthetic — the only thing it cannot reconstruct
-- is queue DEPTH, because a gauge leaves no trace once the rows drain. Depth is
-- left at zero for backfilled buckets and starts being recorded for real on the
-- collector's first tick.
--
-- Idempotent (ON CONFLICT DO NOTHING) and safe to re-run.
--
--   yarn dbmate --execute-file ./db/postgres/scripts/backfill_job_metrics.sql

INSERT INTO ci.job_metrics (
    sampled_at, queue, pending, active, retry, dead_lettered,
    completed, failed, avg_duration_ms, p95_duration_ms
)
WITH settled AS (
    SELECT name, state, started_on, completed_on
      FROM pgboss.job
     WHERE completed_on IS NOT NULL
)
SELECT
    -- Snap to the same 5-minute grid the collector writes on, so backfilled and
    -- live samples land in one continuous series rather than two interleaved ones.
    to_timestamp(floor(extract(epoch FROM completed_on) / 300) * 300) AS sampled_at,
    name                                                             AS queue,
    0 AS pending,      -- gauges are unrecoverable after the fact; see the note above
    0 AS active,
    0 AS retry,
    0 AS dead_lettered,
    COUNT(*) FILTER (WHERE state = 'completed')::int                 AS completed,
    COUNT(*) FILTER (WHERE state = 'failed')::int                    AS failed,
    ROUND(
        AVG(EXTRACT(EPOCH FROM (completed_on - started_on)) * 1000)
        FILTER (WHERE started_on IS NOT NULL)
    )::int                                                           AS avg_duration_ms,
    PERCENTILE_DISC(0.95) WITHIN GROUP (
        ORDER BY EXTRACT(EPOCH FROM (completed_on - started_on)) * 1000
    ) FILTER (WHERE started_on IS NOT NULL)::int                     AS p95_duration_ms
  FROM settled
 GROUP BY 1, 2
ON CONFLICT DO NOTHING;
