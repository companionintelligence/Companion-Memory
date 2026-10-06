-- migrate:up

-- Which sync-job rows hold data the sync executor fetched.
--
-- The transform sweep treats a job's `data` as the provider's answer and acts
-- on it: the Facebook transforms, for one, download every media URL in it.
-- `createConnectionSyncJob` and `updateConnectionSyncJob` used to accept
-- `status`, `data` and both cursors from the client, so a caller could write a
-- "successful" job with any payload and have the server act on it. Those
-- fields are gone from the GraphQL inputs, and this flag makes the rule
-- explicit where the sweep reads: only rows `SyncOrchestrator` itself wrote a
-- fetch result into are transformed (`ConnectionSyncJobService.recordFetched`).
--
-- Backfill: the jobs waiting in the transform queue right now (successful and
-- not yet transformed), so an upgrade does not strand a backlog the executor
-- did fetch. They cannot be told apart from a client-written row after the
-- fact. The sweep's other new rule (skip connections that are not active)
-- still applies to them, and so does the Facebook download's host and address
-- check. Transformed rows are never read by the sweep again and are left alone.
ALTER TABLE ci_etl.connection_sync_jobs
    ADD COLUMN IF NOT EXISTS fetched_by_executor BOOLEAN NOT NULL DEFAULT false;

UPDATE ci_etl.connection_sync_jobs
   SET fetched_by_executor = true
 WHERE status = 'success'
   AND last_transformed IS NULL;

COMMENT ON COLUMN ci_etl.connection_sync_jobs.fetched_by_executor IS
  'True when the sync executor stored a fetch result in data. Only such rows are transformed; no client input can set it.';

-- migrate:down

ALTER TABLE ci_etl.connection_sync_jobs DROP COLUMN IF EXISTS fetched_by_executor;
