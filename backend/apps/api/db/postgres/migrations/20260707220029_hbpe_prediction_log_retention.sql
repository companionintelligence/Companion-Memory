-- migrate:up
--
-- Reissued from 20260701000000, which collided with create_search_index_skips
-- (both hand-stamped the same version; dbmate keys schema_migrations on it, so
-- the duplicate broke `migrate` for everyone). DBs that migrated while this file
-- held the old version will run it again — every statement below is guarded
-- (add_retention_policy if_not_exists / remove_retention_policy if_exists), so
-- the re-run is a no-op.
--
-- Bound the growth of the hbpe.prediction_log hypertable.
--
-- prediction_log records 48 rows per issued /histogram forecast, and the
-- forecast is called on every ForecastStrip mount (twice per FeedPage render)
-- and every agent GET /memory/context.  With no TTL the hypertable grows
-- unbounded (hbpe-and-prediction subsystem plan §3 risk #3, §6 success metric
-- "prediction_log size").  A retention policy drops chunks whose data is older
-- than 90 days, which is well beyond the retrospective accuracy-backfill window
-- (Phase 5a joins elapsed-day buckets to observed labels within a few days).
--
-- add_retention_policy is idempotent when if_not_exists => true: re-running the
-- migration is a no-op rather than an error.

SELECT add_retention_policy('hbpe.prediction_log', INTERVAL '90 days', if_not_exists => true);

-- migrate:down

SELECT remove_retention_policy('hbpe.prediction_log', if_exists => true);
