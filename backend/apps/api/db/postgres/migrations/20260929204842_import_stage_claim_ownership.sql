-- migrate:up

-- WHO holds a running import stage, so a stage whose worker is gone can be
-- handed back to pg-boss and retried in a few minutes — safely, even when the
-- worker was only slow.
--
-- Until now a claim was one bit — `status = 'running'` — plus the heartbeat on
-- `updated_at`. That was enough to notice silence after ten minutes, but not to
-- act on it sooner, or precisely:
--
--  - Nothing recorded WHICH pg-boss job held the claim, so recovery could not
--    hand the orphaned job back to pg-boss. It re-enqueued a fresh job instead
--    (at the BACK of the kind's queue, behind every run that queued since) and
--    left the dead worker's job `active` until `IMPORT_STAGE_EXPIRE_SECONDS`
--    expired it: 12 hours of a phantom job on the Jobs page, whose retry then
--    no-ops. Reproduced on a full-corpus inbox import after a worker restart
--    mid-parse, which took twelve minutes to recover.
--  - Nothing distinguished one claim from the next, so a worker that was only
--    SLOW and lost its stage to recovery could keep writing progress into the
--    new attempt's row, and complete and advance the run behind it.
--
-- `claim_token` is a fencing token: minted per claim, cleared when the claim
-- ends, and every write a worker makes on the stage's behalf is conditioned on
-- it. `claim_job_id` / `claim_queue` name the pg-boss delivery that made the
-- claim — the queue as well as the id, because `pgboss.job` is partitioned by
-- queue name and `fail()` needs both. They are NULL for in-process runs
-- (BlueBubbles), which never go through pg-boss, and for claims made before
-- this migration; both keep the ten-minute recovery they had.
ALTER TABLE ci_import.import_stages
    ADD COLUMN IF NOT EXISTS claim_token  UUID,
    ADD COLUMN IF NOT EXISTS claim_job_id UUID,
    ADD COLUMN IF NOT EXISTS claim_queue  TEXT;

COMMENT ON COLUMN ci_import.import_stages.claim_token IS
  'Fencing token of the claim currently running this stage, or NULL. Minted by ImportRunService.claimStage; a worker''s heartbeat, progress, completion and failure writes only land while it still matches, so a worker whose stage was reclaimed cannot write into the retry.';
COMMENT ON COLUMN ci_import.import_stages.claim_job_id IS
  'The pg-boss job whose delivery holds the claim. NULL for in-process runs and pre-claim-ownership rows. What the orphan reaper fails (so pg-boss applies its own retry/dead-letter policy) when the stage stops heartbeating.';
COMMENT ON COLUMN ci_import.import_stages.claim_queue IS
  'The queue claim_job_id lives on. Needed alongside the id: pgboss.job is partitioned by queue name.';

-- The orphan reaper runs every minute and asks one question: which RUNNING
-- stages have gone quiet? Running stages are a handful (one per stage slot);
-- the table holds every stage of every run in history. Partial, so the index
-- holds only the rows the question is about.
CREATE INDEX IF NOT EXISTS import_stages_running_heartbeat_idx
    ON ci_import.import_stages (updated_at)
    WHERE status = 'running';

-- migrate:down

DROP INDEX IF EXISTS ci_import.import_stages_running_heartbeat_idx;

ALTER TABLE ci_import.import_stages
    DROP COLUMN IF EXISTS claim_queue,
    DROP COLUMN IF EXISTS claim_job_id,
    DROP COLUMN IF EXISTS claim_token;
