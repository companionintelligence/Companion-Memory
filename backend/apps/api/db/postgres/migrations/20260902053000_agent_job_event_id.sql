-- migrate:up
-- Link the Memory-owned agent job to the deferred pg-boss row the Jobs page
-- reads. Without this, dispatch completes in one second on `default` and the
-- living job (queued until OpenClaw reports) is invisible on /jobs.

ALTER TABLE ci.agent_jobs
    ADD COLUMN IF NOT EXISTS event_job_id uuid;

CREATE INDEX IF NOT EXISTS agent_jobs_event_job_idx
    ON ci.agent_jobs (event_job_id)
    WHERE event_job_id IS NOT NULL;

-- migrate:down
DROP INDEX IF EXISTS ci.agent_jobs_event_job_idx;
ALTER TABLE ci.agent_jobs DROP COLUMN IF EXISTS event_job_id;
