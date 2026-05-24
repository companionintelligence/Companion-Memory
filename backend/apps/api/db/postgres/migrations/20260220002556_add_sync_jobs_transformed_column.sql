-- migrate:up
ALTER TABLE ci_etl.connection_sync_jobs ADD COLUMN last_transformed TIMESTAMPTZ;

-- migrate:down
ALTER TABLE ci_etl.connection_sync_jobs DROP COLUMN last_transformed;
