-- migrate:up
-- Atomic claim for the transform step. `lastTransformed` alone only marks
-- COMPLETION, so it cannot gate concurrent starts: a transform still running
-- past the next orchestration tick was re-enqueued and re-run alongside
-- itself. `transform_claimed_at` is set by a single `UPDATE ... WHERE
-- transform_claimed_at IS NULL RETURNING id`, so only one concurrent claim
-- can win; a stale claim (crash mid-transform) is retried after an hour, the
-- same staleness window SyncOrchestrator already uses for stalled sync jobs.
ALTER TABLE ci_etl.connection_sync_jobs ADD COLUMN transform_claimed_at TIMESTAMPTZ;

-- migrate:down
ALTER TABLE ci_etl.connection_sync_jobs DROP COLUMN transform_claimed_at;

